import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, GatewayError, LanpostGateway } from '../src/gateway.ts'

// 假 transport：只记录发出去的帧、把 open/message/close/error 手工投给网关。
// 测试绝不碰真实网络；所有 gateway 在 afterEach 里 stop()，清掉定时器与 pending。
interface FakeTransport {
  sent: string[]
  transport: {
    send(data: string): void
    close(): void
    on(event: string, handler: (arg: any) => void): void
  }
  emit(event: string, arg?: unknown): void
}

function fakeTransport(): FakeTransport {
  const sent: string[] = []
  const handlers = new Map<string, (arg: any) => void>()
  return {
    sent,
    transport: {
      send: (data: string) => sent.push(data),
      close: () => handlers.get('close')?.({ code: 1000 }),
      on: (event: string, handler: (arg: any) => void) => handlers.set(event, handler),
    },
    emit: (event: string, arg?: unknown) => handlers.get(event)?.(arg),
  }
}

/** 统计 `open` 监听注册次数，用来判断是否真的重新建连。 */
function countingTransport(): { f: FakeTransport; connects: () => number } {
  const f = fakeTransport()
  let connects = 0
  const on = f.transport.on
  f.transport.on = (event: string, handler: (arg: any) => void) => {
    if (event === 'open') connects += 1
    on(event, handler)
  }
  return { f, connects: () => connects }
}

const running: LanpostGateway[] = []
afterEach(() => {
  while (running.length > 0) running.pop()!.stop()
})

function makeGateway(
  f: FakeTransport,
  options: {
    lastSequence?: number
    events?: Record<string, unknown>
    reconnectBaseMs?: number
  } = {},
): LanpostGateway {
  const gw = new LanpostGateway({
    url: 'wss://x/ws',
    token: 'tok',
    lastSequence: options.lastSequence ?? 0,
    events: options.events ?? {},
    reconnectBaseMs: options.reconnectBaseMs,
    transport: f.transport,
  } as any)
  running.push(gw)
  return gw
}

const frames = (f: FakeTransport): any[] => f.sent.map((line) => JSON.parse(line))
const methods = (f: FakeTransport): string[] => frames(f).map((frame) => frame.method)
const ackFrames = (f: FakeTransport): any[] => frames(f).filter((frame) => frame.method === 'events.ack')
const ackSeqs = (f: FakeTransport): number[] => ackFrames(f).map((frame) => frame.params.sequence)
const resumeFrames = (f: FakeTransport): any[] => frames(f).filter((frame) => frame.method === 'events.resume')

function lastRequest(f: FakeTransport): any {
  for (let index = frames(f).length - 1; index >= 0; index -= 1) {
    const frame = frames(f)[index]
    if (frame.id !== undefined) return frame
  }
  throw new Error('no request frame sent')
}

function requestFrame(f: FakeTransport, method: string): any {
  const matched = frames(f).filter((frame) => frame.method === method && frame.id !== undefined)
  const found = matched[matched.length - 1]
  if (found === undefined) throw new Error(`no request frame for ${method}`)
  return found
}

function reply(f: FakeTransport, result: unknown): void {
  const request = lastRequest(f)
  f.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
}

function replyTo(f: FakeTransport, method: string, result: unknown): void {
  const request = requestFrame(f, method)
  f.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
}

function replyErrorTo(
  f: FakeTransport,
  method: string,
  error: { code: number; message: string; data?: unknown },
): void {
  const request = requestFrame(f, method)
  f.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, error }))
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 确认「当前在途的 ACK」：回 {acked:true} 并让微任务跑完。 */
async function ackOk(f: FakeTransport): Promise<void> {
  replyTo(f, 'events.ack', { acked: true })
  await settle()
}

/** 串行握手：open 只发 login，确认后才 subscribe，再 resume。 */
async function handshake(
  f: FakeTransport,
  resumeResult: unknown = { latest_sequence: 0, events: [] },
): Promise<void> {
  f.emit('open')
  await settle()
  replyTo(f, 'rpc.login', true)
  await settle()
  replyTo(f, 'subscribe', true)
  await settle()
  replyTo(f, 'events.resume', resumeResult)
  await settle()
}

function notify(f: FakeTransport, method: string, params: Record<string, unknown>): void {
  f.emit('message', JSON.stringify({ jsonrpc: '2.0', method, params }))
}

test('连接后串行握手：login 确认后才 subscribe，再 resume', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f, { lastSequence: 7 })
  gw.start()
  f.emit('open')
  assert.deepEqual(methods(f), ['rpc.login'])
  assert.deepEqual(frames(f)[0].params, { token: 'tok' })

  replyTo(f, 'rpc.login', true)
  await settle()
  assert.deepEqual(methods(f), ['rpc.login', 'subscribe'])
  assert.deepEqual(frames(f)[1].params, ['message.received', 'message.deliveryStatus'])

  replyTo(f, 'subscribe', true)
  await settle()
  assert.deepEqual(methods(f), ['rpc.login', 'subscribe', 'events.resume'])
  assert.deepEqual(frames(f)[2].params, { last_sequence: 7 })
})

test('login 仅接受严格 true：返回 false 报令牌错误且不订阅', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')
  await settle()
  replyTo(f, 'rpc.login', false)
  await settle()
  assert.equal(gw.status().state, 'error')
  assert.match(gw.status().error!, /令牌/)
  assert.deepEqual(methods(f), ['rpc.login'])
})

test('ACK 确认后才推进，严格按 sequence 递增，乱序先不发', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')
  gw.noteEvent(3)
  gw.noteEvent(1)
  await settle()
  assert.deepEqual(ackSeqs(f), [1])

  await ackOk(f)
  // 2 还没收到：只推进到 1，不能跳到 3
  assert.deepEqual(ackSeqs(f), [1])

  gw.noteEvent(2)
  await settle()
  assert.deepEqual(ackSeqs(f), [1, 2])
  await ackOk(f)
  assert.deepEqual(ackSeqs(f), [1, 2, 3])
})

test('重复 sequence 不重复 ACK，旧序号直接忽略', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')
  gw.noteEvent(1)
  gw.noteEvent(1)
  await settle()
  await ackOk(f)

  gw.noteEvent(2)
  gw.noteEvent(2)
  await settle()
  await ackOk(f)

  gw.noteEvent(1)
  gw.noteEvent(2)
  await settle()
  assert.deepEqual(ackSeqs(f), [1, 2])
})

test('收到 message.received 通知转为 InboundMessage 交给 events.onMessage 并 ACK', async () => {
  const f = fakeTransport()
  const got: any[] = []
  const gw = makeGateway(f, { events: { onMessage: (event: unknown) => got.push(event) } })
  gw.start()
  f.emit('open')
  notify(f, 'message.received', {
    event_id: 'evt_1',
    sequence: 1,
    method: 'message.received',
    data: {
      message_id: 'm1',
      conversation_id: 'direct:p1',
      conversation_type: 'private',
      group_id: null,
      sender: { protocol_id: 'p1', username: 'zhangsan', display_name: '张三' },
      content: { type: 'text', text: '你好' },
      timestamp: '2026-11-26T02:00:00Z',
    },
  })
  await settle()
  assert.equal(got.length, 1)
  assert.equal(got[0].eventId, 'evt_1')
  assert.equal(got[0].sequence, 1)
  assert.equal(got[0].messageId, 'm1')
  assert.equal(got[0].conversationType, 'private')
  assert.equal(got[0].sender.displayName, '张三')
  assert.deepEqual(got[0].content, { type: 'text', text: '你好' })
  // 处理完成才 ACK，且带上登记过的 event_id
  assert.deepEqual(ackFrames(f).map((frame) => frame.params), [{ event_id: 'evt_1', sequence: 1 }])
})

test('message.received 的图片内容转为 image 形态', async () => {
  const f = fakeTransport()
  const got: any[] = []
  const gw = makeGateway(f, { events: { onMessage: (event: unknown) => got.push(event) } })
  gw.start()
  f.emit('open')
  notify(f, 'message.received', {
    event_id: 'evt_img',
    sequence: 1,
    data: {
      message_id: 'm2',
      conversation_type: 'group',
      group_id: '998877',
      sender: { protocol_id: 'p2', username: 'lisi' },
      content: { type: 'image', mime_type: 'image/png', name: '截图.png', attachment_id: 'att_1' },
      timestamp: '2026-11-26T02:00:01Z',
    },
  })
  await settle()
  assert.equal(got.length, 1)
  assert.equal(got[0].conversationType, 'group')
  assert.equal(got[0].groupId, '998877')
  assert.deepEqual(got[0].content, { type: 'image', mimeType: 'image/png', name: '截图.png' })
})

test('message.deliveryStatus 通知交给 events.onDelivery', async () => {
  const f = fakeTransport()
  const got: any[] = []
  const gw = makeGateway(f, { events: { onDelivery: (status: unknown) => got.push(status) } })
  gw.start()
  f.emit('open')
  notify(f, 'message.deliveryStatus', {
    event_id: 'evt_2',
    sequence: 1,
    data: {
      message_id: 'im:123',
      conversation_id: 'direct:p1',
      status: 'failed',
      reason: '群成员都不在线',
      timestamp: '2026-11-26T02:00:05Z',
    },
  })
  await settle()
  assert.deepEqual(got, [{ messageId: 'im:123', status: 'failed', reason: '群成员都不在线' }])
})

test('async onMessage 处理完成后才 ACK', async () => {
  const f = fakeTransport()
  const order: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const gw = makeGateway(f, {
    events: {
      onMessage: async () => {
        order.push('start')
        await gate
        order.push('end')
      },
    },
  })
  gw.start()
  f.emit('open')
  notify(f, 'message.received', {
    event_id: 'evt_async',
    sequence: 1,
    data: { message_id: 'm1', sender: { protocol_id: 'p1' }, content: { type: 'text', text: 'x' } },
  })
  await settle()
  await settle()
  assert.deepEqual(order, ['start'])
  assert.deepEqual(ackSeqs(f), [])

  release()
  await settle()
  await settle()
  assert.deepEqual(order, ['start', 'end'])
  assert.deepEqual(ackSeqs(f), [1])
})

test('events.resume 返回的事件按顺序分发，ACK 逐条确认后前进', async () => {
  const f = fakeTransport()
  const got: any[] = []
  const acked: number[] = []
  const gw = makeGateway(f, {
    events: { onMessage: (event: unknown) => got.push(event), onAck: (sequence: number) => acked.push(sequence) },
    lastSequence: 4,
  })
  gw.start()
  await handshake(f, {
    latest_sequence: 6,
    events: [
      {
        event_id: 'evt_5',
        sequence: 5,
        method: 'message.received',
        data: {
          message_id: 'm5',
          conversation_type: 'private',
          sender: { protocol_id: 'p1', username: 'zhangsan' },
          content: { type: 'text', text: '补发 5' },
          timestamp: '2026-11-26T02:00:00Z',
        },
      },
      {
        event_id: 'evt_6',
        sequence: 6,
        method: 'message.received',
        data: {
          message_id: 'm6',
          conversation_type: 'private',
          sender: { protocol_id: 'p1', username: 'zhangsan' },
          content: { type: 'text', text: '补发 6' },
          timestamp: '2026-11-26T02:00:01Z',
        },
      },
    ],
  })
  await settle()
  assert.equal(gw.status().state, 'connected')
  assert.deepEqual(got.map((event) => event.messageId), ['m5', 'm6'])
  assert.deepEqual(ackSeqs(f), [5])
  await ackOk(f)
  await ackOk(f)
  assert.deepEqual(ackSeqs(f), [5, 6])
  assert.deepEqual(acked, [5, 6])
})

test('4401 停止重连：状态 error 且不再建连', async () => {
  const { f, connects } = countingTransport()
  const gw = makeGateway(f, { reconnectBaseMs: 10 })
  gw.start()
  f.emit('open')
  f.emit('close', { code: 4401 })
  assert.equal(gw.status().state, 'error')
  assert.match(gw.status().error!, /令牌/)
  await sleep(120)
  assert.equal(connects(), 1)
  assert.equal(gw.status().state, 'error')
})

test('4409 报连接数超限并从更大退避档重连', async () => {
  const { f, connects } = countingTransport()
  const gw = makeGateway(f, { reconnectBaseMs: 10 })
  gw.start()
  f.emit('open')
  f.emit('close', { code: 4409 })
  assert.equal(gw.status().state, 'error')
  assert.match(gw.status().error!, /连接数超限/)
  // 10ms * 2^3 = 80ms（±20%），等 200ms 足以看到第二次建连
  await sleep(200)
  assert.equal(connects(), 2)
})

test('call 超时拒绝', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')
  await assert.rejects(gw.call('users.list', {}, 10), /timeout|超时/)
})

test('call 按 id 归位，成功返回 result，错误转 GatewayError', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')

  const ok = gw.call<{ total: number }>('users.list', { keyword: '张' }, 1_000)
  reply(f, { total: 1, users: [] })
  assert.deepEqual(await ok, { total: 1, users: [] })

  const bad = gw.call('message.sendUser', { protocol_id: 'nope' }, 1_000)
  replyErrorTo(f, 'message.sendUser', { code: -32011, message: 'USER_NOT_FOUND' })
  await assert.rejects(
    bad,
    (error: unknown) => error instanceof GatewayError && error.code === -32011,
  )
})

test('stop 会 reject 未完成的 call 并清掉后续调用', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')
  const pending = gw.call('users.list', {}, 10_000)
  gw.stop()
  await assert.rejects(pending, /连接已关闭/)
  await assert.rejects(gw.call('users.list', {}, 10_000), /连接已关闭/)
})

test('-32020 在本次握手里重置为 0 并再 resume 一次，事件被分发', async () => {
  const f = fakeTransport()
  const got: any[] = []
  const gw = makeGateway(f, { lastSequence: 7, events: { onMessage: (event: unknown) => got.push(event) } })
  gw.start()
  f.emit('open')
  await settle()
  replyTo(f, 'rpc.login', true)
  await settle()
  replyTo(f, 'subscribe', true)
  await settle()
  replyErrorTo(f, 'events.resume', { code: -32020, message: 'EVENT_CURSOR_EXPIRED' })
  await settle()

  const resumes = resumeFrames(f)
  assert.equal(resumes.length, 2)
  assert.equal(resumes[1].params.last_sequence, 0)

  replyTo(f, 'events.resume', {
    latest_sequence: 1,
    events: [
      {
        event_id: 'evt_1',
        sequence: 1,
        method: 'message.received',
        data: {
          message_id: 'm1',
          conversation_type: 'private',
          sender: { protocol_id: 'p1', username: 'zhangsan' },
          content: { type: 'text', text: '重置后补发' },
          timestamp: '2026-11-26T02:00:00Z',
        },
      },
    ],
  })
  await settle()
  assert.equal(gw.status().state, 'connected')
  assert.match(gw.status().notice!, /游标|重置/)
  assert.match(gw.status().notice!, /可能缺历史事件/)
  assert.deepEqual(got.map((message) => message.messageId), ['m1'])
  assert.deepEqual(ackSeqs(f), [1])
})

test('resume 的 latest_sequence 小于本地游标时同连接重置并重 resume', async () => {
  const f = fakeTransport()
  const acked: number[] = []
  const gw = makeGateway(f, { lastSequence: 9, events: { onAck: (sequence: number) => acked.push(sequence) } })
  gw.start()
  await handshake(f, { latest_sequence: 3, events: [] })
  const resumes = resumeFrames(f)
  assert.equal(resumes.length, 2)
  assert.equal(resumes[1].params.last_sequence, 0)

  replyTo(f, 'events.resume', { latest_sequence: 3, events: [] })
  await settle()
  assert.equal(gw.status().state, 'connected')
  assert.match(gw.status().notice!, /游标|重置/)
  assert.deepEqual(acked, [3])
})

test('resume 返回空 events 时把游标推进到 latest_sequence', async () => {
  const f = fakeTransport()
  const acked: number[] = []
  const gw = makeGateway(f, { lastSequence: 4, events: { onAck: (sequence: number) => acked.push(sequence) } })
  gw.start()
  await handshake(f, { latest_sequence: 7, events: [] })
  assert.equal(gw.status().state, 'connected')
  assert.deepEqual(acked, [7])

  gw.stop()
  gw.start()
  await handshake(f, { latest_sequence: 7, events: [] })
  assert.equal(resumeFrames(f).at(-1).params.last_sequence, 7)
})

test('ACK 失败不推进 lastAcked，重连先补发 ACK 再 resume(lastAcked)', async () => {
  const f = fakeTransport()
  const acked: number[] = []
  const gw = makeGateway(f, { lastSequence: 2, events: { onAck: (sequence: number) => acked.push(sequence) } })
  gw.start()
  await handshake(f, { latest_sequence: 2, events: [] })

  gw.noteEvent(3, 'evt_3')
  await settle()
  assert.deepEqual(ackSeqs(f), [3])
  replyTo(f, 'events.ack', { acked: false })
  await settle()
  assert.deepEqual(acked, [])

  const resumesBefore = resumeFrames(f).length
  gw.stop()
  gw.start()
  f.emit('open')
  await settle()
  replyTo(f, 'rpc.login', true)
  await settle()
  replyTo(f, 'subscribe', true)
  await settle()

  const ackFramesNow = ackFrames(f)
  assert.equal(ackFramesNow.length, 2)
  assert.deepEqual(ackFramesNow[1].params, { event_id: 'evt_3', sequence: 3 })
  assert.equal(resumeFrames(f).length, resumesBefore)

  replyTo(f, 'events.ack', { acked: true })
  await settle()
  assert.deepEqual(acked, [3])
  assert.equal(resumeFrames(f).at(-1).params.last_sequence, 3)
  replyTo(f, 'events.resume', { latest_sequence: 3, events: [] })
  await settle()
  assert.equal(gw.status().state, 'connected')
})

test('文本超过 16 KiB 在客户端侧拒绝，不发帧', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')
  const tooLong = 'a'.repeat(16 * 1024 + 1)
  await assert.rejects(gw.sendUser('p1', tooLong), /16 KiB/)
  await assert.rejects(gw.sendGroup('998877', tooLong), /16 KiB/)
  assert.equal(methods(f).filter((method) => method.startsWith('message.send')).length, 0)
})

test('sendUser / sendGroup 的参数形状与返回值', async () => {
  const f = fakeTransport()
  const gw = makeGateway(f)
  gw.start()
  f.emit('open')

  const userSend = gw.sendUser('p1', '你好')
  const userFrame = lastRequest(f)
  assert.equal(userFrame.method, 'message.sendUser')
  assert.equal(userFrame.params.protocol_id, 'p1')
  assert.deepEqual(userFrame.params.content, { type: 'text', text: '你好' })
  assert.match(userFrame.params.request_id, /^[0-9a-f-]{36}$/)
  reply(f, { message_id: 'im:1', accepted: true, delivery_status: 'queued' })
  assert.deepEqual(await userSend, { message_id: 'im:1', delivery_status: 'queued' })

  const groupSend = gw.sendGroup('998877', '大家好')
  const groupFrame = lastRequest(f)
  assert.equal(groupFrame.method, 'message.sendGroup')
  assert.equal(groupFrame.params.group_id, '998877')
  assert.deepEqual(groupFrame.params.content, { type: 'text', text: '大家好' })
  reply(f, { message_id: 'im:2', accepted: true, delivery_status: 'queued' })
  assert.deepEqual(await groupSend, { message_id: 'im:2', delivery_status: 'queued' })
})

test('退避序列 1s 起翻倍、30s 封顶、抖动不越界', () => {
  const half = (): number => 0.5
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, 1_000, 30_000, half)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  )
  assert.equal(backoffDelay(9, 1_000, 30_000, () => 0), 24_000)
  assert.equal(backoffDelay(9, 1_000, 30_000, () => 1), 30_000)
  // 4409 用第 3 档起步：小基数便于测试验证
  assert.equal(backoffDelay(3, 10, 30_000, half), 80)
})

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { InboundBridge } from '../src/bridge.ts'
import type { InboundMessage } from '../src/gateway.ts'
import { DEFAULTS } from '../src/store.ts'

// 入站桥测试全部使用假 deps：不连网、不落盘、不碰 DSH ctx。
// 每个用例结束 dispose 掉 bridge，确保队列/订阅/定时器不残留。
const running: InboundBridge[] = []
afterEach(() => {
  while (running.length > 0) running.pop()!.dispose()
})

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup(overrides: any = {}) {
  const state: any = {
    ...DEFAULTS,
    enabled: true,
    seenEventIds: [],
    sessions: {},
    ...overrides.state,
  }
  const prompts: any[] = []
  const created: any[] = []
  const sent: any[] = []
  const renames: any[] = []
  const logs: string[] = []
  const audits: any[] = []
  const deps: any = {
    state: () => state,
    update: (mutate: (s: any) => void) => mutate(state),
    sessions: {
      create: async (req: any) => {
        created.push(req)
        return { sessionId: 'sess-' + created.length }
      },
      prompt: async (req: any) => {
        prompts.push(req)
        return { accepted: true }
      },
      rename: async (req: any) => {
        renames.push(req)
        return {}
      },
    },
    send: async (target: any, text: string) => {
      sent.push({ target, text })
      return { message_id: 'm', delivery_status: 'queued' }
    },
    onSessionEvent: () => () => {},
    log: (message: string) => logs.push(message),
    audit: (kind: string, detail: any) => audits.push({ kind, detail }),
    ...overrides.deps,
  }
  const bridge = new InboundBridge(deps)
  running.push(bridge)
  return { bridge, prompts, created, sent, renames, logs, audits, state }
}

const msg = (data: Partial<any> = {}): InboundMessage => ({
  eventId: 'evt_1',
  sequence: 1,
  messageId: 'm1',
  conversationId: 'direct:p1',
  conversationType: 'private',
  sender: { protocolId: 'p1', username: 'zhangsan', displayName: '张三' },
  content: { type: 'text', text: '你好' },
  timestamp: '2026-11-26T02:00:00Z',
  ...data,
})

test('私聊文本：建会话并投递带来源说明的 prompt', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg())
  assert.equal(s.created.length, 1)
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].sessionId, 'sess-1')
  assert.equal(s.prompts[0].mode, 'queue')
  assert.equal(s.prompts[0].content[0].text, '[lanpost 私聊 · 张三 (zhangsan)]\n\n你好')
  assert.match(s.prompts[0].requestId, /^lanpost-/)
  assert.deepEqual(s.renames[0], { sessionId: 'sess-1', title: 'lanpost · 张三' })
  assert.equal(s.state.sessions['direct:p1'].sessionId, 'sess-1')
})

test('会话模式 continue 复用映射，new 每条新建', async () => {
  const cont = setup()
  await cont.bridge.handleMessage(msg({ eventId: 'e1', messageId: 'm1' }))
  await cont.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2' }))
  assert.equal(cont.created.length, 1)
  assert.equal(cont.prompts[1].sessionId, 'sess-1')

  const fresh = setup({ state: { sessionMode: 'new' } })
  await fresh.bridge.handleMessage(msg({ eventId: 'e1', messageId: 'm1' }))
  await fresh.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2' }))
  assert.equal(fresh.created.length, 2)
  assert.notEqual(fresh.prompts[0].sessionId, fresh.prompts[1].sessionId)
  // 写回映射：状态页里能看到最近一次新会话。
  assert.equal(fresh.state.sessions['direct:p1'].sessionId, 'sess-2')
})

test('continue 模式命中已有映射时不建会话', async () => {
  const s = setup({
    state: {
      sessionMode: 'continue',
      sessions: { 'direct:p1': { sessionId: 'existing', updatedAt: '2026-11-26T00:00:00.000Z' } },
    },
  })
  await s.bridge.handleMessage(msg())
  assert.equal(s.created.length, 0)
  assert.equal(s.prompts[0].sessionId, 'existing')
})

test('群消息无 /dsh 前缀不触发，有前缀剥掉', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({ eventId: 'e1', conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '大家好' } }),
  )
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent.length, 0)
  await s.bridge.handleMessage(
    msg({
      eventId: 'e2',
      conversationType: 'group',
      groupId: 'g1',
      content: { type: 'text', text: '/dsh 帮我看下' },
    }),
  )
  assert.equal(s.prompts.length, 1)
  assert.match(s.prompts[0].content[0].text, /\[lanpost 群 g1 · 张三 \(zhangsan\)\]\n\n帮我看下$/)
  assert.equal(s.state.sessions['group:g1'].sessionId, 'sess-1')
  assert.deepEqual(s.renames[0], { sessionId: 'sess-1', title: 'lanpost · 群 g1' })
})

test('群消息 /DSH 大写同样触发', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({ conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '/DSH 你好' } }),
  )
  assert.equal(s.prompts.length, 1)
  assert.match(s.prompts[0].content[0].text, /\]\n\n你好$/)
})

test('/dsh 后直接跟正文（无空白）不触发', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({ conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '/dsh你好' } }),
  )
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent.length, 0)
})

test('/dsh 单独一条回用法提示且不起会话', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({ conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '/dsh' } }),
  )
  assert.equal(s.prompts.length, 0)
  assert.equal(s.created.length, 0)
  assert.equal(s.sent[0].text, '用法：/dsh <问题>')
  assert.deepEqual(s.sent[0].target, { kind: 'group', groupId: 'g1' })
})

test('/dsh 后只有空白也回用法提示', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({ conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '/dsh   ' } }),
  )
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent[0].text, '用法：/dsh <问题>')
})

test('群消息缺 group_id 时从 conversation_id 切会话键', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({
      conversationType: 'group',
      groupId: undefined,
      conversationId: 'group:g-42',
      content: { type: 'text', text: '/dsh 在吗' },
    }),
  )
  assert.equal(s.state.sessions['group:g-42'].sessionId, 'sess-1')
  assert.equal(s.prompts[0].content[0].text, '[lanpost 群 g-42 · 张三 (zhangsan)]\n\n在吗')
})

test('私聊图片回固定文案、不建会话', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ content: { type: 'image', mimeType: 'image/png' } }))
  assert.equal(s.prompts.length, 0)
  assert.equal(s.created.length, 0)
  assert.equal(s.sent[0].text, '暂不支持图片消息（当前仅支持文本）。')
  assert.deepEqual(s.sent[0].target, { kind: 'user', protocolId: 'p1' })
})

test('私聊未知 content 类型回固定文案、不建会话', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ content: { type: 'file', name: 'a.pdf' } }))
  assert.equal(s.prompts.length, 0)
  assert.equal(s.created.length, 0)
  assert.equal(s.sent[0].text, '暂不支持该类型的消息（当前仅支持文本）。')
})

test('群里图片与未知类型静默丢弃（不刷群）', async () => {
  const s = setup()
  await s.bridge.handleMessage(
    msg({ eventId: 'e1', conversationType: 'group', groupId: 'g1', content: { type: 'image', mimeType: 'image/png' } }),
  )
  await s.bridge.handleMessage(
    msg({ eventId: 'e2', conversationType: 'group', groupId: 'g1', content: { type: 'file', name: 'a.pdf' } }),
  )
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent.length, 0)
})

test('私聊空文本丢弃', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ content: { type: 'text', text: '' } }))
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent.length, 0)
})

test('同一 event_id 重复到达只处理一次', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ eventId: 'same', messageId: 'm1' }))
  await s.bridge.handleMessage(msg({ eventId: 'same', messageId: 'm1' }))
  assert.equal(s.prompts.length, 1)
  assert.deepEqual(s.state.seenEventIds, ['same', 'm1'])
})

test('缺 event_id 时按 message_id 去重', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ eventId: '', messageId: 'only' }))
  await s.bridge.handleMessage(msg({ eventId: '', messageId: 'only' }))
  assert.equal(s.prompts.length, 1)
})

test('会话被删后重建一次并重投', async () => {
  let calls = 0
  const s = setup({
    deps: {
      sessions: {
        create: async () => ({ sessionId: 'sess-new' }),
        prompt: async () => {
          calls += 1
          if (calls === 1) {
            throw Object.assign(new Error('not found'), { code: 'session/not-found' })
          }
          return { accepted: true }
        },
        rename: async () => ({}),
      },
    },
  })
  await s.bridge.handleMessage(msg())
  assert.equal(calls, 2)
  assert.equal(s.state.sessions['direct:p1'].sessionId, 'sess-new')
})

test('来源自回环被丢弃', async () => {
  const s = setup({ state: { selfProtocolId: 'p1' } })
  await s.bridge.handleMessage(msg())
  assert.equal(s.prompts.length, 0)
})

test('建会话失败时回原因、不抛', async () => {
  const s = setup({
    deps: {
      sessions: {
        create: async () => {
          throw new Error('workspace missing')
        },
        prompt: async () => ({ accepted: true }),
        rename: async () => ({}),
      },
    },
  })
  await s.bridge.handleMessage(msg())
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent[0].text, '创建会话失败：workspace missing')
  assert.deepEqual(s.sent[0].target, { kind: 'user', protocolId: 'p1' })
})

test('prompt 被拒时回「会话忙或不可用」', async () => {
  const s = setup({
    deps: {
      sessions: {
        create: async () => ({ sessionId: 'sess-1' }),
        prompt: async () => {
          throw Object.assign(new Error('agent busy'), { code: 'agent-busy' })
        },
        rename: async () => ({}),
      },
    },
  })
  await s.bridge.handleMessage(msg())
  assert.equal(s.sent[0].text, '会话忙或不可用：agent busy')
})

test('重命名失败只记日志，不影响投递', async () => {
  const s = setup({
    deps: {
      sessions: {
        create: async () => ({ sessionId: 'sess-1' }),
        prompt: async (req: any) => {
          s.prompts.push(req)
          return { accepted: true }
        },
        rename: async () => {
          throw new Error('rename denied')
        },
      },
    },
  })
  await s.bridge.handleMessage(msg())
  assert.equal(s.prompts.length, 1)
  assert.ok(s.logs.some((line) => line.includes('rename denied')))
})

test('create 请求：workspaceId 优先，其次 workspacePath 作为 cwd，都空则空对象', async () => {
  const byId = setup({ state: { workspaceId: 'w1', workspacePath: 'D:\\ws' } })
  await byId.bridge.handleMessage(msg())
  assert.deepEqual(byId.created[0], { workspaceId: 'w1' })

  const byPath = setup({ state: { workspaceId: null, workspacePath: 'D:\\ws' } })
  await byPath.bridge.handleMessage(msg())
  assert.deepEqual(byPath.created[0], { cwd: 'D:\\ws' })

  const bare = setup()
  await bare.bridge.handleMessage(msg())
  assert.deepEqual(bare.created[0], {})
})

test('同一会话键的消息串行处理', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const s = setup({
    deps: {
      sessions: {
        create: async () => ({ sessionId: 'sess-1' }),
        prompt: async (req: any) => {
          s.prompts.push(req)
          if (req.content[0].text.endsWith('第一条')) await gate
          return { accepted: true }
        },
        rename: async () => ({}),
      },
    },
  })
  const first = s.bridge.handleMessage(msg({ eventId: 'e1', messageId: 'm1', content: { type: 'text', text: '第一条' } }))
  const second = s.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2', content: { type: 'text', text: '第二条' } }))
  await tick()
  assert.equal(s.prompts.length, 1)
  release()
  await Promise.all([first, second])
  assert.equal(s.prompts.length, 2)
  assert.match(s.prompts[1].content[0].text, /第二条$/)
})

test('队列超过 20 条回排队提示', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const s = setup({
    deps: {
      sessions: {
        create: async () => ({ sessionId: 'sess-1' }),
        prompt: async (req: any) => {
          s.prompts.push(req)
          await gate
          return { accepted: true }
        },
        rename: async () => ({}),
      },
    },
  })
  const tasks = Array.from({ length: 21 }, (_, index) =>
    s.bridge.handleMessage(msg({ eventId: `e${index}`, messageId: `m${index}`, content: { type: 'text', text: `t${index}` } })),
  )
  await tick()
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '我这边还排着 20 条消息，稍后再发。')
  release()
  await Promise.all(tasks)
  assert.equal(s.prompts.length, 20)
})

test('dispose 后未开始的任务不再执行', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const s = setup({
    deps: {
      sessions: {
        create: async () => ({ sessionId: 'sess-1' }),
        prompt: async (req: any) => {
          s.prompts.push(req)
          await gate
          return { accepted: true }
        },
        rename: async () => ({}),
      },
    },
  })
  const first = s.bridge.handleMessage(msg({ eventId: 'e1', messageId: 'm1' }))
  const second = s.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2' }))
  await tick()
  s.bridge.dispose()
  release()
  await Promise.all([first, second])
  assert.equal(s.prompts.length, 1)
})

test('投递失败只记日志与审计，不抛', () => {
  const s = setup()
  s.bridge.handleDelivery({ messageId: 'm9', status: 'failed', reason: 'peer offline' })
  assert.ok(s.logs.some((line) => line.includes('m9') && line.includes('peer offline')))
  assert.ok(s.audits.some((entry) => entry.detail?.action === 'delivery-failed'))
})

test('入站审计不含消息全文', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ content: { type: 'text', text: '绝密口令 abcdef' } }))
  const accepted = s.audits.find((entry) => entry.detail?.action === 'accepted')
  assert.ok(accepted)
  assert.equal(accepted.kind, 'inbound')
  assert.equal(accepted.detail.eventId, 'evt_1')
  assert.equal(accepted.detail.textBytes, Buffer.byteLength('绝密口令 abcdef', 'utf8'))
  assert.equal(JSON.stringify(accepted.detail).includes('绝密口令'), false)
})

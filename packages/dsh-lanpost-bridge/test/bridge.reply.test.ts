import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { InboundBridge, formatTurnReply } from '../src/bridge.ts'
import type { InboundMessage } from '../src/gateway.ts'
import { DEFAULTS } from '../src/store.ts'

// 回复收集测试：全部假 deps + 假事件源，不连网、不落盘、不碰 DSH ctx。
// 每个用例结束 dispose，确保定时器与订阅不残留。
const running: InboundBridge[] = []
afterEach(() => {
  while (running.length > 0) running.pop()!.dispose()
})

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function setup(overrides: any = {}) {
  const state: any = {
    ...DEFAULTS,
    enabled: true,
    seenEventIds: [],
    sessions: {},
    turnTimeoutSeconds: overrides.turnTimeoutMs ? overrides.turnTimeoutMs / 1000 : 1800,
    ackEnabled: overrides.ackEnabled ?? false,
    recallAck: overrides.recallAck ?? false,
    ...overrides.state,
  }
  const prompts: any[] = []
  const sent: any[] = []
  const logs: string[] = []
  const audits: any[] = []
  let listener: ((sessionId: string, event: any) => void) | undefined
  const replyWaiters: Array<() => void> = []
  const notifyReply = (): void => {
    for (const check of replyWaiters.splice(0)) check()
  }
  const deps: any = {
    state: () => state,
    update: (mutate: (s: any) => void) => mutate(state),
    sessions: {
      create: async () => ({ sessionId: 'sess-1' }),
      prompt: async (request: any) => {
        prompts.push(request)
        return { accepted: true }
      },
      rename: async () => ({}),
    },
    send: async (target: any, text: string) => {
      sent.push({ target, text })
      notifyReply()
      // failAt 表示「第几次调用抛错」，用调用后的长度判定，便于测「第二段失败」。
      if (overrides.failAt === sent.length) throw new Error('gateway down')
      if (typeof overrides.deliveryStatus === 'string') {
        return { message_id: 'm', delivery_status: overrides.deliveryStatus }
      }
      return { message_id: 'm', delivery_status: 'queued' }
    },
    onSessionEvent: (handler: any) => {
      listener = handler
      return () => {
        listener = undefined
      }
    },
    log: (message: string) => logs.push(message),
    audit: (kind: string, detail: any) => audits.push({ kind, detail }),
    ...overrides.deps,
  }
  const bridge = new InboundBridge(deps)
  running.push(bridge)
  return {
    bridge,
    prompts,
    sent,
    logs,
    audits,
    state,
    emit: (sessionId: string, event: any) => listener?.(sessionId, event),
    /** 等第 count 次 send 发生；回复在 ACK 之后才发，不能等 handleMessage。 */
    waitForReply: (count = 1): Promise<void> =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (sent.length >= count) resolve()
          else replyWaiters.push(check)
        }
        check()
      }),
  }
}

const msg = (data: Partial<InboundMessage> = {}): InboundMessage => ({
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

/**
 * 投一条消息并等 ACK（prompt 已被接受、waiter 已登记），返回 requestId 与事件发射口。
 * ACK 不再等整轮结束：回复要另外用 waitForReply 等。
 */
async function begin(overrides: any = {}, data: Partial<InboundMessage> = {}) {
  const s = setup(overrides)
  await s.bridge.handleMessage(msg(data))
  const request = s.prompts[0]
  assert.ok(request, 'prompt 未被调用')
  return {
    ...s,
    rpcId: request.requestId as string,
    sessionId: request.sessionId as string,
  }
}

/** 让这一轮开始：user/message 的 rpcId 与 requestId 对齐。 */
function startTurn(
  s: { emit: (sessionId: string, event: any) => void; sessionId: string; rpcId: string },
  rpcId = s.rpcId,
): void {
  s.emit(s.sessionId, { type: 'user/message', data: { source: { kind: 'user', rpcId } } })
}

function assistant(s: { emit: (sessionId: string, event: any) => void; sessionId: string }, content: any[]): void {
  s.emit(s.sessionId, { type: 'assistant/message', data: { message: { content } } })
}

function endTurn(
  s: { emit: (sessionId: string, event: any) => void; sessionId: string },
  kind = 'completed',
): void {
  s.emit(s.sessionId, { type: 'turn/end', data: { reason: { kind } } })
}

// ── 基本回发 ────────────────────────────────────────────────────────────────

test('turn/end 后把最终文本回发到私聊', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '答案' },
  ])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '答案')
  assert.deepEqual(s.sent[0].target, { kind: 'user', protocolId: 'p1' })
})

test('群消息回复回原群而不是私聊', async () => {
  const s = await begin(
    {},
    { conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '/dsh 你好' } },
  )
  startTurn(s)
  assistant(s, [{ type: 'text', text: '群里的答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.deepEqual(s.sent[0].target, { kind: 'group', groupId: 'g1' })
  assert.equal(s.sent[0].text, '群里的答案')
})

test('多个 assistant/message 的文本块按顺序拼接', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [{ type: 'text', text: '你' }])
  assistant(s, [
    { type: 'reasoning', text: '中间想法' },
    { type: 'text', text: '好' },
  ])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '你好')
})

test('没有文本回复时发占位句', async () => {
  const s = await begin()
  startTurn(s)
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '（本轮没有文本回复）')
})

test('只有空白文本也回占位句', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [{ type: 'text', text: '   \n ' }])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '（本轮没有文本回复）')
})

test('showProcess 打开时附用时与工具次数', async () => {
  const s = await begin({ state: { showProcess: true } })
  startTurn(s)
  s.emit(s.sessionId, { type: 'tool/call', data: {} })
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.match(s.sent[0].text, /^答案\n\n— 用时 .*，工具 1 次$/)
})

test('showProcess 打开时把思考以引用形式附在正文后', async () => {
  const s = await begin({ state: { showProcess: true } })
  startTurn(s)
  s.emit(s.sessionId, { type: 'tool/call', data: {} })
  assistant(s, [
    { type: 'reasoning', text: '先想第一步\n再想第二步' },
    { type: 'text', text: '答案' },
  ])
  endTurn(s)
  await s.waitForReply()
  assert.match(s.sent[0].text, /^答案\n\n> 先想第一步\n> 再想第二步\n\n— 用时 .+，工具 1 次$/)
})

test('showProcess 关闭时思考内容不进正文', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [
    { type: 'reasoning', text: '不该出现' },
    { type: 'text', text: '答案' },
  ])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '答案')
})

test('showProcess 关闭时不统计工具次数（正文不受影响）', async () => {
  const s = await begin()
  startTurn(s)
  s.emit(s.sessionId, { type: 'tool/call', data: {} })
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '答案')
})

// ── 异常结束：只讲原因，不拼半截正文 ────────────────────────────────────────

test('error 结束只回原因句，不拼已收集的正文', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [{ type: 'text', text: '写了一半' }])
  endTurn(s, 'error')
  await s.waitForReply()
  assert.equal(s.sent[0].text, '这一轮没有正常完成（error）。')
})

test('非 error 的异常结束也回原因句', async () => {
  const s = await begin()
  startTurn(s)
  endTurn(s, 'aborted')
  await s.waitForReply()
  assert.equal(s.sent[0].text, '这一轮没有正常完成（aborted）。')
})

test('max-tokens 结束回原因句，showProcess 时附统计行', async () => {
  const s = await begin({ state: { showProcess: true } })
  startTurn(s)
  s.emit(s.sessionId, { type: 'tool/call', data: {} })
  assistant(s, [{ type: 'text', text: '被截断的正文' }])
  endTurn(s, 'max-tokens')
  await s.waitForReply()
  assert.match(s.sent[0].text, /^这一轮没有正常完成（max-tokens）。\n\n— 用时 .+，工具 1 次$/)
  assert.equal(s.sent[0].text.includes('被截断的正文'), false)
})

test('blocked 结束回原因句，showProcess 时附统计行', async () => {
  const s = await begin({ state: { showProcess: true } })
  startTurn(s)
  endTurn(s, 'blocked')
  await s.waitForReply()
  assert.match(s.sent[0].text, /^这一轮没有正常完成（blocked）。\n\n— 用时 .+，工具 0 次$/)
})

// ── 切段 ────────────────────────────────────────────────────────────────────

test('超长回复按段发送且每段不超 4000 字节', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [{ type: 'text', text: '啊'.repeat(3000) }])
  endTurn(s)
  await s.waitForReply(3)
  assert.equal(s.sent.length, 3)
  assert.ok(s.sent[0].text.startsWith('(1/3) '))
  assert.ok(s.sent[2].text.startsWith('(3/3) '))
  for (const part of s.sent) assert.ok(Buffer.byteLength(part.text, 'utf8') <= 4000)
})

test('某一段发送失败时中止后续段并记审计', async () => {
  const s = await begin({ failAt: 2 })
  startTurn(s)
  assistant(s, [{ type: 'text', text: '啊'.repeat(3000) }])
  endTurn(s)
  await s.waitForReply(2)
  await tick()
  assert.equal(s.sent.length, 2, '第三段不应再尝试')
  const failed = s.audits.find((entry) => entry.detail?.action === 'reply-send-failed')
  assert.ok(failed, '缺少 reply-send-failed 审计')
  assert.equal(failed.kind, 'inbound')
  assert.equal(failed.detail.segment, 2)
  assert.equal(failed.detail.total, 3)
  assert.ok(s.logs.some((line) => line.includes('gateway down')))
})

test('delivery_status 为 failed 时记失败审计，不记 reply-sent', async () => {
  const s = await begin({ deliveryStatus: 'failed' })
  startTurn(s)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  await tick()
  assert.equal(s.sent.length, 1, '投递失败不等于发送失败，后续段不重发也不中止')
  assert.ok(s.audits.some((entry) => entry.detail?.action === 'reply-send-failed' && entry.detail.status === 'failed'))
  assert.equal(s.audits.some((entry) => entry.detail?.action === 'reply-sent'), false)
})

// ── 结算幂等与顺序 ──────────────────────────────────────────────────────────

test('同一回合重复 turn/end 只结算一次', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [{ type: 'text', text: '只发一次' }])
  endTurn(s)
  endTurn(s)
  await s.waitForReply()
  await tick()
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '只发一次')
})

test('turn/end 先于 assistant/message 时立即结算，迟到的文本不再回发', async () => {
  const s = await begin()
  startTurn(s)
  endTurn(s)
  await s.waitForReply()
  assistant(s, [{ type: 'text', text: '迟到的答案' }])
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '（本轮没有文本回复）')
})

test('本轮开始前的 assistant/message 不收集', async () => {
  const s = await begin()
  assistant(s, [{ type: 'text', text: '别人回合的答案' }])
  startTurn(s)
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '（本轮没有文本回复）')
})

test('本轮开始前的 turn/end 不结算，随后正常的回合同样回发', async () => {
  const s = await begin()
  endTurn(s, 'completed')
  await tick()
  assert.equal(s.sent.length, 0)
  startTurn(s)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '答案')
})

test('其他会话的事件不影响本轮收集', async () => {
  const s = await begin()
  startTurn(s)
  s.emit('sess-other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别的会话' }] } } })
  s.emit('sess-other', { type: 'tool/call', data: {} })
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '答案')
})

test('rpcId 匹配但 sessionId 不符时不结算本轮', async () => {
  const s = await begin()
  s.emit('sess-other', { type: 'user/message', data: { source: { kind: 'user', rpcId: s.rpcId } } })
  assistant(s, [{ type: 'text', text: '没对齐' }])
  endTurn(s)
  await tick()
  assert.equal(s.sent.length, 0)
  // 正确对齐后本轮照常完成
  startTurn(s)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '答案')
})

test('同会话连续两条：都立即投递，按各自的回合分别回复', async () => {
  const s = await begin()
  startTurn(s)
  assistant(s, [{ type: 'text', text: '第一轮' }])

  // 第一轮还没结束就投第二条：不再由插件排队，而是立刻交给宿主（排队/插话由 busyEnter 决定）。
  await s.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2', content: { type: 'text', text: '第二条' } }))
  assert.equal(s.prompts.length, 2, '两条消息都应立刻投递给宿主')
  const secondRpc = s.prompts[1].requestId as string
  assert.notEqual(secondRpc, s.rpcId)

  // 第一条的消息已在第一轮里开始：先结算第一轮。
  endTurn(s)
  await s.waitForReply(1)
  assert.equal(s.sent[0].text, '第一轮')

  // 第二轮开始时 user/message 带第二个 rpcId；第一轮迟到的 assistant 不能混进第二轮。
  assistant(s, [{ type: 'text', text: '第一轮迟到' }])
  startTurn(s, secondRpc)
  assistant(s, [{ type: 'text', text: '第二轮' }])
  endTurn(s)
  await s.waitForReply(2)
  assert.equal(s.sent[1].text, '第二轮')
})

// ── 超时与 dispose ──────────────────────────────────────────────────────────

test('超时用已累积文本加超时说明结算', async () => {
  const s = await begin({ turnTimeoutMs: 20 })
  startTurn(s)
  assistant(s, [{ type: 'text', text: '半截答案' }])
  await s.waitForReply()
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '半截答案\n\n处理超时，已放弃等待。')
})

test('超时时没有文本则只回超时说明', async () => {
  const s = await begin({ turnTimeoutMs: 20 })
  await s.waitForReply()
  assert.equal(s.sent[0].text, '处理超时，已放弃等待。')
})

test('超时后迟到的 turn/end 不再结算', async () => {
  const s = await begin({ turnTimeoutMs: 20 })
  startTurn(s)
  await s.waitForReply()
  assistant(s, [{ type: 'text', text: '迟到' }])
  endTurn(s)
  await tick()
  assert.equal(s.sent.length, 1)
})

test('dispose 静默取消 pending 回合：不发消息，迟到事件也不再回发', async () => {
  const s = await begin({ turnTimeoutMs: 60_000 })
  startTurn(s)
  assistant(s, [{ type: 'text', text: '写了一半' }])
  s.bridge.dispose()
  await tick()
  assert.equal(s.sent.length, 0, 'dispose 不应回发任何消息')
  assert.ok(s.audits.some((entry) => entry.detail?.action === 'turn-canceled'))
  assistant(s, [{ type: 'text', text: '迟到' }])
  endTurn(s)
  await tick()
  assert.equal(s.sent.length, 0)
})

test('prompt 抛错时清掉等待器，后续 turn/end 不会多回一条', async () => {
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
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].text, '会话忙或不可用：agent busy')
  s.emit('sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await tick()
  assert.equal(s.sent.length, 1)
})

test('事件形状异常时不抛错也不误结算', async () => {
  const s = await begin()
  startTurn(s)
  // content 不是数组、reason 缺 kind：都应安全跳过
  s.emit(s.sessionId, { type: 'assistant/message', data: { message: {} } })
  s.emit(s.sessionId, { type: 'turn/end', data: { reason: {} } })
  await tick()
  assert.equal(s.sent.length, 0)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply()
  assert.equal(s.sent[0].text, '答案')
})

// ── 纯函数：正文组装 ────────────────────────────────────────────────────────

test('formatTurnReply：完成态用正文，空白/缺失用占位句', () => {
  const base = { reasoning: [], tools: 0, elapsedMs: 1234, showProcess: false }
  assert.equal(formatTurnReply({ ...base, texts: ['答案'], reason: 'completed' }), '答案')
  assert.equal(formatTurnReply({ ...base, texts: [], reason: 'completed' }), '（本轮没有文本回复）')
  assert.equal(formatTurnReply({ ...base, texts: [' \n'], reason: 'completed' }), '（本轮没有文本回复）')
})

test('formatTurnReply：超时保留已累积文本并追加说明', () => {
  const base = { reasoning: [], tools: 0, elapsedMs: 1234, showProcess: false }
  assert.equal(
    formatTurnReply({ ...base, texts: ['半截'], reason: 'timeout' }),
    '半截\n\n处理超时，已放弃等待。',
  )
  assert.equal(formatTurnReply({ ...base, texts: [], reason: 'timeout' }), '处理超时，已放弃等待。')
})

test('formatTurnReply：异常结束丢正文只讲原因，不追加出错提示', () => {
  const base = { reasoning: ['思考'], tools: 2, elapsedMs: 1500, showProcess: false }
  assert.equal(
    formatTurnReply({ ...base, texts: ['半截正文'], reason: 'error' }),
    '这一轮没有正常完成（error）。',
  )
  assert.equal(
    formatTurnReply({ ...base, texts: [], reason: 'aborted' }),
    '这一轮没有正常完成（aborted）。',
  )
})

test('formatTurnReply：异常结束在 showProcess 时也附统计行', () => {
  const text = formatTurnReply({
    texts: ['半截正文'],
    reasoning: [],
    tools: 0,
    elapsedMs: 1500,
    showProcess: true,
    reason: 'max-tokens',
  })
  assert.equal(text, '这一轮没有正常完成（max-tokens）。\n\n— 用时 1.5s，工具 0 次')
})

test('formatTurnReply：思考截到 500 字并按行加引用前缀', () => {
  const long = '思'.repeat(600)
  const text = formatTurnReply({
    texts: ['答案'],
    reasoning: [long],
    tools: 2,
    elapsedMs: 1500,
    showProcess: true,
    reason: 'completed',
  })
  assert.ok(text.startsWith(`答案\n\n> ${'思'.repeat(500)}\n\n— 用时 1.5s，工具 2 次`))
  assert.equal(text.includes('思'.repeat(501)), false)
})

test('formatTurnReply：showProcess 关闭时不附思考与统计', () => {
  assert.equal(
    formatTurnReply({
      texts: ['答案'],
      reasoning: ['思考'],
      tools: 4,
      elapsedMs: 12_300,
      showProcess: false,
      reason: 'completed',
    }),
    '答案',
  )
})

// ── 回执、撤回与忽略前缀 ────────────────────────────────────────────────────

test('开启回执：先回回执，回合结束后发最终回复并撤回回执', async () => {
  const recalls: string[] = []
  const s = await begin({ ackEnabled: true, recallAck: true, deps: { recall: async (id: string) => { recalls.push(id) } } })
  assert.equal(s.sent[0].text, '已收到，正在处理…')
  assert.equal(recalls.length, 0, '回合结束前不撤回')
  startTurn(s)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply(2)
  assert.equal(s.sent[1].text, '答案')
  await sleep(5)
  assert.deepEqual(recalls, ['m'])
  assert.ok(s.audits.some((entry: any) => entry.detail?.action === 'ack-sent'))
  assert.ok(s.audits.some((entry: any) => entry.detail?.action === 'ack-recalled'))
})

test('回执文案为空时用内置默认文案', async () => {
  const s = await begin({ ackEnabled: true, state: { ackText: '  ' } })
  assert.equal(s.sent[0].text, '已收到，正在处理…')
})

test('关闭撤回：回执保留不撤回', async () => {
  const recalls: string[] = []
  const s = await begin({ ackEnabled: true, recallAck: false, deps: { recall: async (id: string) => { recalls.push(id) } } })
  startTurn(s)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply(2)
  await sleep(5)
  assert.deepEqual(recalls, [])
})

test('撤回失败只记审计，不影响最终回复', async () => {
  const s = await begin({
    ackEnabled: true,
    recallAck: true,
    deps: { recall: async () => { throw new Error('recall denied') } },
  })
  startTurn(s)
  assistant(s, [{ type: 'text', text: '答案' }])
  endTurn(s)
  await s.waitForReply(2)
  await sleep(5)
  assert.equal(s.sent[1].text, '答案')
  assert.ok(s.audits.some((entry: any) => entry.detail?.action === 'ack-recall-failed'))
})

test('promptMode 返回 steer 时按插话投递', async () => {
  const s = await begin({ deps: { promptMode: () => 'steer' } })
  assert.equal(s.prompts[0].mode, 'steer')
})
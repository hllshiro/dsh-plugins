// 入站编排：`message.received` → 去重 → 过滤（私聊全放行 / 群 `/dsh`）→ 忽略前缀 → 回执
// → 会话映射 → `prompt`（排队或插话跟随 DSH 的 busyEnter 设置）→ 等本轮 `turn/end`
// → 收集最终 assistant 文本 → 撤回回执 → 切段回发。
// 本文件不碰 DSH ctx：会话、发送、事件订阅全部经 `InboundDeps` 注入（装配层负责）。
import { randomUUID } from 'node:crypto'
import {
  ACK_TEXT_DEFAULT,
  SEEN_LIMIT,
  dedupeAdd,
  formatDuration,
  isIgnoredText,
  parseIgnorePrefixes,
  promptTextFor,
  replyParts,
  stripGroupTrigger,
} from './core.ts'
import type { ReplySource } from './core.ts'
import type { InboundMessage } from './gateway.ts'
import type { SessionEventLike } from './harness.ts'
import type { BridgeState } from './store.ts'

// 会话事件类型定义只有 harness.ts 一份，这里为桥接使用方再导出。
/** 会话事件类型（定义在 harness.ts，这里为桥接使用方转发）。 */
export type { SessionEventLike }

/** 私聊回退文案：v1 只处理文本。 */
export const IMAGE_NOTICE = '暂不支持图片消息（当前仅支持文本）。'
/** 未知 content 类型的回退文案。 */
export const UNSUPPORTED_NOTICE = '暂不支持该类型的消息（当前仅支持文本）。'

/** 本轮没有任何 assistant 文本时的占位句。 */
export const EMPTY_REPLY_NOTICE = '（本轮没有文本回复）'
/** 等不到 `turn/end` 时的收尾说明；已累积的文本保留在前面。 */
export const TIMEOUT_NOTICE = '处理超时，已放弃等待。'
/** 思考引用的截断长度（字符数）。 */
const REASONING_QUOTE_CHARS = 500

/** 一轮结束时用于组装回复的素材；纯数据，便于单测。 */
export interface TurnReplyInput {
  /** 本轮收集到的 assistant 文本块（按到达顺序）。 */
  texts: readonly string[]
  /** 本轮收集到的 reasoning 文本块；仅 `showProcess` 时引用。 */
  reasoning: readonly string[]
  /** 本轮 `tool/call` 次数。 */
  tools: number
  /** 本轮耗时（毫秒）。 */
  elapsedMs: number
  /** 是否附带思考引用与用量统计。 */
  showProcess: boolean
  /** `completed` / `timeout`，或 `turn/end` 的 `reason.kind`。 */
  reason: string
}

/** 把思考块压成引用：按行加 `> `，最多取前 500 字；无内容返回空串。 */
function quoteReasoning(blocks: readonly string[]): string {
  const joined = blocks.join('\n').trim()
  if (joined === '') return ''
  const clipped = Array.from(joined).slice(0, REASONING_QUOTE_CHARS).join('')
  return clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/** 追加过程信息：思考引用 + 「— 用时 X，工具 N 次」。 */
function withProcess(text: string, input: TurnReplyInput): string {
  if (!input.showProcess) return text
  const stats = `— 用时 ${formatDuration(input.elapsedMs)}，工具 ${input.tools} 次`
  const quoted = quoteReasoning(input.reasoning)
  return quoted === '' ? `${text}\n\n${stats}` : `${text}\n\n${quoted}\n\n${stats}`
}

/**
 * 组装一轮的最终回复。状态文案是设计文档 7.5 的固定字符串：
 * 超时保留已收集文本；异常结束（error/aborted/max-tokens/blocked…）丢掉半截正文、只讲原因。
 * `showProcess` 打开时所有结算分支都追加「— 用时 X，工具 N 次」（有思考时先附引用）。
 */
export function formatTurnReply(input: TurnReplyInput): string {
  const body = input.texts.join('').trim()
  const blank = body === ''

  if (input.reason === 'timeout') {
    return withProcess(blank ? TIMEOUT_NOTICE : `${body}\n\n${TIMEOUT_NOTICE}`, input)
  }

  if (input.reason !== 'completed') {
    return withProcess(`这一轮没有正常完成（${input.reason}）。`, input)
  }

  return withProcess(blank ? EMPTY_REPLY_NOTICE : body, input)
}

/** 单次 `prompt` 的等待上限（与设计文档的 30s 一致）。 */
const PROMPT_TIMEOUT_MS = 30_000
const PRIVATE_PREFIX = 'direct:'
const GROUP_PREFIX = 'group:'

/** 发消息的目标（与网关 `sendUser` / `sendGroup` 一一对应）。 */
export type ReplyTarget = { kind: 'user'; protocolId: string } | { kind: 'group'; groupId: string }

/** 入站桥依赖的宿主能力：状态读写、会话控制、发送、事件订阅与日志/审计。 */
export interface InboundDeps {
  state(): BridgeState
  update(mutate: (state: BridgeState) => void): void
  sessions: {
    create(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string }>
    prompt(
      request: {
        requestId: string
        sessionId: string
        mode: 'queue' | 'steer'
        content: Array<{ type: 'text'; text: string }>
      },
      signal: AbortSignal,
    ): Promise<{ accepted: true }>
    rename(request: { sessionId: string; title: string }): Promise<unknown>
  }
  send(target: ReplyTarget, text: string): Promise<{ message_id: string; delivery_status: string }>
  /** 撤回一条已发消息（回执）；缺省视为网关不支持。 */
  recall?(messageId: string): Promise<void>
  /** 取 DSH 的 busyEnter 设置；缺省按 `queue`（DSH 默认值）投递。 */
  promptMode?(): 'queue' | 'steer'
  onSessionEvent(handler: (sessionId: string, event: SessionEventLike) => void): () => void
  log(message: string): void
  now?(): number
  /** 审计出口；宿主侧接 `writeAudit(home, kind, detail)`。缺省不写（假 deps 测试）。 */
  audit?(kind: string, detail: Record<string, unknown>): void
}

/** 一条入站消息经判定后的处置方式。 */
type Plan =
  | { kind: 'drop'; reason: string }
  | { kind: 'notice'; target: ReplyTarget; text: string; source: ReplySource }
  | {
      kind: 'prompt'
      key: string
      target: ReplyTarget
      text: string
      source: ReplySource
    }

type PromptPlan = Extract<Plan, { kind: 'prompt' }>

/** 一条入站消息对应的等待器：从 prompt 前登记到本轮结算（或超时/停用）。 */
interface TurnWaiter {
  requestId: string
  sessionId: string
  target: ReplyTarget
  /** 回执消息 id；没有回执或回执发送失败时为 null。 */
  ackId: string | null
  /** 已看到本轮 `user/message`：本轮开始前的 assistant 事件不计入。 */
  started: boolean
  settled: boolean
  startedAt: number
  timer?: NodeJS.Timeout
}

/**
 * 一轮 turn 的共享素材。插话（steer）时同一条 turn 可能挂着多个等待器，
 * 它们共用这一轮的文本与工具计数。
 */
interface ActiveTurn {
  sessionId: string
  waiters: TurnWaiter[]
  texts: string[]
  reasoning: string[]
  tools: number
  startedAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从 deps 抛出的错误里取协议错误码；取不到返回 undefined。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code
    if (typeof code === 'string') return code
  }
  return undefined
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

/** 外部可控名字（显示名/用户名/群 id）截断到的最大码点数。 */
const SOURCE_TEXT_MAX = 64
/** 控制字符、零宽字符与 bidi 覆盖字符：折叠为空格，防止伪造来源行。
 *  U+200D（ZWJ）不在区间内：👨‍👩‍👧 这类 emoji 依赖它连接，净化时不能拆散。 */
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200C\u200E-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F]/g

/**
 * 净化要进来源行/会话标题的外部字符串：控制与不可见字符→空格、方括号→空格、
 * 空白折叠、按码点截断；净化后为空时回退 `fallback`。
 * 只用于**展示面**（prompt 首行、会话标题）；`display_name`、`username`、`group_id`
 * 都来自对端，不净化就能插入换行伪造来源行。
 */
function sanitizeSourceText(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/[[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const clipped = Array.from(cleaned).slice(0, SOURCE_TEXT_MAX).join('').trim()
  return clipped === '' ? fallback : clipped
}

/** 群门禁：命中 `/dsh` 前缀则返回剥掉前缀与紧随空白的正文（可能为空），未命中返回 null。 */
function groupBodyOf(text: string): string | null {
  const stripped = stripGroupTrigger(text)
  return stripped === null ? null : stripped.trim()
}

/** 群 id 优先取 `groupId`，缺省从 `conversationId` 的 `group:` 前缀切。 */
function groupIdOf(event: InboundMessage): string | undefined {
  if (event.groupId) return event.groupId
  if (!event.conversationId.startsWith(GROUP_PREFIX)) return undefined
  const id = event.conversationId.slice(GROUP_PREFIX.length)
  return id === '' ? undefined : id
}

/** 宿主侧装配的入站桥；`handleMessage` 只保证不把异常抛给网关的 ACK 路径。 */
export class InboundBridge {
  private readonly deps: InboundDeps
  private readonly waiters = new Map<string, TurnWaiter>()
  private readonly turns = new Map<string, ActiveTurn>()
  /** 在途 prompt 的取消句柄：`dispose()` 时全部 abort，别让回合在停用后继续跑。 */
  private readonly inflight = new Set<AbortController>()
  private unsubscribe: (() => void) | undefined
  private disposed = false

  constructor(deps: InboundDeps) {
    this.deps = deps
    this.unsubscribe = deps.onSessionEvent((sessionId, event) => this.observe(sessionId, event))
  }

  /** 处理一条 `message.received`。重复事件、被过滤的消息直接返回。 */
  async handleMessage(event: InboundMessage): Promise<void> {
    if (this.disposed) return

    // 先判定再记去重：被门禁/忽略前缀丢掉的消息既不占窗口，也不触发状态写盘。
    const plan = this.plan(event)
    if (plan.kind === 'drop') {
      this.audit({ action: 'ignored', eventId: event.eventId, messageId: event.messageId, reason: plan.reason })
      return
    }

    if (!this.rememberSeen(event)) return
    if (this.disposed) return

    if (plan.kind === 'notice') {
      await this.reply(plan.target, plan.text)
      return
    }

    this.audit({
      action: 'accepted',
      eventId: event.eventId,
      messageId: event.messageId,
      conversationType: event.conversationType,
      textBytes: Buffer.byteLength(plan.text, 'utf8'),
    })

    // 回执要「收到即回」，所以放在建会话之前；失败不阻塞主流程。
    const ackId = await this.sendAck(plan.target)
    await this.process(plan, event, ackId)
  }

  /** 出站投递回执；只写日志与审计，不回聊天。 */
  handleDelivery(status: { messageId?: string; status: string; reason?: string }): void {
    const messageId = status.messageId ?? 'unknown'
    if (status.status === 'failed') {
      const reason = status.reason ?? 'no reason'
      this.deps.log(`lanpost-bridge: delivery failed for ${messageId}: ${reason}`)
      this.audit({ action: 'delivery-failed', messageId, reason })
      return
    }
    this.deps.log(`lanpost-bridge: delivery ${status.status} for ${messageId}`)
  }

  /**
   * 停掉订阅与等待器：pending 回合静默取消（设计 §11 卸载只清理，不发消息）。
   * 卸载/重载时网关通常已在关闭，`send`/`recall` 都不再调用。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const pending = this.waiters.size
    for (const waiter of [...this.waiters.values()]) this.cancelWaiter(waiter)
    if (pending > 0) this.deps.log(`lanpost-bridge: disposed with ${pending} pending turn(s)`)
    // 在途 prompt 一并中止：等待器已取消，迟到的接受不该再让回合继续跑。
    for (const controller of this.inflight) controller.abort(new Error('lanpost-bridge: disposed'))
    this.inflight.clear()
    this.turns.clear()
  }

  // ── 回复收集 ────────────────────────────────────────────────────────────

  /** 会话事件入口：只认 `rpcId` 对齐后的本轮事件，逐类累积。 */
  private observe(sessionId: string, event: SessionEventLike): void {
    if (this.disposed) return

    switch (event.type) {
      case 'user/message': {
        const rpcId = event.data?.source?.rpcId
        if (typeof rpcId !== 'string') return
        const waiter = this.waiters.get(rpcId)
        if (!waiter || waiter.settled || waiter.sessionId !== sessionId) return
        // 只有 rpcId 与入站投递的 requestId 对齐才算「这一轮」开始。
        waiter.started = true
        waiter.startedAt = this.now()
        const turn = this.turnFor(sessionId)
        if (!turn.waiters.includes(waiter)) turn.waiters.push(waiter)
        return
      }
      case 'assistant/message': {
        const turn = this.turns.get(sessionId)
        if (!turn) return
        const content: unknown = event.data?.message?.content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          if (typeof block.text !== 'string') continue
          if (block.type === 'text') turn.texts.push(block.text)
          else if (block.type === 'reasoning') turn.reasoning.push(block.text)
        }
        return
      }
      case 'tool/call': {
        const turn = this.turns.get(sessionId)
        if (turn) turn.tools += 1
        return
      }
      case 'turn/end': {
        const kind: unknown = event.data?.reason?.kind
        if (typeof kind !== 'string' || kind === '') return
        const turn = this.turns.get(sessionId)
        if (!turn) return
        this.settleTurn(turn, kind)
        return
      }
    }
  }

  /** 取或建该会话的当前一轮；一轮只会在 turn/end 或最后一个等待器结算时移除。 */
  private turnFor(sessionId: string): ActiveTurn {
    const existing = this.turns.get(sessionId)
    if (existing) return existing
    const turn: ActiveTurn = {
      sessionId,
      waiters: [],
      texts: [],
      reasoning: [],
      tools: 0,
      startedAt: this.now(),
    }
    this.turns.set(sessionId, turn)
    return turn
  }

  /** 在 `prompt` 之前登记等待器：事件可能比 prompt 的 promise 更早到。 */
  private expectTurn(
    requestId: string,
    sessionId: string,
    target: ReplyTarget,
    ackId: string | null,
  ): TurnWaiter {
    const waiter: TurnWaiter = {
      requestId,
      sessionId,
      target,
      ackId,
      started: false,
      settled: false,
      startedAt: this.now(),
    }

    // 用可清理的定时器而不是 AbortSignal.timeout：unref 不吊住进程，结算时清掉。
    const timeoutMs = this.deps.state().turnTimeoutSeconds * 1000
    const timer = setTimeout(() => this.settleWaiter(waiter, 'timeout'), timeoutMs)
    timer.unref()
    waiter.timer = timer

    this.waiters.set(requestId, waiter)
    return waiter
  }

  /** prompt 没被接受：撤掉等待器，别让迟到的 turn/end 回一条空回复。 */
  private abandon(waiter: TurnWaiter): void {
    if (waiter.settled) return
    waiter.settled = true
    if (waiter.timer) clearTimeout(waiter.timer)
    this.waiters.delete(waiter.requestId)
    this.detach(waiter)
  }

  /** 把等待器从所属一轮里摘掉；一轮空了就从表里清除。 */
  private detach(waiter: TurnWaiter): void {
    const turn = this.turns.get(waiter.sessionId)
    if (!turn) return
    turn.waiters = turn.waiters.filter((item) => item !== waiter)
    if (turn.waiters.length === 0) this.turns.delete(waiter.sessionId)
  }

  /** 停用时静默取消：不回发任何消息，只记审计。 */
  private cancelWaiter(waiter: TurnWaiter): void {
    if (waiter.settled) return
    waiter.settled = true
    if (waiter.timer) clearTimeout(waiter.timer)
    this.waiters.delete(waiter.requestId)
    this.detach(waiter)
    this.audit({ action: 'turn-canceled', sessionId: waiter.sessionId })
  }

  /** 结算整轮：按目标去重回发一次，再逐个撤回回执并清理等待器。 */
  private settleTurn(turn: ActiveTurn, reason: string): void {
    this.turns.delete(turn.sessionId)
    const waiters = turn.waiters
    turn.waiters = []
    if (reason === 'timeout') {
      this.audit({ action: 'turn-timeout', sessionId: turn.sessionId })
    }
    const text = formatTurnReply({
      texts: turn.texts,
      reasoning: turn.reasoning,
      tools: turn.tools,
      elapsedMs: this.now() - turn.startedAt,
      showProcess: this.deps.state().showProcess,
      reason,
    })

    const settled = waiters.filter((waiter) => !waiter.settled)
    for (const waiter of settled) {
      waiter.settled = true
      if (waiter.timer) clearTimeout(waiter.timer)
      this.waiters.delete(waiter.requestId)
    }
    void this.deliverToTargets(settled, text, reason)
  }

  /** 单个等待器超时：只结算它自己，本轮其它（插话）等待器继续等。 */
  private settleWaiter(waiter: TurnWaiter, reason: string): void {
    if (waiter.settled) return
    waiter.settled = true
    if (waiter.timer) clearTimeout(waiter.timer)
    this.waiters.delete(waiter.requestId)

    const turn = this.turns.get(waiter.sessionId)
    this.detach(waiter)
    this.audit({ action: 'turn-timeout', sessionId: waiter.sessionId })

    const text = formatTurnReply({
      texts: turn ? turn.texts : [],
      reasoning: turn ? turn.reasoning : [],
      tools: turn ? turn.tools : 0,
      elapsedMs: this.now() - waiter.startedAt,
      showProcess: this.deps.state().showProcess,
      reason,
    })
    void this.deliverToTargets([waiter], text, reason)
  }

  /**
   * 按目标去重后逐段回发，然后撤回各条回执。发送失败只记审计，不重试。
   * `delivery_status === 'failed'` 表示网关已受理但投递失败：记失败审计，后续段照发。
   */
  private async deliverToTargets(
    waiters: readonly TurnWaiter[],
    text: string,
    reason: string,
  ): Promise<void> {
    const targets = new Map<string, ReplyTarget>()
    for (const waiter of waiters) {
      targets.set(targetKey(waiter.target), waiter.target)
    }

    const parts = replyParts(text)
    let failures = 0
    for (const [key, target] of targets) {
      for (let index = 0; index < parts.length; index += 1) {
        let deliveryStatus = ''
        try {
          const result = await this.deps.send(target, parts[index])
          if (typeof result?.delivery_status === 'string') deliveryStatus = result.delivery_status
        } catch (error) {
          this.deps.log(
            `lanpost-bridge: reply segment ${index + 1}/${parts.length} to ${key} failed: ${errorMessage(error)}`,
          )
          this.audit({
            action: 'reply-send-failed',
            reason,
            target: key,
            segment: index + 1,
            total: parts.length,
            error: errorMessage(error),
          })
          break
        }

        if (deliveryStatus === 'failed') {
          failures += 1
          this.deps.log(`lanpost-bridge: reply segment ${index + 1}/${parts.length} delivery failed`)
          this.audit({
            action: 'reply-send-failed',
            reason,
            target: key,
            segment: index + 1,
            total: parts.length,
            status: deliveryStatus,
          })
        }
      }
    }

    for (const waiter of waiters) await this.recallAck(waiter.ackId)
    if (failures === 0) {
      this.audit({
        action: 'reply-sent',
        reason,
        segments: parts.length,
        targets: targets.size,
      })
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ── 回执 ────────────────────────────────────────────────────────────────

  /** 发一条回执；未启用或发送失败返回 null（失败不阻塞主流程）。 */
  private async sendAck(target: ReplyTarget): Promise<string | null> {
    const state = this.deps.state()
    if (!state.ackEnabled) return null
    const text = state.ackText.trim() === '' ? ACK_TEXT_DEFAULT : state.ackText
    try {
      const result = await this.deps.send(target, text)
      const messageId = typeof result?.message_id === 'string' ? result.message_id : ''
      if (messageId === '') {
        this.audit({ action: 'ack-sent', messageId: null })
        return null
      }
      this.audit({ action: 'ack-sent', messageId })
      return messageId
    } catch (error) {
      this.deps.log(`lanpost-bridge: ack to ${targetKey(target)} failed: ${errorMessage(error)}`)
      this.audit({ action: 'ack-failed', target: targetKey(target), error: errorMessage(error) })
      return null
    }
  }

  /** 撤回一条回执；未开启撤回、网关不支持或失败都只记日志/审计。 */
  private async recallAck(messageId: string | null): Promise<void> {
    if (messageId === null || messageId === '') return
    if (!this.deps.state().recallAck) return
    const recall = this.deps.recall
    if (!recall) return
    try {
      await recall(messageId)
      this.audit({ action: 'ack-recalled', messageId })
    } catch (error) {
      this.deps.log(`lanpost-bridge: recall ${messageId} failed: ${errorMessage(error)}`)
      this.audit({ action: 'ack-recall-failed', messageId, error: errorMessage(error) })
    }
  }

  // ── 判定 ────────────────────────────────────────────────────────────────

  /**
   * 去重窗口同时记 `messageId` 与 `eventId`：两维任一已出现都算重复，
   * 所以必须 `&&`（只换 `event_id` 的补发也要拦住）。两者都为空时不去重。
   */
  private rememberSeen(event: InboundMessage): boolean {
    const hasMessageId = event.messageId !== ''
    const hasEventId = event.eventId !== ''
    if (!hasMessageId && !hasEventId) return true

    let fresh = true
    this.deps.update((state) => {
      let list = state.seenEventIds
      if (hasMessageId) {
        const step = dedupeAdd(list, event.messageId, SEEN_LIMIT)
        list = step.list
        fresh = step.added
      }
      if (hasEventId && event.eventId !== event.messageId) {
        const step = dedupeAdd(list, event.eventId, SEEN_LIMIT)
        list = step.list
        fresh = fresh && step.added
      }
      // 用新数组整体替换，不原地改入参（`mergeSettings` 是浅拷贝，数组可能共享）。
      state.seenEventIds = list
    })
    return fresh
  }

  private plan(event: InboundMessage): Plan {
    const state = this.deps.state()
    const self = state.selfProtocolId
    const senderId = event.sender.protocolId
    // 空发送方无法建会话也无法回发，还会拼出 `direct:` 这样的空键。
    if (senderId === '') return { kind: 'drop', reason: 'missing-sender' }
    if (self !== null && self !== '' && senderId === self) {
      return { kind: 'drop', reason: 'self-loop' }
    }

    const content: { type: string; text?: string } = event.content
    const text = content.type === 'text' ? (content.text ?? '') : null

    // 外部字段进来源行/会话标题前统一净化：`]` 与换行可伪造 `[lanpost …]` 行。
    const username = sanitizeSourceText(event.sender.username, '')
    const displayName = sanitizeSourceText(event.sender.displayName, '')
    const whoName = displayName !== '' ? displayName : username !== '' ? username : '未知用户'
    // 键与回复目标用对端原值；只有展示面（prompt 首行/会话标题）净化。
    const groupId = groupIdOf(event)
    const displayGroupId =
      groupId === undefined ? undefined : sanitizeSourceText(groupId, '未知群')
    // gateway 把非 `group` 归一成 `private`；会话键是 `group:` 的消息仍要按群门禁处理。
    const isGroup = event.conversationType === 'group' || groupId !== undefined

    if (isGroup) {
      if (!groupId) return { kind: 'drop', reason: 'missing-group-id' }

      const key = `${GROUP_PREFIX}${groupId}`
      const target: ReplyTarget = { kind: 'group', groupId }
      const source: ReplySource = { kind: 'group', name: whoName, username, groupId: displayGroupId }

      if (text === null) return { kind: 'drop', reason: 'unsupported-content' }
      const stripped = groupBodyOf(text)
      if (stripped === null) return { kind: 'drop', reason: 'missing-trigger' }
      // `/dsh` 后没跟正文：静默丢弃（design 7.2），不在群里回用法提示。
      if (stripped === '') return { kind: 'drop', reason: 'empty-after-prefix' }
      return { kind: 'prompt', key, target, text: stripped, source }
    }

    const key = `${PRIVATE_PREFIX}${senderId}`
    const target: ReplyTarget = { kind: 'user', protocolId: senderId }
    const source: ReplySource = { kind: 'private', name: whoName, username }

    if (text === null) {
      const notice = content.type === 'image' ? IMAGE_NOTICE : UNSUPPORTED_NOTICE
      return { kind: 'notice', target, text: notice, source }
    }
    if (isBlank(text)) return { kind: 'drop', reason: 'empty-text' }
    // 忽略前缀只作用于私聊：给这个节点单独发数据时用，不进会话、不回执。
    if (isIgnoredText(text, parseIgnorePrefixes(state.ignorePrefixes))) {
      return { kind: 'drop', reason: 'ignore-prefix' }
    }
    return { kind: 'prompt', key, target, text, source }
  }

  // ── 处理 ────────────────────────────────────────────────────────────────

  /**
   * 投递一条消息：等 `prompt` 被接受（或失败提示发完）就返回，让网关及时 ACK。
   * 回复本身在后台等 turn/end，不阻塞事件处理。
   */
  private async process(
    plan: PromptPlan,
    event: InboundMessage,
    ackId: string | null,
  ): Promise<void> {
    const requestId = `lanpost-${randomUUID()}`
    const text = promptTextFor(plan.source, plan.text)
    let markAccepted: () => void = () => {}
    const accepted = new Promise<void>((resolve) => {
      markAccepted = resolve
    })
    void this.runPrompt(plan, event, requestId, text, ackId, markAccepted)
    await accepted
  }

  /** 建会话 → 登记等待器 → prompt；失败时回提示并撤回回执。 */
  private async runPrompt(
    plan: PromptPlan,
    event: InboundMessage,
    requestId: string,
    text: string,
    ackId: string | null,
    accepted: () => void,
  ): Promise<void> {
    let phase: 'session' | 'prompt' = 'session'
    try {
      await this.startTurn(plan, event, requestId, text, ackId)
    } catch (error) {
      // 停用期间被中止的 prompt 不是业务失败，不回任何消息（dispose 静默取消）。
      if (this.disposed) return
      phase = errorCode(error) === undefined ? 'session' : 'prompt'
      const notice =
        phase === 'session'
          ? `创建会话失败：${errorMessage(error)}`
          : `会话忙或不可用：${errorMessage(error)}`
      this.deps.log(`lanpost-bridge: ${notice}`)
      this.audit({
        action: 'failed',
        eventId: event.eventId,
        key: plan.key,
        phase,
        error: errorMessage(error),
      })
      await this.reply(plan.target, notice)
      await this.recallAck(ackId)
    } finally {
      accepted()
    }
  }

  /** 建会话并投递；会话在 GUI 里被删（`session/not-found`）时重建一次再试。 */
  private async startTurn(
    plan: PromptPlan,
    event: InboundMessage,
    requestId: string,
    text: string,
    ackId: string | null,
  ): Promise<void> {
    let session = await this.ensureSession(plan.key, plan.source, event)
    let waiter = this.expectTurn(requestId, session.sessionId, plan.target, ackId)
    try {
      await this.promptOnce(requestId, session.sessionId, text)
      return
    } catch (error) {
      this.abandon(waiter)
      if (errorCode(error) !== 'session/not-found') throw error
      this.deps.log(`lanpost-bridge: session ${session.sessionId} for ${plan.key} is gone, recreating`)
      this.audit({ action: 'session-recreate', eventId: event.eventId, key: plan.key, sessionId: session.sessionId })
      this.forget(plan.key)
    }

    // 会话被删：重建一次再投一遍，不把错误甩给用户。
    session = await this.ensureSession(plan.key, plan.source, event)
    waiter = this.expectTurn(requestId, session.sessionId, plan.target, ackId)
    try {
      await this.promptOnce(requestId, session.sessionId, text)
    } catch (error) {
      this.abandon(waiter)
      throw error
    }
  }

  /** 单次投递；30 秒未接受视为失败（由上层回提示）。 */
  private async promptOnce(requestId: string, sessionId: string, text: string): Promise<void> {
    const mode = this.deps.promptMode?.() ?? 'queue'
    const request = {
      requestId,
      sessionId,
      mode,
      content: [{ type: 'text' as const, text }],
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('lanpost-bridge: prompt timed out')),
      PROMPT_TIMEOUT_MS,
    )
    timer.unref()
    this.inflight.add(controller)
    try {
      await this.deps.sessions.prompt(request, controller.signal)
    } finally {
      clearTimeout(timer)
      this.inflight.delete(controller)
    }
  }

  /** `continue` 命中映射就复用；否则新建并写回映射。 */
  private async ensureSession(
    key: string,
    source: ReplySource,
    event: InboundMessage,
  ): Promise<{ sessionId: string }> {
    const state = this.deps.state()
    const mode = state.sessionMode
    if (mode === 'continue') {
      const mapped = state.sessions[key]
      if (mapped) return { sessionId: mapped.sessionId }
    }

    const created = await this.deps.sessions.create(this.createRequest(state))
    // `new` 模式每条消息都开新会话，映射保持原样；只有 `continue` 记最近一条。
    if (mode === 'continue') this.remember(key, created.sessionId)
    this.audit({ action: 'session-created', eventId: event.eventId, key, sessionId: created.sessionId })
    await this.retitle(created.sessionId, source)
    return { sessionId: created.sessionId }
  }

  private async retitle(sessionId: string, source: ReplySource): Promise<void> {
    const title =
      source.kind === 'group'
        ? `lanpost · 群 ${source.groupId ?? ''}`
        : `lanpost · ${source.name}`
    try {
      await this.deps.sessions.rename({ sessionId, title })
    } catch (error) {
      this.deps.log(`lanpost-bridge: rename session ${sessionId} failed: ${errorMessage(error)}`)
      this.audit({ action: 'rename-failed', sessionId, error: errorMessage(error) })
    }
  }

  /** 只在选定工作区时传 workspaceId；未选工作区交给宿主默认目录。 */
  private createRequest(state: BridgeState): { workspaceId?: string } {
    return state.workspaceId ? { workspaceId: state.workspaceId } : {}
  }

  /** `sessions` 整体替换，不原地改可能被共享的对象。 */
  private remember(key: string, sessionId: string): void {
    const updatedAt = new Date(this.deps.now ? this.deps.now() : Date.now()).toISOString()
    this.deps.update((state) => {
      state.sessions = { ...state.sessions, [key]: { sessionId, updatedAt } }
    })
  }

  private forget(key: string): void {
    this.deps.update((state) => {
      const sessions = { ...state.sessions }
      delete sessions[key]
      state.sessions = sessions
    })
  }

  /** 回一条提示。发送失败只进日志与审计（设计文档的失败矩阵）。 */
  private async reply(target: ReplyTarget, text: string): Promise<void> {
    try {
      await this.deps.send(target, text)
    } catch (error) {
      this.deps.log(`lanpost-bridge: reply to ${targetKey(target)} failed: ${errorMessage(error)}`)
      this.audit({ action: 'send-failed', target: targetKey(target), error: errorMessage(error) })
    }
  }

  private audit(detail: Record<string, unknown>): void {
    this.deps.audit?.('inbound', detail)
  }
}

/** 目标去重键：同一轮回发只向同一目标发一次。 */
function targetKey(target: ReplyTarget): string {
  return target.kind === 'user' ? `user:${target.protocolId}` : `group:${target.groupId}`
}

// 入站编排：`message.received` → 去重 → 过滤（私聊全放行 / 群 `/dsh`）→ 会话映射 → 串行队列 → `prompt`。
// 本文件不碰 DSH ctx：会话、发送、事件订阅全部经 `InboundDeps` 注入（Task 10 装配）。
// 回复收集与出站回发属于 Task 7，本任务只负责把消息交给会话。
import { randomUUID } from 'node:crypto'
import { QUEUE_LIMIT, SEEN_LIMIT, dedupeAdd, promptTextFor, stripGroupTrigger } from './core.ts'
import type { ReplySource } from './core.ts'
import type { InboundMessage } from './gateway.ts'
import type { SessionEventLike } from './harness.ts'
import type { BridgeState } from './store.ts'

// Task 7 从本文件消费会话事件类型；定义只有 harness.ts 一份，这里只再导出。
export type { SessionEventLike }

/** 私聊回退文案：v1 只处理文本。 */
export const IMAGE_NOTICE = '暂不支持图片消息（当前仅支持文本）。'
/** 未知 content 类型的回退文案。 */
export const UNSUPPORTED_NOTICE = '暂不支持该类型的消息（当前仅支持文本）。'
/** 群 `/dsh` 后没跟正文时的用法提示。 */
export const USAGE_NOTICE = '用法：/dsh <问题>'
/** 排队超限提示；条数与 `QUEUE_LIMIT` 保持同一来源。 */
export const QUEUE_FULL_NOTICE = `我这边还排着 ${QUEUE_LIMIT} 条消息，稍后再发。`

/** 单次 `prompt` 的等待上限（与设计文档的 30s 一致）。 */
const PROMPT_TIMEOUT_MS = 30_000
const PRIVATE_PREFIX = 'direct:'
const GROUP_PREFIX = 'group:'

/** 发消息的目标（与网关 `sendUser` / `sendGroup` 一一对应）。 */
export type ReplyTarget = { kind: 'user'; protocolId: string } | { kind: 'group'; groupId: string }

export interface InboundDeps {
  state(): BridgeState
  update(mutate: (state: BridgeState) => void): void
  sessions: {
    create(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string }>
    prompt(
      request: {
        requestId: string
        sessionId: string
        mode: 'queue'
        content: Array<{ type: 'text'; text: string }>
      },
      signal: AbortSignal,
    ): Promise<{ accepted: true }>
    rename(request: { sessionId: string; title: string }): Promise<unknown>
  }
  send(target: ReplyTarget, text: string): Promise<{ message_id: string; delivery_status: string }>
  onSessionEvent(handler: (sessionId: string, event: SessionEventLike) => void): () => void
  log(message: string): void
  now?(): number
  /** 审计出口；宿主侧接 `writeAudit(home, kind, detail)`。缺省不写（假 deps 测试）。 */
  audit?(kind: string, detail: Record<string, unknown>): void
}

interface PromptRequest {
  requestId: string
  sessionId: string
  mode: 'queue'
  content: Array<{ type: 'text'; text: string }>
}

/** 一条入站消息经判定后的处置方式。 */
type Plan =
  | { kind: 'drop'; reason: string }
  | { kind: 'notice'; key: string; target: ReplyTarget; text: string; source: ReplySource }
  | {
      kind: 'prompt'
      key: string
      target: ReplyTarget
      text: string
      source: ReplySource
    }

type PromptPlan = Extract<Plan, { kind: 'prompt' }>
type NoticePlan = Extract<Plan, { kind: 'notice' }>

/** 每个会话键一条 promise 链；`pending` 含正在执行的那条。 */
interface QueueSlot {
  pending: number
  tail: Promise<void>
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
  private readonly queues = new Map<string, QueueSlot>()
  private disposed = false

  constructor(deps: InboundDeps) {
    this.deps = deps
  }

  /** 处理一条 `message.received`。重复事件、被过滤的消息直接返回。 */
  async handleMessage(event: InboundMessage): Promise<void> {
    if (this.disposed) return
    if (!this.rememberSeen(event)) return

    const plan = this.plan(event)
    if (plan.kind === 'drop') {
      this.audit({ action: 'ignored', eventId: event.eventId, reason: plan.reason })
      return
    }

    this.audit({
      action: 'accepted',
      eventId: event.eventId,
      messageId: event.messageId,
      conversationType: event.conversationType,
      textBytes: Buffer.byteLength(plan.text, 'utf8'),
    })

    // 队列已满：不回队列里再排一条提示，直接发出并放弃这条。
    const slot = this.queues.get(plan.key)
    if (slot && slot.pending >= QUEUE_LIMIT) {
      this.audit({ action: 'queue-full', eventId: event.eventId, key: plan.key })
      await this.reply(plan.target, QUEUE_FULL_NOTICE)
      return
    }

    await this.enqueue(plan.key, async () => {
      if (plan.kind === 'notice') {
        const notice: NoticePlan = plan
        await this.reply(notice.target, notice.text)
        return
      }
      const promptPlan: PromptPlan = plan
      await this.process(promptPlan, event)
    })
  }

  /** 出站投递回执；v1 只把它写日志与审计，不回聊天。 */
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

  /** 停掉队列：已入队但未开始的任务不再执行，新消息一律丢弃。 */
  dispose(): void {
    this.disposed = true
    this.queues.clear()
  }

  // ── 判定 ────────────────────────────────────────────────────────────────

  /** 去重窗口同时记 `messageId` 与 `eventId`：先记 messageId 再前插 eventId。 */
  private rememberSeen(event: InboundMessage): boolean {
    let fresh = false
    this.deps.update((state) => {
      const first = dedupeAdd(state.seenEventIds, event.messageId, SEEN_LIMIT)
      let list = first.list
      let added = first.added
      if (event.eventId !== '' && event.eventId !== event.messageId) {
        const second = dedupeAdd(list, event.eventId, SEEN_LIMIT)
        list = second.list
        // eventId 已见过就是重复补发：即便 messageId 没记过也必须丢弃。
        added = second.added
      }
      // 用新数组整体替换，不原地改入参（`mergeSettings` 是浅拷贝，数组可能共享）。
      state.seenEventIds = list
      fresh = added
    })
    return fresh
  }

  private plan(event: InboundMessage): Plan {
    const self = this.deps.state().selfProtocolId
    if (self !== null && self !== '' && event.sender.protocolId === self) {
      return { kind: 'drop', reason: 'self-loop' }
    }

    const whoName = event.sender.displayName === '' ? event.sender.username : event.sender.displayName
    const content: { type: string; text?: string } = event.content
    const text = content.type === 'text' ? (content.text ?? '') : null

    if (event.conversationType === 'group') {
      const groupId = groupIdOf(event)
      if (!groupId) return { kind: 'drop', reason: 'missing-group-id' }

      const key = `${GROUP_PREFIX}${groupId}`
      const target: ReplyTarget = { kind: 'group', groupId }
      const source: ReplySource = {
        kind: 'group',
        name: whoName,
        username: event.sender.username,
        groupId,
      }

      if (text === null) return { kind: 'drop', reason: 'unsupported-content' }
      const stripped = stripGroupTrigger(text)
      if (stripped === null) return { kind: 'drop', reason: 'missing-trigger' }
      if (isBlank(stripped)) return { kind: 'notice', key, target, text: USAGE_NOTICE, source }
      return { kind: 'prompt', key, target, text: stripped, source }
    }

    const key = `${PRIVATE_PREFIX}${event.sender.protocolId}`
    const target: ReplyTarget = { kind: 'user', protocolId: event.sender.protocolId }
    const source: ReplySource = { kind: 'private', name: whoName, username: event.sender.username }

    if (text === null) {
      const notice = content.type === 'image' ? IMAGE_NOTICE : UNSUPPORTED_NOTICE
      return { kind: 'notice', key, target, text: notice, source }
    }
    if (isBlank(text)) return { kind: 'drop', reason: 'empty-text' }
    return { kind: 'prompt', key, target, text, source }
  }

  // ── 串行队列 ────────────────────────────────────────────────────────────

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    let slot = this.queues.get(key)
    if (!slot) {
      slot = { pending: 0, tail: Promise.resolve() }
      this.queues.set(key, slot)
    }
    const current = slot
    current.pending += 1

    const run = async (): Promise<void> => {
      try {
        if (this.disposed) return
        await task()
      } catch (error) {
        // 队列必须继续跑：错误写日志与审计，不把整条链堵死。
        this.deps.log(`lanpost-bridge: inbound task for ${key} failed: ${errorMessage(error)}`)
        this.audit({ action: 'queue-failed', key, error: errorMessage(error) })
      } finally {
        current.pending -= 1
        if (current.pending === 0 && this.queues.get(key) === current) this.queues.delete(key)
      }
    }

    const chain = current.tail.then(run, run)
    current.tail = chain
    return chain
  }

  // ── 处理 ────────────────────────────────────────────────────────────────

  private async process(plan: PromptPlan, event: InboundMessage): Promise<void> {
    let phase: 'session' | 'prompt' = 'session'
    try {
      const session = await this.ensureSession(plan.key, plan.source, event)
      phase = 'prompt'
      await this.deliver(plan, session.sessionId, event)
    } catch (error) {
      const text =
        phase === 'session'
          ? `创建会话失败：${errorMessage(error)}`
          : `会话忙或不可用：${errorMessage(error)}`
      this.deps.log(`lanpost-bridge: ${text}`)
      this.audit({
        action: 'failed',
        eventId: event.eventId,
        key: plan.key,
        phase,
        error: errorMessage(error),
      })
      await this.reply(plan.target, text)
    }
  }

  /** `continue` 命中映射就复用；否则新建并写回映射。 */
  private async ensureSession(
    key: string,
    source: ReplySource,
    event: InboundMessage,
  ): Promise<{ sessionId: string }> {
    const state = this.deps.state()
    if (state.sessionMode === 'continue') {
      const mapped = state.sessions[key]
      if (mapped) return { sessionId: mapped.sessionId }
    }

    const created = await this.deps.sessions.create(this.createRequest(state))
    this.remember(key, created.sessionId)
    this.audit({ action: 'session-created', eventId: event.eventId, key, sessionId: created.sessionId })
    await this.retitle(created.sessionId, source)
    return { sessionId: created.sessionId }
  }

  private async deliver(
    plan: PromptPlan,
    sessionId: string,
    event: InboundMessage,
  ): Promise<void> {
    try {
      await this.prompt(plan, sessionId)
      return
    } catch (error) {
      if (errorCode(error) !== 'session/not-found') throw error
      this.deps.log(`lanpost-bridge: session ${sessionId} for ${plan.key} is gone, recreating`)
      this.audit({ action: 'session-recreate', eventId: event.eventId, key: plan.key, sessionId })
      this.forget(plan.key)
    }

    // 会话在 GUI 里被删了：重建一次再投一遍，不把错误甩给用户。
    const recreated = await this.ensureSession(plan.key, plan.source, event)
    await this.prompt(plan, recreated.sessionId)
  }

  private async prompt(plan: PromptPlan, sessionId: string): Promise<void> {
    const request: PromptRequest = {
      requestId: `lanpost-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptTextFor(plan.source, plan.text) }],
    }

    // 用可清理的定时器而不是 AbortSignal.timeout：unref 不吊住进程，done 时清掉。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('lanpost-bridge: prompt timed out')), PROMPT_TIMEOUT_MS)
    timer.unref()
    try {
      await this.deps.sessions.prompt(request, controller.signal)
    } finally {
      clearTimeout(timer)
    }
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

  private createRequest(state: BridgeState): { workspaceId?: string; cwd?: string } {
    if (state.workspaceId) return { workspaceId: state.workspaceId }
    if (state.workspacePath) return { cwd: state.workspacePath }
    return {}
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

  /**
   * 回一条提示。发送本身是尽力而为：网关断线时没有第二条通道，
   * 失败只进日志与审计（设计文档的失败矩阵），不把队列打断。
   */
  private async reply(target: ReplyTarget, text: string): Promise<void> {
    try {
      await this.deps.send(target, text)
    } catch (error) {
      this.deps.log(`lanpost-bridge: reply to ${target.kind} failed: ${errorMessage(error)}`)
      this.audit({ action: 'send-failed', target: target.kind, error: errorMessage(error) })
    }
  }

  private audit(detail: Record<string, unknown>): void {
    this.deps.audit?.('inbound', detail)
  }
}

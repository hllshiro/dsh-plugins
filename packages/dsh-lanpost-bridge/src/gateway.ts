/**
 * lanpost 网关客户端：JSON-RPC 调用、事件分发、ACK 顺序推进、重连退避。
 *
 * 本模块只负责「与网关之间的网络层」，不碰 DSH ctx、不碰 store 持久化：
 * 收发经 GatewayEvents 交给上层；ACK 的持久化通过 onAck 回调由上层落盘。
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { SEEN_LIMIT, TEXT_MAX_BYTES, dedupeAdd } from './core.ts'

export type GatewayState = 'idle' | 'connecting' | 'connected' | 'error'

export interface GatewayStatus {
  state: GatewayState
  since: number
  /** 失败原因（连接/认证/握手错误）；成功连接时通常为空。 */
  error?: string
  /** 需要告知上层但不算失败的提示（如游标重置、可能缺历史事件）。 */
  notice?: string
}

export interface InboundSender {
  protocolId: string
  username: string
  displayName: string
}

export type InboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; name: string }

export interface InboundMessage {
  eventId: string
  sequence: number
  messageId: string
  conversationId: string
  conversationType: 'private' | 'group'
  groupId?: string
  sender: InboundSender
  content: InboundContent
  timestamp: string
}

export interface DeliveryStatus {
  messageId: string
  status: string
  reason?: string
}

export interface GatewayEvents {
  /** 可以返回 Promise：处理持久化完成之前不会 ACK。 */
  onMessage?: (message: InboundMessage) => void | Promise<void>
  onDelivery?: (status: DeliveryStatus) => void | Promise<void>
  onState?: (status: GatewayStatus) => void
  /** 网关确认 ACK（acked:true）后调用，供上层落盘 lastSequence。 */
  onAck?: (sequence: number) => void
}

export interface GatewayTransport {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open' | 'close' | 'message' | 'error', listener: (arg: any) => void): void
}

export interface GatewayOptions {
  url: string
  token: string
  /** 已持久化的最后 ACK 序号；首次连接用 0。 */
  lastSequence?: number
  events?: GatewayEvents
  /** 测试注入；缺省时用 createTransport(url) 建真实 WebSocket。 */
  transport?: GatewayTransport
  /** 诊断日志（ACK 失败、重连、协议异常都走这里，不吞错）。 */
  log?: (message: string) => void
  /** 重连退避基数（默认 1000ms；测试可调小，别在生产改）。 */
  reconnectBaseMs?: number
  /** 重连退避上限（默认 30000ms）。 */
  reconnectMaxMs?: number
}

export interface SendResult {
  message_id: string
  delivery_status?: string
}

export class GatewayError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.data = data
  }
}

/** 本地错误（非网关返回）统一用 -32000，网关错误码原样透传。 */
const LOCAL_ERROR_CODE = -32000
const LOGIN_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 10_000
const RESUME_TIMEOUT_MS = 15_000
const ACK_TIMEOUT_MS = 10_000
const SEND_TIMEOUT_MS = 30_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** 4409 连接数超限：从第 3 档（默认 8s）起步，避免 1s 内反复撞。 */
const RATE_LIMIT_BACKOFF_ATTEMPT = 3

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface ResumePayload {
  latestSequence: number
  events: unknown[]
}

/** 重连退避：base 起翻倍、封顶 max，±20% 抖动后再夹到上限。导出便于单测。 */
export function backoffDelay(
  attempt: number,
  baseMs: number = RECONNECT_BASE_MS,
  maxMs: number = RECONNECT_MAX_MS,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxMs, baseMs * 2 ** attempt)
  const jitter = base * 0.2
  return Math.round(Math.min(maxMs, base - jitter + random() * jitter * 2))
}

export function createTransport(url: string): GatewayTransport {
  const socket = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10_000 })
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (event, listener) => {
      if (event === 'message') {
        socket.on('message', (data: { toString(): string }) => listener(data.toString()))
      } else if (event === 'close') {
        socket.on('close', (code: number, reason: { toString(): string }) =>
          listener({ code, reason: reason.toString() }),
        )
      } else if (event === 'error') {
        socket.on('error', (error: Error) => listener(error))
      } else {
        socket.on('open', () => listener(undefined))
      }
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toGatewayError(error: unknown, fallback: string): GatewayError {
  if (error instanceof GatewayError) return error
  return new GatewayError(LOCAL_ERROR_CODE, `${fallback}：${describe(error)}`)
}

function parseResume(result: unknown): ResumePayload {
  const record = asRecord(result)
  if (typeof record.latest_sequence !== 'number') {
    throw new GatewayError(-32603, 'events.resume 返回缺少 latest_sequence')
  }
  const events = record.events === undefined ? [] : record.events
  if (!Array.isArray(events)) {
    throw new GatewayError(-32603, 'events.resume 返回的 events 不是数组')
  }
  return { latestSequence: record.latest_sequence, events }
}

function parseSendResult(result: unknown): SendResult {
  const record = asRecord(result)
  const messageId = asString(record.message_id)
  if (!messageId) throw new GatewayError(-32603, '发送接口返回缺少 message_id')
  const parsed: SendResult = { message_id: messageId }
  const deliveryStatus = asString(record.delivery_status)
  if (deliveryStatus) parsed.delivery_status = deliveryStatus
  return parsed
}

export class LanpostGateway {
  private readonly url: string
  private readonly token: string
  private readonly events: GatewayEvents
  private readonly log: (message: string) => void
  private readonly transportFactory: () => GatewayTransport
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number

  private socket: GatewayTransport | null = null
  private state: GatewayState = 'idle'
  private since = Date.now()
  private lastError: string | undefined
  private notice: string | undefined
  private stopped = false
  /** 登录被拒绝等不可恢复错误：不再自动重连，等上层显式 restart。 */
  private fatal = false

  /** 已连续接收（处理完成）的最大序号。 */
  private lastReceived: number
  /** 网关已确认（acked:true）的最大序号；resume 以它为 last_sequence。 */
  private lastAcked: number
  /** 已接收但尚未确认的 event_id（连续区间 lastAcked+1 .. lastReceived）。 */
  private readonly ackBacklog = new Map<number, string>()
  private ackChain: Promise<void> = Promise.resolve()
  /** 游标代次：resetCursor / confirmUpTo 会让在途 ACK 的结果失效，防止复活/回退 lastAcked。 */
  private ackEpoch = 0

  private nextRequestId = 1
  private readonly pending = new Map<number, PendingCall>()
  private seenEventIds: string[] = []
  private notificationChain: Promise<void> = Promise.resolve()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  constructor(options: GatewayOptions) {
    this.url = options.url
    this.token = options.token
    this.events = options.events ?? {}
    this.log = options.log ?? (() => {})
    this.lastAcked = options.lastSequence ?? 0
    this.lastReceived = this.lastAcked
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS
    const injected = options.transport
    this.transportFactory = injected ? () => injected : () => createTransport(this.url)
  }

  status(): GatewayStatus {
    return {
      state: this.state,
      since: this.since,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  start(): void {
    if (this.stopped) {
      this.stopped = false
      this.reconnectAttempt = 0
    }
    this.fatal = false
    this.notice = undefined
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket !== null) return
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    this.rejectPending(new GatewayError(LOCAL_ERROR_CODE, '连接已关闭'))
    if (socket !== null) {
      try {
        socket.close()
      } catch (error) {
        this.log(`关闭连接失败：${describe(error)}`)
      }
    }
    this.setState('idle')
  }

  /** JSON-RPC 调用；超时、连接关闭、网关错误都 reject 成 GatewayError。 */
  call<T = unknown>(method: string, params?: unknown, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
    const socket = this.socket
    if (socket === null || this.stopped || this.fatal) {
      return Promise.reject(new GatewayError(LOCAL_ERROR_CODE, '连接已关闭'))
    }
    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new GatewayError(LOCAL_ERROR_CODE, `请求超时：${method}（${timeoutMs}ms）`))
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      })
      const frame: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params !== undefined) frame.params = params
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(toGatewayError(error, `请求发送失败：${method}`))
      }
    })
  }

  async sendUser(protocolId: string, text: string): Promise<SendResult> {
    this.assertTextSize(text)
    const result = await this.call<unknown>(
      'message.sendUser',
      { request_id: randomUUID(), protocol_id: protocolId, content: { type: 'text', text } },
      SEND_TIMEOUT_MS,
    )
    return parseSendResult(result)
  }

  async sendGroup(groupId: string, text: string): Promise<SendResult> {
    this.assertTextSize(text)
    const result = await this.call<unknown>(
      'message.sendGroup',
      { request_id: randomUUID(), group_id: groupId, content: { type: 'text', text } },
      SEND_TIMEOUT_MS,
    )
    return parseSendResult(result)
  }

  /**
   * 登记一个已处理完的 sequence 并触发连续 ACK。
   * 旧序号（≤ lastAcked）直接忽略，避免迟到/重投事件在内存里无界堆积。
   */
  noteEvent(sequence: number, eventId?: string): void {
    if (!Number.isInteger(sequence) || sequence <= 0) {
      this.log(`忽略非法 sequence：${String(sequence)}`)
      return
    }
    if (sequence <= this.lastAcked) return
    // 重置/清空后重投的事件也要能重新带回 event_id；已在 backlog 的不覆盖。
    if (!this.ackBacklog.has(sequence)) {
      this.ackBacklog.set(sequence, eventId ?? '')
      while (this.ackBacklog.has(this.lastReceived + 1)) this.lastReceived += 1
    }
    void this.queueAckFlush()
  }

  private assertTextSize(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > TEXT_MAX_BYTES) {
      throw new GatewayError(
        LOCAL_ERROR_CODE,
        `消息超过 16 KiB 上限（${bytes} 字节），未发送`,
      )
    }
  }

  /** 串行排空 ACK 队列：同一时刻只有一个 events.ack 在途。 */
  private queueAckFlush(): Promise<void> {
    const next = this.ackChain.then(() => this.flushAcks())
    this.ackChain = next.catch((error: unknown) => {
      this.log(`ACK 队列异常：${describe(error)}`)
    })
    return this.ackChain
  }

  private async flushAcks(): Promise<void> {
    while (!this.stopped && this.socket !== null && this.lastAcked < this.lastReceived) {
      const sequence = this.lastAcked + 1
      const eventId = this.ackBacklog.get(sequence) ?? ''
      const epoch = this.ackEpoch
      let acked = false
      try {
        const result = await this.call<unknown>(
          'events.ack',
          { event_id: eventId, sequence },
          ACK_TIMEOUT_MS,
        )
        acked = asRecord(result).acked === true
      } catch (error) {
        this.log(`ACK 失败（sequence ${sequence}）：${describe(error)}`)
      }
      if (epoch !== this.ackEpoch) {
        // 游标被重置/前移：这是迟到的结果，丢弃；backlog 留待按序重发（ACK 幂等）。
        this.log(`ACK 结果已过期（sequence ${sequence}），丢弃并保留待重发`)
        return
      }
      if (!acked) {
        // 保留 event_id，下次连接先按序重发；ACK 幂等。
        this.log(`ACK 未被确认（sequence ${sequence}），保留待重发`)
        return
      }
      if (sequence !== this.lastAcked + 1) {
        this.log(`ACK 结果序号不符（sequence ${sequence}），保留待重发`)
        return
      }
      this.ackBacklog.delete(sequence)
      this.lastAcked = sequence
      this.emitAck(sequence)
    }
  }

  private emitAck(sequence: number): void {
    try {
      this.events.onAck?.(sequence)
    } catch (error) {
      this.log(`onAck 回调失败：${describe(error)}`)
    }
  }

  private connect(): void {
    if (this.stopped || this.fatal) return
    this.setState('connecting')
    let transport: GatewayTransport
    try {
      transport = this.transportFactory()
    } catch (error) {
      this.onHandshakeFailure(error)
      return
    }
    this.socket = transport
    transport.on('open', () => void this.handshake(transport))
    transport.on('message', (data) => this.onFrame(data))
    transport.on('close', (info) => this.onClose(transport, info))
    transport.on('error', (error) => this.onTransportError(error))
  }

  /**
   * 严格串行握手：login(必须 true) → subscribe → 重发未确认 ACK → resume(lastAcked)。
   * resume 帧发出前才捕获基线，避免握手期间到达的事件抬高基线造成误判。
   */
  private async handshake(transport: GatewayTransport): Promise<void> {
    this.notice = undefined
    try {
      const loginResult = await this.call<unknown>('rpc.login', { token: this.token }, LOGIN_TIMEOUT_MS)
      if (transport !== this.socket) return
      if (loginResult !== true) {
        this.failAuth()
        return
      }

      await this.call('subscribe', ['message.received', 'message.deliveryStatus'], RPC_TIMEOUT_MS)
      if (transport !== this.socket) return

      // 上次连接里没收到的 ACK 先按序补发（幂等），再以 lastAcked 续传。
      await this.queueAckFlush()
      if (transport !== this.socket) return

      const cursorBefore = this.lastReceived
      let payload: ResumePayload
      let resumedFromScratch = false
      try {
        payload = parseResume(
          await this.call<unknown>('events.resume', { last_sequence: this.lastAcked }, RESUME_TIMEOUT_MS),
        )
      } catch (error) {
        const gatewayError = toGatewayError(error, 'events.resume 失败')
        if (gatewayError.code !== -32020) throw gatewayError
        payload = await this.resumeFromScratch('EVENT_CURSOR_EXPIRED')
        resumedFromScratch = true
        if (transport !== this.socket) return
      }
      if (!resumedFromScratch && payload.latestSequence < cursorBefore) {
        payload = await this.resumeFromScratch('latest_sequence 小于本地游标')
        if (transport !== this.socket) return
      }

      for (const envelope of payload.events) await this.enqueueNotification(envelope)
      if (transport !== this.socket) return
      if (payload.events.length === 0) this.confirmUpTo(payload.latestSequence)
      this.finishHandshake()
    } catch (error) {
      if (transport !== this.socket) return
      this.onHandshakeFailure(error)
    }
  }

  /** -32020 / 游标倒挂：重置为 0 后在同一次握手里只重试一次（再失败走重连）。 */
  private async resumeFromScratch(reason: string): Promise<ResumePayload> {
    this.resetCursor(reason)
    return parseResume(
      await this.call<unknown>('events.resume', { last_sequence: 0 }, RESUME_TIMEOUT_MS),
    )
  }

  private resetCursor(reason: string): void {
    this.lastAcked = 0
    this.lastReceived = 0
    this.ackBacklog.clear()
    this.ackEpoch += 1
    this.notice = `事件游标不连续（${reason}），已重置为 0 并在本次连接重新 resume；可能缺历史事件`
    this.log(this.notice)
  }

  /** 空 events 表示没有待补事件：把游标推进到网关确认的 latest_sequence。 */
  private confirmUpTo(latest: number): void {
    if (latest <= this.lastAcked) return
    // 实时事件已越过 resume 返回的 latest：不能清 backlog，否则这些事件的 event_id 会丢。
    if (latest < this.lastReceived) return
    this.lastReceived = latest
    this.ackBacklog.clear()
    this.ackEpoch += 1
    this.lastAcked = latest
    this.emitAck(latest)
  }

  private finishHandshake(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    this.fatal = false
    this.setState('connected')
  }

  private failAuth(): void {
    this.fatal = true
    const socket = this.socket
    this.socket = null
    this.rejectPending(new GatewayError(-32001, '令牌无效，无法登录'))
    this.setState('error', '登录被拒绝：令牌无效')
    if (socket !== null) {
      try {
        socket.close(4401, 'token invalid')
      } catch (error) {
        this.log(`关闭连接失败：${describe(error)}`)
      }
    }
  }

  private onHandshakeFailure(error: unknown): void {
    const gatewayError = toGatewayError(error, '握手失败')
    this.log(`握手失败：${gatewayError.message}`)
    const socket = this.socket
    this.socket = null
    this.rejectPending(gatewayError)
    this.setState('error', `握手失败：${gatewayError.message}`)
    if (socket !== null) {
      try {
        socket.close(4001, 'handshake failed')
      } catch {
        // 关闭失败不影响重连调度
      }
    }
    this.scheduleReconnect()
  }

  private onFrame(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : String(raw)
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      this.log('收到无法解析的帧，已忽略')
      return
    }
    const record = asRecord(frame)
    if (record.id !== undefined) {
      const id = typeof record.id === 'number' ? record.id : Number(record.id)
      if (!Number.isFinite(id)) return
      const call = this.pending.get(id)
      if (call === undefined) return
      this.pending.delete(id)
      clearTimeout(call.timer)
      if (record.error !== undefined) {
        call.reject(this.serverError(asRecord(record.error)))
        return
      }
      call.resolve(record.result)
      return
    }
    if (typeof record.method === 'string') {
      void this.enqueueNotification(record)
      return
    }
    this.log('收到既无 id 也无 method 的帧，已忽略')
  }

  private serverError(error: Record<string, unknown>): GatewayError {
    const code = typeof error.code === 'number' ? error.code : -32603
    const message = asString(error.message) || '网关返回了未知错误'
    return new GatewayError(code, message, error.data)
  }

  /** 通知串行处理：async handler 落地后才推进序号、发 ACK。 */
  private enqueueNotification(envelope: unknown): Promise<void> {
    const task = this.notificationChain.then(() => this.dispatchNotification(envelope))
    this.notificationChain = task.catch((error: unknown) => {
      this.log(`通知处理异常：${describe(error)}`)
    })
    return this.notificationChain
  }

  /** 真实通知是 {method, params:{event_id,sequence,method,data}}；resume 里的事件已是信封本身。 */
  private async dispatchNotification(envelope: unknown): Promise<void> {
    const raw = asRecord(envelope)
    const record = raw.params === undefined ? raw : asRecord(raw.params)
    const sequence = record.sequence
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0) {
      this.log('事件缺少合法 sequence，无法 ACK，已忽略')
      return
    }
    const eventId = asString(record.event_id) || undefined
    const method = asString(raw.method) || asString(record.method)
    const data = asRecord(record.data ?? asRecord(record.params).data)

    let firstDelivery = true
    if (eventId !== undefined) {
      const dedupe = dedupeAdd(this.seenEventIds, eventId, SEEN_LIMIT)
      this.seenEventIds = dedupe.list
      firstDelivery = dedupe.added
    }

    if (firstDelivery) {
      try {
        if (method === 'message.received') {
          await this.events.onMessage?.(this.toInboundMessage(data, sequence, eventId))
        } else if (method === 'message.deliveryStatus') {
          await this.events.onDelivery?.(this.toDeliveryStatus(data))
        } else {
          this.log(`忽略未知通知方法：${method}`)
        }
      } catch (error) {
        // 处理失败也要 ACK（否则事件永远重投），由上层去重/补偿。
        this.log(`处理通知失败（sequence ${sequence}）：${describe(error)}`)
      }
    }
    this.noteEvent(sequence, eventId)
  }

  private toInboundMessage(
    data: Record<string, unknown>,
    sequence: number,
    eventId: string | undefined,
  ): InboundMessage {
    const sender = asRecord(data.sender)
    const content = asRecord(data.content)
    const groupId = asString(data.group_id)
    const message: InboundMessage = {
      eventId: eventId ?? '',
      sequence,
      messageId: asString(data.message_id),
      conversationId: asString(data.conversation_id),
      conversationType: asString(data.conversation_type) === 'group' ? 'group' : 'private',
      sender: {
        protocolId: asString(sender.protocol_id),
        username: asString(sender.username),
        displayName: asString(sender.display_name) || asString(sender.username),
      },
      content:
        asString(content.type) === 'image'
          ? { type: 'image', mimeType: asString(content.mime_type), name: asString(content.name) }
          : { type: 'text', text: asString(content.text) },
      timestamp: asString(data.timestamp),
    }
    if (groupId) message.groupId = groupId
    return message
  }

  private toDeliveryStatus(data: Record<string, unknown>): DeliveryStatus {
    const status: DeliveryStatus = {
      messageId: asString(data.message_id),
      status: asString(data.status),
    }
    const reason = asString(data.reason)
    if (reason) status.reason = reason
    return status
  }

  private onClose(transport: GatewayTransport, info: unknown): void {
    if (transport !== this.socket) return
    this.socket = null
    this.rejectPending(new GatewayError(LOCAL_ERROR_CODE, '连接已关闭'))
    if (this.stopped) return
    const code = typeof asRecord(info).code === 'number' ? (asRecord(info).code as number) : undefined
    if (code === 4401) {
      this.fatal = true
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.setState('error', '令牌已轮换，请更新令牌')
      return
    }
    if (code === 4409) {
      this.reconnectAttempt = Math.max(this.reconnectAttempt, RATE_LIMIT_BACKOFF_ATTEMPT)
      this.setState('error', '连接数超限')
      this.scheduleReconnect()
      return
    }
    this.setState('error', `连接已断开（code ${code ?? '未知'}），准备重连`)
    this.scheduleReconnect()
  }

  private onTransportError(error: unknown): void {
    this.log(`连接错误：${describe(error)}`)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatal || this.reconnectTimer !== null) return
    const delay = backoffDelay(
      this.reconnectAttempt,
      this.reconnectBaseMs,
      this.reconnectMaxMs,
      Math.random,
    )
    this.reconnectAttempt += 1
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && !this.fatal) this.connect()
    }, delay)
    ;(timer as { unref?: () => void }).unref?.()
    this.reconnectTimer = timer
    this.log(`将在 ${Math.round(delay)}ms 后重连（第 ${this.reconnectAttempt} 次）`)
  }

  private rejectPending(error: GatewayError): void {
    const calls = [...this.pending.values()]
    this.pending.clear()
    for (const call of calls) {
      clearTimeout(call.timer)
      call.reject(error)
    }
  }

  private setState(state: GatewayState, error?: string): void {
    if (this.state === state && this.lastError === error) return
    this.state = state
    this.lastError = error
    this.since = Date.now()
    const snapshot = this.status()
    try {
      this.events.onState?.(snapshot)
    } catch (errorOnState) {
      this.log(`onState 回调失败：${describe(errorOnState)}`)
    }
  }
}

/**
 * lanpost 网关客户端：JSON-RPC 调用、事件分发、ACK 顺序推进、重连退避。
 *
 * 本模块只负责「与网关之间的网络层」，不碰 DSH ctx、不碰 store 持久化：
 * 收发的消息经 GatewayEvents 交给上层，游标 lastSequence 由调用方在重连时传回。
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { SEEN_LIMIT, TEXT_MAX_BYTES, dedupeAdd } from './core.ts'

export type GatewayState = 'idle' | 'connecting' | 'connected' | 'error'

export interface GatewayStatus {
  state: GatewayState
  since: number
  error?: string
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
  onMessage?: (message: InboundMessage) => void
  onDelivery?: (status: DeliveryStatus) => void
  onState?: (status: GatewayStatus) => void
}

export interface GatewayTransport {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open' | 'close' | 'message' | 'error', listener: (arg: any) => void): void
}

export interface GatewayOptions {
  url: string
  token: string
  lastSequence?: number
  events?: GatewayEvents
  /** 测试注入；缺省时用 createTransport(url) 建真实 WebSocket。 */
  transport?: GatewayTransport
  /** 诊断日志（ACK 失败、重连、协议异常都走这里，不吞错）。 */
  log?: (message: string) => void
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

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: ReturnType<typeof setTimeout>
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

function toGatewayError(error: unknown, fallback: string): GatewayError {
  if (error instanceof GatewayError) return error
  if (error instanceof Error) return new GatewayError(LOCAL_ERROR_CODE, `${fallback}：${error.message}`)
  return new GatewayError(LOCAL_ERROR_CODE, `${fallback}：${String(error)}`)
}

function parseResume(result: unknown): { latestSequence: number; events: unknown[] } {
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

  private socket: GatewayTransport | null = null
  private state: GatewayState = 'idle'
  private since = Date.now()
  private lastError: string | undefined
  private stopped = false
  /** 登录被拒绝等不可恢复错误：不再自动重连，等上层显式 restart。 */
  private fatal = false

  /** 已成功 ACK 的游标；下一条待 ACK 的是 cursor + 1。 */
  private cursor: number
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingCall>()
  /** sequence -> event_id，noteEvent 推进连续段时取用。 */
  private readonly eventIds = new Map<number, string>()
  private seenEventIds: string[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private cursorNotice: string | undefined

  constructor(options: GatewayOptions) {
    this.url = options.url
    this.token = options.token
    this.events = options.events ?? {}
    this.log = options.log ?? (() => {})
    this.cursor = options.lastSequence ?? 0
    const injected = options.transport
    this.transportFactory = injected ? () => injected : () => createTransport(this.url)
  }

  status(): GatewayStatus {
    return {
      state: this.state,
      since: this.since,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }

  start(): void {
    if (this.stopped) {
      this.stopped = false
      this.reconnectAttempt = 0
    }
    this.fatal = false
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
    this.eventIds.clear()
    if (socket !== null) {
      try {
        socket.close()
      } catch (error) {
        this.log(`关闭连接失败：${error instanceof Error ? error.message : String(error)}`)
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
   * 登记一个已收到的 sequence 并推进连续 ACK。
   * 测试直接调用；真实链路里由 dispatchNotification 调用。
   */
  noteEvent(sequence: number, eventId?: string): void {
    if (!Number.isInteger(sequence) || sequence <= 0) {
      this.log(`忽略非法 sequence：${String(sequence)}`)
      return
    }
    const existing = this.eventIds.get(sequence)
    this.eventIds.set(sequence, eventId ?? existing ?? '')
    while (this.eventIds.has(this.cursor + 1)) {
      const next = this.cursor + 1
      const id = this.eventIds.get(next) ?? ''
      this.eventIds.delete(next)
      this.cursor = next
      this.sendAck(next, id)
    }
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

  private sendAck(sequence: number, eventId: string): void {
    // ACK 失败不回滚游标、不抛：至少一次投递由上层事件去重兜底。
    void this.call('events.ack', { event_id: eventId, sequence }, ACK_TIMEOUT_MS).catch((error: unknown) => {
      this.log(`ACK 失败（sequence ${sequence}）：${error instanceof Error ? error.message : String(error)}`)
    })
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
   * 握手：三帧一次性按 login → subscribe → resume 顺序写出（帧顺序在协议上已经足够，
   * 服务端按序处理），再依次等结果；login 只接受严格 true。
   */
  private async handshake(transport: GatewayTransport): Promise<void> {
    const login = this.call<unknown>('rpc.login', { token: this.token }, LOGIN_TIMEOUT_MS)
    const subscribe = this.call('subscribe', ['message.received', 'message.deliveryStatus'], RPC_TIMEOUT_MS)
    const resume = this.call<unknown>('events.resume', { last_sequence: this.cursor }, RESUME_TIMEOUT_MS)
    // 任一帧先失败时，其余结果也要有人接住，避免 unhandled rejection。
    login.catch(() => {})
    subscribe.catch(() => {})
    resume.catch(() => {})

    try {
      const loginResult = await login
      if (transport !== this.socket) return
      if (loginResult !== true) {
        this.failAuth()
        return
      }
      await subscribe
      if (transport !== this.socket) return

      const cursorBefore = this.cursor
      let payload: { latestSequence: number; events: unknown[] }
      try {
        payload = parseResume(await resume)
      } catch (error) {
        const gatewayError = toGatewayError(error, 'events.resume 失败')
        if (gatewayError.code === -32020) {
          this.resetCursor('EVENT_CURSOR_EXPIRED')
          this.finishHandshake()
          return
        }
        throw gatewayError
      }
      for (const envelope of payload.events) this.dispatchNotification(envelope)
      if (payload.latestSequence < cursorBefore) {
        this.resetCursor('latest_sequence 小于本地游标')
      }
      this.finishHandshake()
    } catch (error) {
      if (transport !== this.socket) return
      this.onHandshakeFailure(error)
    }
  }

  private finishHandshake(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    this.fatal = false
    this.setState('connected', this.cursorNotice)
    this.cursorNotice = undefined
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
        this.log(`关闭连接失败：${error instanceof Error ? error.message : String(error)}`)
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
      this.dispatchNotification(record)
      return
    }
    this.log('收到既无 id 也无 method 的帧，已忽略')
  }

  private serverError(error: Record<string, unknown>): GatewayError {
    const code = typeof error.code === 'number' ? error.code : -32603
    const message = asString(error.message) || '网关返回了未知错误'
    return new GatewayError(code, message, error.data)
  }

  /** 真实通知是 {method, params:{event_id,sequence,method,data}}；resume 里的事件已是信封本身。 */
  private dispatchNotification(envelope: unknown): void {
    const raw = asRecord(envelope)
    const record = raw.params === undefined ? raw : asRecord(raw.params)
    const sequence = record.sequence
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0) {
      this.log('事件缺少合法 sequence，无法 ACK，已忽略')
      return
    }
    const eventId = asString(record.event_id) || undefined
    if (eventId !== undefined) {
      this.eventIds.set(sequence, eventId)
      const dedupe = dedupeAdd(this.seenEventIds, eventId, SEEN_LIMIT)
      this.seenEventIds = dedupe.list
      if (!dedupe.added) {
        // 网关重投：不重复交给上层，但仍推进 ACK。
        this.noteEvent(sequence, eventId)
        return
      }
    }
    const method = asString(raw.method) || asString(record.method)
    const data = asRecord(record.data ?? asRecord(record.params).data)
    try {
      if (method === 'message.received') {
        this.events.onMessage?.(this.toInboundMessage(record, data, sequence, eventId))
      } else if (method === 'message.deliveryStatus') {
        this.events.onDelivery?.(this.toDeliveryStatus(data))
      } else {
        this.log(`忽略未知通知方法：${method}`)
      }
    } catch (error) {
      this.log(`处理通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.noteEvent(sequence, eventId)
  }

  private toInboundMessage(
    record: Record<string, unknown>,
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
      this.setState('error', '连接数超限')
      this.scheduleReconnect()
      return
    }
    this.setState('error', `连接已断开（code ${code ?? '未知'}），准备重连`)
    this.scheduleReconnect()
  }

  private onTransportError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.log(`连接错误：${detail}`)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatal || this.reconnectTimer !== null) return
    const delay = this.backoffDelay()
    this.reconnectAttempt += 1
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && !this.fatal) this.connect()
    }, delay)
    ;(timer as { unref?: () => void }).unref?.()
    this.reconnectTimer = timer
    this.log(`将在 ${Math.round(delay)}ms 后重连（第 ${this.reconnectAttempt} 次）`)
  }

  private backoffDelay(): number {
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    const jitter = base * 0.2
    return Math.round(base - jitter + Math.random() * jitter * 2)
  }

  private resetCursor(reason: string): void {
    this.cursor = 0
    this.eventIds.clear()
    this.cursorNotice = `事件游标不连续（${reason}），已重置为 0，下次连接从头续传`
    this.log(this.cursorNotice)
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
      this.log(`onState 回调失败：${errorOnState instanceof Error ? errorOnState.message : String(errorOnState)}`)
    }
  }
}

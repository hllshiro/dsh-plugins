// lanpost-bridge 的三个 agent 工具：发送消息、查找联系人、查看桥接状态。
//
// 工具对象是手写 JSON Schema 的 ToolDefinitionLike（见 harness.ts）；不 import `defineTool`，
// 也不 import 任何 `@deepseek-ai/*`。注册由 index.ts 的装配层负责，这里只负责定义与行为。
//
// 失败约定：参数校验失败与 GatewayError 都返回 `{ ok: false, error, code }`，工具本身不抛
// （这是给模型的正常结果，不是崩溃）；其他异常照旧抛出，不吞错、不重试。
// 状态工具只做脱敏投影，绝不返回令牌原文。

import { TEXT_MAX_BYTES } from './core.ts'
import { GatewayError } from './gateway.ts'
import type { GatewayStatus, SendResult } from './gateway.ts'
import type { ToolDefinitionLike } from './harness.ts'
import type { PublicSettings } from './store.ts'

/** createTools 依赖的网关能力；LanpostGateway 在结构上满足这个接口。 */
export interface ToolsGateway {
  status(): GatewayStatus
  sendUser(protocolId: string, text: string): Promise<SendResult>
  sendGroup(groupId: string, text: string): Promise<SendResult>
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
}

/** 状态工具需要的桥接投影；刻意不含会话内容，更不含令牌。 */
export interface ToolsStateSummary {
  lastSequence: number
  sessions: number
}

/** 工具依赖：网关按需取（未启用/未配置时为 undefined）、公开设置与只读状态投影。 */
export interface ToolsDeps {
  gateway(): ToolsGateway | undefined
  settings(): PublicSettings
  state?(): ToolsStateSummary
}

/** 联系人结果上限（与 users.list 的 page_size 一致）。 */
const CONTACT_LIMIT = 20
/** users.list 的超时与网关约定一致（10s）。 */
const USERS_TIMEOUT_MS = 10_000
/** 本地参数错误代码；数字代码保留给网关 JSON-RPC 错误。 */
const INVALID_ARGS = 'invalid_args'
const NOT_CONNECTED = 'not_connected'
const BAD_RESPONSE = 'bad_response'

interface ToolFailure {
  ok: false
  error: string
  code: number | string
}

interface SendSuccess {
  ok: true
  messageId: string
  /** 网关没返回投递状态时为 null，不伪造成某个状态值。 */
  deliveryStatus: string | null
}

interface Contact {
  protocol_id: string
  username: string
  display_name: string
  online: boolean
  last_seen_at: string | null
}

interface FindSuccess {
  ok: true
  contacts: Contact[]
  truncated: boolean
}

interface StatusConnection {
  state: GatewayStatus['state']
  since?: number
  error?: string
  notice?: string
}

interface StatusValue {
  enabled: boolean
  gatewayUrl: string
  connection: StatusConnection
  lastSequence: number | null
  tokenSet: boolean
  sessionMode: PublicSettings['sessionMode']
  showProcess: boolean
  sessions: number | null
  selfProtocolId: string | null
}

interface SendArgs {
  target: 'user' | 'group'
  id: string
  content: string
}

interface FindArgs {
  keyword: string
  onlineOnly: boolean
}

type Validated<T> = { ok: true; value: T } | ToolFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function failure(error: string, code: number | string = INVALID_ARGS): ToolFailure {
  return { ok: false, error, code }
}

function notConnected(): ToolFailure {
  return {
    ok: false,
    error: 'lanpost 网关未连接：桥接未启用或连接尚未建立',
    code: NOT_CONNECTED,
  }
}

function gatewayFailure(error: GatewayError): ToolFailure {
  return { ok: false, error: error.message, code: error.code }
}

/** 与 bridge.ts 的展示净化同源：控制字符折叠成空格，避免网关文本破坏工具输出的行结构。 */
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F]/g
const DISPLAY_MAX = 200

function oneLine(value: unknown, max = DISPLAY_MAX): string {
  const text = typeof value === 'string' ? value : ''
  const cleaned = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...cleaned]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : cleaned
}

/** 错误码来源标签：数字是网关 JSON-RPC 错误码，字符串是本地或网关响应检查出的代码。 */
function codeLabel(code: number | string): string {
  if (typeof code === 'number') return `网关错误码 ${code}`
  if (code === INVALID_ARGS) return '参数错误（本地）'
  if (code === NOT_CONNECTED) return '网关未连接（本地）'
  if (code === BAD_RESPONSE) return '响应格式异常（网关返回）'
  return `本地错误（${code}）`
}

function failureHint(code: number | string): string {
  if (code === INVALID_ARGS) {
    return '\n参数格式：target=user 时提供 protocol_id；target=group 时提供 group_id；content 为 1–16 KiB 的文本。'
  }
  if (code === NOT_CONNECTED) {
    return '\n请先在 设置 → lanpost 连接 中启用桥接并确认网关已连接，再重试。'
  }
  if (code === BAD_RESPONSE) {
    return '\n网关返回的数据不符合预期，请重试或查看 lanpost_bridge_status。'
  }
  return '\n这是网关返回的失败，请检查目标 id 与网关状态后重试。'
}

function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key))
}

// ---------------------------------------------------------------------------
// lanpost_send_message

const SEND_KEYS = ['target', 'protocol_id', 'group_id', 'content'] as const

const SEND_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['user', 'group'],
      description: 'user=私聊（配 protocol_id）；group=群聊（配 group_id）',
    },
    protocol_id: {
      type: 'string',
      description: '私聊接收人的 protocol_id；target=user 时必填',
    },
    group_id: {
      type: 'string',
      description: '群会话的 group_id；target=group 时必填',
    },
    content: {
      type: 'string',
      description: '要发送的文本，UTF-8 不超过 16 KiB（16384 字节）',
    },
  },
  required: ['target', 'content'],
  additionalProperties: false,
}

const SEND_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功交给网关发送' },
    messageId: { type: 'string', description: '网关返回的消息 id' },
    deliveryStatus: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '网关返回的投递状态（如 queued/sent）；网关未返回时为 null',
    },
    error: { type: 'string', description: '失败原因' },
    code: {
      anyOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

function validateSendArgs(args: unknown): Validated<SendArgs> {
  if (!isRecord(args)) {
    return failure('参数必须是对象：target（user 或 group）、protocol_id/group_id、content')
  }
  const extra = unknownKey(args, SEND_KEYS)
  if (extra !== undefined) {
    return failure(
      `未知参数：${extra}；lanpost_send_message 只接受 target、protocol_id、group_id、content`,
    )
  }

  const target = args.target
  if (target !== 'user' && target !== 'group') {
    return failure('参数 target 必须是 "user"（私聊）或 "group"（群聊）')
  }

  const content = args.content
  if (typeof content !== 'string') {
    return failure('参数 content 必须是字符串')
  }
  if (content.trim() === '') {
    return failure('content 不能为空；请提供要发送的文本')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > TEXT_MAX_BYTES) {
    return failure(
      `消息超过 16 KiB 上限（${bytes} 字节，上限 ${TEXT_MAX_BYTES} 字节），请缩短后重试`,
    )
  }

  if (target === 'user') {
    const protocolId = args.protocol_id
    if (typeof protocolId !== 'string' || protocolId.trim() === '') {
      return failure('target=user（私聊）时必须提供非空的 protocol_id（接收人的 protocol_id）')
    }
    if (args.group_id !== undefined) {
      return failure('target=user（私聊）时不要传 group_id；请用 protocol_id 指定联系人')
    }
    return { ok: true, value: { target, id: protocolId, content } }
  }

  const groupId = args.group_id
  if (typeof groupId !== 'string' || groupId.trim() === '') {
    return failure('target=group（群聊）时必须提供非空的 group_id')
  }
  if (args.protocol_id !== undefined) {
    return failure('target=group（群聊）时不要传 protocol_id；请用 group_id 指定群')
  }
  return { ok: true, value: { target, id: groupId, content } }
}

async function executeSend(deps: ToolsDeps, args: unknown): Promise<unknown> {
  const parsed = validateSendArgs(args)
  if (!parsed.ok) return parsed

  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()

  try {
    const result =
      parsed.value.target === 'user'
        ? await gateway.sendUser(parsed.value.id, parsed.value.content)
        : await gateway.sendGroup(parsed.value.id, parsed.value.content)
    const rawDelivery = result.delivery_status
    const deliveryStatus =
      typeof rawDelivery === 'string' && rawDelivery.trim() !== '' ? oneLine(rawDelivery) : null
    const value: SendSuccess = {
      ok: true,
      messageId: oneLine(result.message_id),
      deliveryStatus,
    }
    return value
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderSend(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const record = isRecord(args) ? args : {}
  const targetLabel =
    record.target === 'group'
      ? `群 ${oneLine(record.group_id) || '（未知群）'}`
      : `私聊 ${oneLine(record.protocol_id) || '（未知联系人）'}`

  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `发送失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}${failureHint(failed.code)}`,
      },
    ]
  }

  const sent = value as SendSuccess
  const delivery =
    sent.deliveryStatus === null ? '网关未返回投递状态' : oneLine(sent.deliveryStatus)
  return [
    {
      type: 'text',
      text: `已发送到${targetLabel}（messageId: ${oneLine(sent.messageId)}，投递状态：${delivery}）。`,
    },
  ]
}

// ---------------------------------------------------------------------------
// lanpost_find_contact

const FIND_KEYS = ['keyword', 'online_only'] as const

const FIND_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    keyword: {
      type: 'string',
      description:
        '联系人关键字；匹配 username、display_name 或 protocol_id（具体规则由网关决定）',
    },
    online_only: {
      type: 'boolean',
      description: 'true 时只返回在线联系人',
    },
  },
  required: ['keyword'],
  additionalProperties: false,
}

const CONTACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    protocol_id: { type: 'string', description: '发送消息时使用的 protocol_id' },
    username: { type: 'string' },
    display_name: { type: 'string' },
    online: { type: 'boolean' },
    last_seen_at: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '最近在线时间；未知时为 null',
    },
  },
  required: ['protocol_id', 'username', 'display_name', 'online', 'last_seen_at'],
  additionalProperties: false,
}

const FIND_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    contacts: {
      type: 'array',
      items: CONTACT_SCHEMA,
      description: '最多 20 个匹配联系人',
    },
    truncated: { type: 'boolean', description: '是否还有更多匹配结果未返回' },
    error: { type: 'string' },
    code: {
      anyOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

function validateFindArgs(args: unknown): Validated<FindArgs> {
  if (!isRecord(args)) {
    return failure('参数必须是对象：keyword（联系人关键字），可选 online_only')
  }
  const extra = unknownKey(args, FIND_KEYS)
  if (extra !== undefined) {
    return failure(`未知参数：${extra}；lanpost_find_contact 只接受 keyword、online_only`)
  }
  const keyword = args.keyword
  if (typeof keyword !== 'string') {
    return failure('参数 keyword 必须是字符串')
  }
  if (keyword.trim() === '') {
    return failure('keyword 不能为空；请提供姓名、用户名或 protocol_id 的一部分')
  }
  if (args.online_only !== undefined && typeof args.online_only !== 'boolean') {
    return failure('参数 online_only 必须是布尔值')
  }
  return { ok: true, value: { keyword, onlineOnly: args.online_only === true } }
}

function projectContact(value: unknown): Contact {
  const record = isRecord(value) ? value : {}
  const username = asString(record.username)
  return {
    protocol_id: asString(record.protocol_id),
    username,
    display_name: asString(record.display_name) || username,
    online: record.online === true,
    last_seen_at: asString(record.last_seen_at) || null,
  }
}

/** 判断 users.list 是否还有下一页：优先信 total，其次 has_more，最后只在超页时保守标注。 */
function hasNextPage(raw: Record<string, unknown>, shown: number, available: number): boolean {
  if (typeof raw.total === 'number') return raw.total > shown
  if (raw.has_more === true) return true
  return available > CONTACT_LIMIT
}

async function executeFind(deps: ToolsDeps, args: unknown): Promise<unknown> {
  const parsed = validateFindArgs(args)
  if (!parsed.ok) return parsed

  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()

  const params: Record<string, unknown> = {
    keyword: parsed.value.keyword,
    page: 1,
    page_size: CONTACT_LIMIT,
  }
  if (parsed.value.onlineOnly) params.online = true

  try {
    const raw = await gateway.call('users.list', params, USERS_TIMEOUT_MS)
    if (!isRecord(raw) || !Array.isArray(raw.users)) {
      return failure('users.list 返回格式异常：缺少 users 数组', BAD_RESPONSE)
    }
    const users = raw.users
    const contacts = users.slice(0, CONTACT_LIMIT).map(projectContact)
    const value: FindSuccess = {
      ok: true,
      contacts,
      truncated: hasNextPage(raw, contacts.length, users.length),
    }
    return value
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderFind(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const record = isRecord(args) ? args : {}
  const keyword = oneLine(record.keyword)

  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `查找联系人失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}`,
      },
    ]
  }

  const found = value as FindSuccess
  if (found.contacts.length === 0) {
    const onlineHint =
      record.online_only === true ? '当前只查在线联系人，可去掉 online_only 再试。' : ''
    return [{ type: 'text', text: `没有找到匹配「${keyword}」的联系人。${onlineHint}` }]
  }

  const lines = found.contacts.map((contact) => {
    const name =
      contact.display_name === contact.username
        ? oneLine(contact.display_name)
        : `${oneLine(contact.display_name)} (@${oneLine(contact.username)})`
    const state = contact.online ? '在线' : '离线'
    const lastSeen =
      contact.last_seen_at === null ? '' : ` · 最近在线 ${oneLine(contact.last_seen_at)}`
    return `- ${name} · protocol_id: ${oneLine(contact.protocol_id)} · ${state}${lastSeen}`
  })
  const header = `找到 ${found.contacts.length} 个联系人${found.truncated ? '（已截断）' : ''}：`
  const footer = found.truncated
    ? `\n只显示前 ${CONTACT_LIMIT} 条，请用更精确的 keyword 或 online_only 缩小范围。`
    : ''
  return [{ type: 'text', text: `${header}\n${lines.join('\n')}${footer}` }]
}

// ---------------------------------------------------------------------------
// lanpost_bridge_status

const STATUS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const STATUS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', description: '桥接是否启用' },
    gatewayUrl: { type: 'string', description: '网关地址' },
    connection: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['idle', 'connecting', 'connected', 'error'],
        },
        since: { type: 'number', description: '进入当前状态的时间戳（毫秒）' },
        error: { type: 'string', description: '上次连接失败原因' },
        notice: { type: 'string', description: '需要提示的异常情况' },
      },
      required: ['state'],
      additionalProperties: false,
    },
    lastSequence: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: '已 ACK 的最大事件序号；未注入状态时为 null',
    },
    tokenSet: { type: 'boolean', description: '是否已配置令牌（不返回令牌原文）' },
    sessionMode: {
      type: 'string',
      enum: ['continue', 'new'],
      description: '同一来源是否沿用同一会话',
    },
    showProcess: { type: 'boolean', description: '回复是否附带思考与工具摘要' },
    sessions: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: '已映射的 lanpost 会话数；未注入状态时为 null',
    },
    selfProtocolId: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '本机在 lanpost 的 protocol_id',
    },
  },
  required: [
    'enabled',
    'gatewayUrl',
    'connection',
    'lastSequence',
    'tokenSet',
    'sessionMode',
    'showProcess',
    'sessions',
    'selfProtocolId',
  ],
  additionalProperties: false,
}

/** 脱敏投影：只挑公开设置与网关状态字段，绝不展开 settings/state（后者含令牌）。 */
function buildStatus(deps: ToolsDeps): StatusValue {
  const settings = deps.settings()
  const gatewayStatus = deps.gateway()?.status()
  const connection: StatusConnection =
    gatewayStatus === undefined
      ? { state: 'idle' }
      : {
          state: gatewayStatus.state,
          since: gatewayStatus.since,
          ...(gatewayStatus.error === undefined ? {} : { error: gatewayStatus.error }),
          ...(gatewayStatus.notice === undefined ? {} : { notice: gatewayStatus.notice }),
        }
  const summary = deps.state?.()
  return {
    enabled: settings.enabled,
    gatewayUrl: settings.gatewayUrl,
    connection,
    lastSequence: summary === undefined ? null : summary.lastSequence,
    tokenSet: settings.tokenSet,
    sessionMode: settings.sessionMode,
    showProcess: settings.showProcess,
    sessions: summary === undefined ? null : summary.sessions,
    selfProtocolId: settings.selfProtocolId,
  }
}

const CONNECTION_LABELS: Record<StatusConnection['state'], string> = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  error: '连接错误',
}

function renderStatus(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `状态查询失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}`,
      },
    ]
  }

  const status = value as StatusValue
  const connection = CONNECTION_LABELS[status.connection.state]
  const since =
    typeof status.connection.since === 'number' && Number.isFinite(status.connection.since)
      ? `（进入当前状态于 ${new Date(status.connection.since).toISOString()}）`
      : ''
  const lines = [
    `lanpost 桥接：${status.enabled ? '已启用' : '未启用'}`,
    `连接：${connection}${since}`,
    `网关地址：${oneLine(status.gatewayUrl)}`,
    `令牌：${status.tokenSet ? '已配置' : '未配置'}`,
    `事件游标：${status.lastSequence === null ? '未知' : status.lastSequence}`,
    `映射会话：${status.sessions === null ? '未知' : status.sessions}`,
    `会话模式：${status.sessionMode === 'new' ? '每条消息新会话' : '同一来源沿用会话'}`,
    `附思考/工具摘要：${status.showProcess ? '是' : '否'}`,
    `自己的 protocol_id：${status.selfProtocolId === null ? '未设置' : oneLine(status.selfProtocolId)}`,
  ]
  if (status.connection.error !== undefined) {
    lines.push(`上次错误：${oneLine(status.connection.error)}`)
  }
  if (status.connection.notice !== undefined) {
    lines.push(`提示：${oneLine(status.connection.notice)}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function validateStatusArgs(args: unknown): ToolFailure | undefined {
  if (!isRecord(args)) return failure('参数必须是对象；lanpost_bridge_status 不接受参数')
  const extra = unknownKey(args, [])
  if (extra !== undefined) {
    return failure(`未知参数：${extra}；lanpost_bridge_status 不接受参数`)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 工具装配

/** 造出三个 agent 工具；注册由装配层负责（每个工具的 name 唯一）。 */
export function createTools(deps: ToolsDeps): ToolDefinitionLike[] {
  return [
    {
      name: 'lanpost_send_message',
      description:
        '当用户要求通过 lanpost-im 给某人或某个群发消息时使用。私聊用 target=user 并提供接收人的 protocol_id（可先用 lanpost_find_contact 查）；群聊用 target=group 并提供 group_id——group_id 不能从 lanpost_find_contact 获得，只能来自入站群消息的来源行或用户直接提供。content 是消息正文，UTF-8 不超过 16 KiB（16384 字节）。消息直接交给网关发送，不排队也不自动重试；未连接或发送失败时返回 ok=false 与原因。',
      parameters: SEND_PARAMETERS,
      output: { schema: SEND_OUTPUT_SCHEMA, render: renderSend },
      execute: (args, _exec) => executeSend(deps, args),
    },
    {
      name: 'lanpost_find_contact',
      description:
        '按关键字查找 lanpost-im 联系人，用于在发消息前确认 protocol_id。匹配 username、display_name 或 protocol_id（具体规则由网关决定），最多返回 20 条并标注是否截断；online_only=true 时只查在线联系人。',
      parameters: FIND_PARAMETERS,
      output: { schema: FIND_OUTPUT_SCHEMA, render: renderFind },
      execute: (args, _exec) => executeFind(deps, args),
    },
    {
      name: 'lanpost_bridge_status',
      description:
        '查看 lanpost 桥接的连接状态与配置概况：连接状态与上次错误、事件游标、已映射会话数、令牌是否已配置等，用于排查消息发不出或收不到的问题。只读，且不会返回令牌原文。',
      parameters: STATUS_PARAMETERS,
      output: { schema: STATUS_OUTPUT_SCHEMA, render: renderStatus },
      execute: async (args) => validateStatusArgs(args) ?? buildStatus(deps),
    },
  ]
}

// lanpost-bridge 的三个 agent 工具：发送消息、查找联系人、查看桥接状态。
//
// 工具对象是手写 JSON Schema 的 ToolDefinitionLike（见 harness.ts）；不 import `defineTool`，
// 也不 import 任何 `@deepseek-ai/*`。注册由 index.ts 的装配层负责，这里只负责定义与行为。
//
// 失败约定：参数校验失败与 GatewayError 都返回 `{ ok: false, error, code }`，工具本身不抛
// （这是给模型的正常结果，不是崩溃）；其他异常照旧抛出，不吞错、不重试。
// 状态工具只做脱敏投影，绝不返回令牌原文。

import { readFileSync } from 'node:fs'
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
  sendImage(
    target: { kind: 'user'; protocolId: string } | { kind: 'group'; groupId: string },
    image: { data: Buffer; mimeType: string; name: string },
  ): Promise<SendResult & { attachment_id: string }>
  recallMessage(messageId: string): Promise<{ message_id: string; recalled: boolean }>
  listGroups(): Promise<unknown>
  listGroupMembers(
    groupId: string,
    options: { onlineOnly: boolean; page: number; pageSize: number },
  ): Promise<unknown>
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

/** `users.list` 的分页默认值与上限（网关允许 page_size ≤ 200）。 */
const LIST_PAGE_SIZE_DEFAULT = 50
const LIST_PAGE_SIZE_MAX = 200
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

interface ListSuccess {
  ok: true
  contacts: Contact[]
  total: number | null
  page: number
  page_size: number
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
  gatewayAddress: string
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

interface ListArgs {
  keyword: string | undefined
  onlineOnly: boolean
  page: number
  pageSize: number
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

/** 与 bridge.ts 的展示净化同源：控制字符折叠成空格，避免网关文本破坏工具输出的行结构。
 *  区间刻意保留 U+200D（ZWJ）：👨‍👩‍👧 这类 emoji 由 ZWJ 连接，删掉就会被拆散。 */
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200C\u200E-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F]/g
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
  if (code === -32601) {
    return '\n当前网关版本没有该接口（-32601），请升级 lanpost-im 客户端后重试。'
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
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: '网关返回的投递状态（如 queued/sent）；网关未返回时为 null',
    },
    error: { type: 'string', description: '失败原因' },
    code: {
      oneOf: [{ type: 'number' }, { type: 'string' }],
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
      text: `已发送到${targetLabel}（messageId: ${oneLine(sent.messageId) || '（网关未返回消息 id）'}，投递状态：${delivery}）。`,
    },
  ]
}

// ---------------------------------------------------------------------------
// lanpost_list_contacts

const LIST_KEYS = ['keyword', 'online_only', 'page', 'page_size'] as const

const LIST_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    keyword: {
      type: 'string',
      description:
        '可选过滤词；匹配 username、display_name 或 protocol_id（具体规则由网关决定）。省略或空串表示不过滤，列出全部联系人',
    },
    online_only: {
      type: 'boolean',
      description: 'true 时只返回在线联系人',
    },
    page: {
      type: 'integer',
      description: '页码，从 1 开始；默认 1',
    },
    page_size: {
      type: 'integer',
      description: '每页条数，1–200；默认 50。联系人很多时按页继续取',
    },
  },
  required: [],
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
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: '最近在线时间；未知时为 null',
    },
  },
  required: ['protocol_id', 'username', 'display_name', 'online', 'last_seen_at'],
  additionalProperties: false,
}

const LIST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    contacts: {
      type: 'array',
      items: CONTACT_SCHEMA,
      description: '本页联系人；无 keyword 时即名册的一页',
    },
    total: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '网关给出的联系人总数；网关未返回时为 null',
    },
    page: { type: 'integer', description: '本次请求的页码' },
    page_size: { type: 'integer', description: '本次请求的每页条数' },
    truncated: { type: 'boolean', description: '是否还有后续页' },
    error: { type: 'string' },
    code: {
      oneOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

function validateListArgs(args: unknown): Validated<ListArgs> {
  if (!isRecord(args)) {
    return failure('参数必须是对象：可选 keyword、online_only、page、page_size')
  }
  const extra = unknownKey(args, LIST_KEYS)
  if (extra !== undefined) {
    return failure(`未知参数：${extra}；lanpost_list_contacts 只接受 keyword、online_only、page、page_size`)
  }
  const keyword = args.keyword
  if (keyword !== undefined && typeof keyword !== 'string') {
    return failure('参数 keyword 必须是字符串；省略或空串表示不过滤')
  }
  const trimmed = typeof keyword === 'string' ? keyword.trim() : ''
  if (args.online_only !== undefined && typeof args.online_only !== 'boolean') {
    return failure('参数 online_only 必须是布尔值')
  }
  const page = args.page === undefined ? 1 : args.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    return failure('参数 page 必须是 ≥1 的整数')
  }
  const pageSize = args.page_size === undefined ? LIST_PAGE_SIZE_DEFAULT : args.page_size
  if (
    typeof pageSize !== 'number' ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > LIST_PAGE_SIZE_MAX
  ) {
    return failure(`参数 page_size 必须是 1–${LIST_PAGE_SIZE_MAX} 的整数`)
  }
  return {
    ok: true,
    value: {
      keyword: trimmed === '' ? undefined : trimmed,
      onlineOnly: args.online_only === true,
      page,
      pageSize,
    },
  }
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

/**
 * 判断 users.list 是否还有下一页：优先使用网关给出的 `total`（`page * page_size < total`）；
 * 网关未给 total 时只能保守判断——本页取满 `page_size` 条就提示「可能还有更多」，
 * 因为不知道网关是否按 page_size 截断（宁可多提示一句，也不要漏掉联系人）。
 */
function hasNextPage(raw: Record<string, unknown>, shown: number, page: ListArgs): boolean {
  if (typeof raw.total === 'number') return page.page * page.pageSize < raw.total
  if (typeof raw.has_more === 'boolean') return raw.has_more
  return shown >= page.pageSize
}

async function executeList(deps: ToolsDeps, args: unknown): Promise<unknown> {
  const parsed = validateListArgs(args)
  if (!parsed.ok) return parsed

  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()

  const params: Record<string, unknown> = {
    page: parsed.value.page,
    page_size: parsed.value.pageSize,
  }
  if (parsed.value.keyword !== undefined) params.keyword = parsed.value.keyword
  if (parsed.value.onlineOnly) params.online = true

  try {
    const raw = await gateway.call('users.list', params, USERS_TIMEOUT_MS)
    if (!isRecord(raw) || !Array.isArray(raw.users)) {
      return failure('users.list 返回格式异常：缺少 users 数组', BAD_RESPONSE)
    }
    const contacts = raw.users.slice(0, parsed.value.pageSize).map(projectContact)
    const value: ListSuccess = {
      ok: true,
      contacts,
      total: typeof raw.total === 'number' ? raw.total : null,
      page: parsed.value.page,
      page_size: parsed.value.pageSize,
      truncated: hasNextPage(raw, contacts.length, parsed.value),
    }
    return value
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderList(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const record = isRecord(args) ? args : {}
  const keyword = oneLine(record.keyword)

  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `列出联系人失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}`,
      },
    ]
  }

  const listed = value as ListSuccess
  const scope = keyword === '' ? '联系人名册' : `匹配「${keyword}」的联系人`
  const range =
    listed.total === null
      ? `第 ${listed.page} 页（每页 ${listed.page_size} 条）`
      : `第 ${listed.page} 页（共 ${listed.total} 个）`
  if (listed.contacts.length === 0) {
    const onlineHint =
      record.online_only === true ? '当前只查在线联系人，可去掉 online_only 再试。' : ''
    const pageHint = listed.page > 1 ? `本页为空；当前${range}，可回到第 1 页查看。` : ''
    return [{ type: 'text', text: `${pageHint}没有找到${scope}。${onlineHint}` }]
  }

  const lines = listed.contacts.map((contact) => {
    const name =
      contact.display_name === contact.username
        ? oneLine(contact.display_name)
        : `${oneLine(contact.display_name)} (@${oneLine(contact.username)})`
    const state = contact.online ? '在线' : '离线'
    const lastSeen =
      contact.last_seen_at === null ? '' : ` · 最近在线 ${oneLine(contact.last_seen_at)}`
    return `- ${name} · protocol_id: ${oneLine(contact.protocol_id)} · ${state}${lastSeen}`
  })
  const header = `${scope}：本页 ${listed.contacts.length} 个，${range}`
  const footer = listed.truncated
    ? `\n可能还有更多；用 page=${listed.page + 1} 继续，或加 keyword / online_only 缩小范围。`
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
    gatewayAddress: { type: 'string', description: '网关地址（host:port）' },
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
      oneOf: [{ type: 'integer' }, { type: 'null' }],
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
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '已映射的 lanpost 会话数；未注入状态时为 null',
    },
    selfProtocolId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: '本机在 lanpost 的 protocol_id',
    },
  },
  required: [
    'enabled',
    'gatewayAddress',
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
    gatewayAddress: settings.gatewayAddress,
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
  const status = value as StatusValue
  const connection = CONNECTION_LABELS[status.connection.state]
  const since =
    typeof status.connection.since === 'number' && Number.isFinite(status.connection.since)
      ? `（进入当前状态于 ${new Date(status.connection.since).toISOString()}）`
      : ''
  const lines = [
    `lanpost 桥接：${status.enabled ? '已启用' : '未启用'}`,
    `连接：${connection}${since}`,
    `网关地址：${oneLine(status.gatewayAddress)}`,
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

// ---------------------------------------------------------------------------
// lanpost_list_groups

const GROUPS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const GROUP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    group_id: { type: 'string', description: '发群消息时使用的 group_id' },
    name: { type: 'string' },
    master_id: { type: 'string', description: '群主的 protocol_id（网关未给出时为空串）' },
    master_name: { type: 'string' },
    topic: { type: 'string' },
    announcement: { type: 'string' },
    member_count: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '成员数；网关未给出时为 null',
    },
    updated_at: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: '群资料更新时间；网关未给出时为 null',
    },
  },
  required: [
    'group_id',
    'name',
    'master_id',
    'master_name',
    'topic',
    'announcement',
    'member_count',
    'updated_at',
  ],
  additionalProperties: false,
}

const GROUPS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    groups: { type: 'array', items: GROUP_SCHEMA, description: '当前账号所在的群' },
    total: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '网关给出的群总数；未返回时为 null',
    },
    error: { type: 'string' },
    code: {
      oneOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

function projectGroup(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {}
  return {
    group_id: asString(record.group_id),
    name: asString(record.name) || asString(record.group_name),
    master_id: asString(record.master_id),
    master_name: asString(record.master_name) || asString(record.master_display_name),
    topic: asString(record.topic),
    announcement: asString(record.announcement),
    member_count: typeof record.member_count === 'number' ? record.member_count : null,
    updated_at: asString(record.updated_at) || null,
  }
}

async function executeGroups(deps: ToolsDeps, args: unknown): Promise<unknown> {
  if (!isRecord(args)) return failure('参数必须是空对象；lanpost_list_groups 不接受参数')
  const extra = unknownKey(args, [])
  if (extra !== undefined) return failure(`未知参数：${extra}；lanpost_list_groups 不接受参数`)

  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()
  try {
    const raw = await gateway.listGroups()
    if (!isRecord(raw) || !Array.isArray(raw.groups)) {
      return failure('groups.list 返回格式异常：缺少 groups 数组', BAD_RESPONSE)
    }
    return {
      ok: true,
      groups: raw.groups.map(projectGroup),
      total: typeof raw.total === 'number' ? raw.total : null,
    }
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderGroups(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `列出群失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}${failureHint(failed.code)}`,
      },
    ]
  }
  const listed = value as { groups: Array<Record<string, unknown>>; total: number | null }
  if (listed.groups.length === 0) return [{ type: 'text', text: '当前账号没有加入任何群。' }]
  const lines = listed.groups.map((group) => {
    const name = oneLine(asString(group.name)) || '（未命名群）'
    const members =
      typeof group.member_count === 'number' ? ` · ${group.member_count} 人` : ''
    const topic = asString(group.topic) === '' ? '' : ` · ${oneLine(group.topic)}`
    return `- ${name} · group_id: ${oneLine(asString(group.group_id))}${members}${topic}`
  })
  const header =
    listed.total === null
      ? `群列表：${listed.groups.length} 个`
      : `群列表：${listed.groups.length} 个（共 ${listed.total} 个）`
  return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
}

// ---------------------------------------------------------------------------
// lanpost_list_group_members

const MEMBERS_KEYS = ['group_id', 'online_only', 'page', 'page_size'] as const

const MEMBERS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    group_id: { type: 'string', description: '群的 group_id（可先用 lanpost_list_groups 查）' },
    online_only: { type: 'boolean', description: 'true 时只返回在线成员' },
    page: { type: 'integer', description: '页码，从 1 开始；默认 1' },
    page_size: {
      type: 'integer',
      description: '每页条数，1–200；默认 50',
    },
  },
  required: ['group_id'],
  additionalProperties: false,
}

const MEMBER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    protocol_id: { type: 'string' },
    name: { type: 'string', description: '显示名；网关只给 username 时即 username' },
    online: { type: 'boolean' },
    is_master: { type: 'boolean', description: '是否群主' },
  },
  required: ['protocol_id', 'name', 'online', 'is_master'],
  additionalProperties: false,
}

const MEMBERS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    group_id: { type: 'string' },
    name: { type: 'string', description: '群名；网关未给出时为空串' },
    members: { type: 'array', items: MEMBER_SCHEMA },
    total: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '网关给出的成员总数；未返回时为 null',
    },
    page: { type: 'integer' },
    page_size: { type: 'integer' },
    truncated: { type: 'boolean', description: '是否还有后续页' },
    error: { type: 'string' },
    code: {
      oneOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

interface MemberArgs {
  groupId: string
  onlineOnly: boolean
  page: number
  pageSize: number
}

function validateMembersArgs(args: unknown): Validated<MemberArgs> {
  if (!isRecord(args)) return failure('参数必须是对象：group_id 必填，可选 online_only、page、page_size')
  const extra = unknownKey(args, MEMBERS_KEYS)
  if (extra !== undefined) {
    return failure(`未知参数：${extra}；lanpost_list_group_members 只接受 group_id、online_only、page、page_size`)
  }
  const groupId = typeof args.group_id === 'string' ? args.group_id.trim() : ''
  if (groupId === '') return failure('参数 group_id 必填，且必须是非空字符串')
  if (args.online_only !== undefined && typeof args.online_only !== 'boolean') {
    return failure('参数 online_only 必须是布尔值')
  }
  const page = args.page === undefined ? 1 : args.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    return failure('参数 page 必须是 ≥1 的整数')
  }
  const pageSize = args.page_size === undefined ? LIST_PAGE_SIZE_DEFAULT : args.page_size
  if (
    typeof pageSize !== 'number' ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > LIST_PAGE_SIZE_MAX
  ) {
    return failure(`参数 page_size 必须是 1–${LIST_PAGE_SIZE_MAX} 的整数`)
  }
  return {
    ok: true,
    value: { groupId, onlineOnly: args.online_only === true, page, pageSize },
  }
}

function projectMember(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {}
  const username = asString(record.username)
  return {
    protocol_id: asString(record.protocol_id),
    name: asString(record.name) || asString(record.display_name) || username,
    online: record.online === true,
    is_master: record.is_master === true || record.master === true,
  }
}

async function executeMembers(deps: ToolsDeps, args: unknown): Promise<unknown> {
  const parsed = validateMembersArgs(args)
  if (!parsed.ok) return parsed
  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()
  try {
    const raw = await gateway.listGroupMembers(parsed.value.groupId, {
      onlineOnly: parsed.value.onlineOnly,
      page: parsed.value.page,
      pageSize: parsed.value.pageSize,
    })
    if (!isRecord(raw) || !Array.isArray(raw.members)) {
      return failure('groups.members 返回格式异常：缺少 members 数组', BAD_RESPONSE)
    }
    const members = raw.members.slice(0, parsed.value.pageSize).map(projectMember)
    const total = typeof raw.total === 'number' ? raw.total : null
    const truncated =
      total !== null
        ? parsed.value.page * parsed.value.pageSize < total
        : members.length >= parsed.value.pageSize
    return {
      ok: true,
      group_id: parsed.value.groupId,
      name: asString(raw.name),
      members,
      total,
      page: parsed.value.page,
      page_size: parsed.value.pageSize,
      truncated,
    }
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderMembers(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `列出群成员失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}${failureHint(failed.code)}`,
      },
    ]
  }
  const record = isRecord(args) ? args : {}
  const listed = value as {
    group_id: string
    name: string
    members: Array<Record<string, unknown>>
    total: number | null
    page: number
    page_size: number
    truncated: boolean
  }
  const label = listed.name === '' ? `group_id ${oneLine(listed.group_id)}` : oneLine(listed.name)
  const range =
    listed.total === null
      ? `第 ${listed.page} 页（每页 ${listed.page_size} 条）`
      : `第 ${listed.page} 页（共 ${listed.total} 个）`
  if (listed.members.length === 0) {
    const onlineHint = record.online_only === true ? '当前只查在线成员，可去掉 online_only 再试。' : ''
    return [{ type: 'text', text: `群 ${label} 没有找到成员。${onlineHint}` }]
  }
  const lines = listed.members.map((member) => {
    const name = oneLine(asString(member.name)) || '（未命名）'
    const master = member.is_master === true ? ' · 群主' : ''
    const state = member.online === true ? '在线' : '离线'
    return `- ${name} · protocol_id: ${oneLine(asString(member.protocol_id))} · ${state}${master}`
  })
  const footer = listed.truncated
    ? `\n可能还有更多；用 page=${listed.page + 1} 继续，或加 online_only 缩小范围。`
    : ''
  return [
    {
      type: 'text',
      text: `群 ${label} 成员：本页 ${listed.members.length} 个，${range}\n${lines.join('\n')}${footer}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// lanpost_recall_message

const RECALL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    message_id: {
      type: 'string',
      description: '要撤回的消息 id（形如 im:123；来自发送结果或入站消息来源行）',
    },
  },
  required: ['message_id'],
  additionalProperties: false,
}

const RECALL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message_id: { type: 'string', description: '实际撤回的消息 id' },
    recalled: { type: 'boolean', description: '网关是否确认撤回' },
    error: { type: 'string' },
    code: {
      oneOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

const MESSAGE_ID_PATTERN = /^im:\d+$/

async function executeRecall(deps: ToolsDeps, args: unknown): Promise<unknown> {
  if (!isRecord(args)) return failure('参数必须是对象：message_id 必填')
  const extra = unknownKey(args, ['message_id'])
  if (extra !== undefined) return failure(`未知参数：${extra}；lanpost_recall_message 只接受 message_id`)
  const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : ''
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    return failure('参数 message_id 必须形如 im:123（只撤回数字 id）')
  }
  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()
  try {
    const result = await gateway.recallMessage(messageId)
    return { ok: true, message_id: result.message_id, recalled: result.recalled }
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderRecall(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `撤回消息失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}${failureHint(failed.code)}`,
      },
    ]
  }
  const recalled = value as { message_id: string; recalled: boolean }
  return [
    {
      type: 'text',
      text: recalled.recalled
        ? `已撤回消息 ${oneLine(recalled.message_id)}。`
        : `网关未确认撤回消息 ${oneLine(recalled.message_id)}；可能已超过撤回时限或对方已读。`,
    },
  ]
}

// ---------------------------------------------------------------------------
// lanpost_send_image

const IMAGE_KEYS = ['target', 'protocol_id', 'group_id', 'path'] as const

const IMAGE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: ['user', 'group'],
      description: 'user=私聊（配 protocol_id）；group=群聊（配 group_id）',
    },
    protocol_id: { type: 'string', description: '私聊接收人的 protocol_id；target=user 时必填' },
    group_id: { type: 'string', description: '群会话的 group_id；target=group 时必填' },
    path: {
      type: 'string',
      description: '本机图片路径（png/jpeg/webp/gif，大小不超过 10 MiB）；相对路径按当前工作目录解析',
    },
  },
  required: ['target', 'path'],
  additionalProperties: false,
}

const IMAGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功交给网关发送' },
    messageId: { type: 'string', description: '网关返回的消息 id' },
    deliveryStatus: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: '网关给出的初始投递状态；未返回时为 null',
    },
    attachmentId: { type: 'string', description: '上传后得到的附件 id' },
    error: { type: 'string' },
    code: {
      oneOf: [{ type: 'number' }, { type: 'string' }],
      description: '失败代码：数字为网关错误码，字符串为本地或网关响应检查出的代码',
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

interface ImageArgs {
  target: { kind: 'user'; protocolId: string } | { kind: 'group'; groupId: string }
  path: string
  mimeType: string
  name: string
}

function validateImageArgs(args: unknown): Validated<ImageArgs> {
  if (!isRecord(args)) return failure('参数必须是对象：target、path 必填，私聊配 protocol_id、群聊配 group_id')
  const extra = unknownKey(args, IMAGE_KEYS)
  if (extra !== undefined) {
    return failure(`未知参数：${extra}；lanpost_send_image 只接受 target、protocol_id、group_id、path`)
  }
  const target = args.target
  if (target !== 'user' && target !== 'group') {
    return failure('参数 target 必须是 user 或 group')
  }
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  if (path === '') return failure('参数 path 必填，且必须是非空字符串')
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  const mimeType = IMAGE_MIME_BY_EXTENSION[extension]
  if (mimeType === undefined) {
    return failure('只支持 png、jpg/jpeg、webp、gif 图片；请换一张或先转换格式')
  }
  const protocolId = typeof args.protocol_id === 'string' ? args.protocol_id.trim() : ''
  const groupId = typeof args.group_id === 'string' ? args.group_id.trim() : ''
  if (target === 'user') {
    if (protocolId === '') return failure('target=user（私聊）时必须提供非空的 protocol_id')
    if (groupId !== '') return failure('target=user（私聊）时不要传 group_id；请用 protocol_id 指定联系人')
    return {
      ok: true,
      value: { target: { kind: 'user', protocolId }, path, mimeType, name: basename(path) },
    }
  }
  if (groupId === '') return failure('target=group（群聊）时必须提供非空的 group_id')
  if (protocolId !== '') return failure('target=group（群聊）时不要传 protocol_id；请用 group_id 指定群')
  return {
    ok: true,
    value: { target: { kind: 'group', groupId }, path, mimeType, name: basename(path) },
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

async function executeSendImage(deps: ToolsDeps, args: unknown): Promise<unknown> {
  const parsed = validateImageArgs(args)
  if (!parsed.ok) return parsed
  const gateway = deps.gateway()
  if (gateway === undefined) return notConnected()
  let data: Buffer
  try {
    data = readFileSync(parsed.value.path)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return failure(`读取图片失败：${oneLine(reason)}`, INVALID_ARGS)
  }
  try {
    const result = await gateway.sendImage(parsed.value.target, {
      data,
      mimeType: parsed.value.mimeType,
      name: parsed.value.name,
    })
    return {
      ok: true,
      messageId: result.message_id,
      deliveryStatus: result.delivery_status ?? null,
      attachmentId: result.attachment_id,
    }
  } catch (error) {
    if (error instanceof GatewayError) return gatewayFailure(error)
    throw error
  }
}

function renderSendImage(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  if (isRecord(value) && value.ok === false) {
    const failed = value as unknown as ToolFailure
    return [
      {
        type: 'text',
        text: `发送图片失败：${oneLine(failed.error)}\n${codeLabel(failed.code)}${failureHint(failed.code)}`,
      },
    ]
  }
  const record = isRecord(args) ? args : {}
  const sent = value as { messageId: string; deliveryStatus: string | null; attachmentId: string }
  const targetLabel = record.target === 'group' ? '群' : '联系人'
  const delivery =
    sent.deliveryStatus === null ? '网关未返回投递状态' : oneLine(sent.deliveryStatus)
  return [
    {
      type: 'text',
      text: `已发送图片到${targetLabel}（messageId: ${oneLine(sent.messageId) || '（网关未返回消息 id）'}，attachmentId: ${oneLine(sent.attachmentId)}，投递状态：${delivery}）。`,
    },
  ]
}

// ---------------------------------------------------------------------------
// 工具装配

/** 造出 agent 工具；注册由装配层负责（每个工具的 name 唯一）。 */
export function createTools(deps: ToolsDeps): ToolDefinitionLike[] {
  return [
    {
      name: 'lanpost_send_message',
      description:
        '当用户要求通过 lanpost-im 给某人或某个群发消息时使用。私聊用 target=user 并提供接收人的 protocol_id（可先用 lanpost_list_contacts 查）；群聊用 target=group 并提供 group_id（可先用 lanpost_list_groups 查，也可来自入站群消息的来源行）。content 是消息正文，UTF-8 不超过 16 KiB（16384 字节）。消息直接交给网关发送，不排队也不自动重试；未连接或发送失败时返回 ok=false 与原因。',
      parameters: SEND_PARAMETERS,
      output: { schema: SEND_OUTPUT_SCHEMA, render: renderSend },
      execute: (args, _exec) => executeSend(deps, args),
    },
    {
      name: 'lanpost_list_contacts',
      description:
        '列出本机 lanpost-im 联系人名册（可按关键字/在线状态过滤并分页），发消息前用它拿 protocol_id。keyword 省略或空串时列出全部联系人；关键字的匹配规则由网关决定（username、display_name 或 protocol_id）。page 从 1 开始，page_size 默认 50、上限 200；结果会说明本页数量、总数与是否还有后续页。',
      parameters: LIST_PARAMETERS,
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderList },
      execute: (args, _exec) => executeList(deps, args),
    },
    {
      name: 'lanpost_list_groups',
      description:
        '列出本机 lanpost-im 账号所在的群（group_id、群名、群主、成员数等），发群消息前用它拿 group_id。只读；网关版本没有 groups.list 时返回错误码 -32601。',
      parameters: GROUPS_PARAMETERS,
      output: { schema: GROUPS_OUTPUT_SCHEMA, render: renderGroups },
      execute: (args, _exec) => executeGroups(deps, args),
    },
    {
      name: 'lanpost_list_group_members',
      description:
        '列出某个群的成员（protocol_id、显示名、在线状态、是否群主），需要找群内某人的 protocol_id 时使用。group_id 必填；online_only 只筛在线；page 从 1 开始，page_size 默认 50、上限 200。网关版本没有 groups.members 时返回错误码 -32601。',
      parameters: MEMBERS_PARAMETERS,
      output: { schema: MEMBERS_OUTPUT_SCHEMA, render: renderMembers },
      execute: (args, _exec) => executeMembers(deps, args),
    },
    {
      name: 'lanpost_recall_message',
      description:
        '撤回一条 lanpost-im 消息（形如 im:123，来自发送结果或入站消息的来源行）。仅当用户明确要求撤回、或刚发错消息需要收回时使用；撤回是否被网关接受由返回的 recalled 表示。网关版本没有 message.recall 时返回错误码 -32601。',
      parameters: RECALL_PARAMETERS,
      output: { schema: RECALL_OUTPUT_SCHEMA, render: renderRecall },
      execute: (args, _exec) => executeRecall(deps, args),
    },
    {
      name: 'lanpost_send_image',
      description:
        '当用户要求通过 lanpost-im 发送本机图片时使用。私聊用 target=user 配 protocol_id，群聊用 target=group 配 group_id；path 是本机图片路径（png/jpeg/webp/gif，不超过 10 MiB），相对路径按当前工作目录解析。插件负责上传并与网关换附件 id，不返回图片内容。',
      parameters: IMAGE_PARAMETERS,
      output: { schema: IMAGE_OUTPUT_SCHEMA, render: renderSendImage },
      execute: (args, _exec) => executeSendImage(deps, args),
    },
    {
      name: 'lanpost_bridge_status',
      description:
        '查看 lanpost 桥接的连接状态与配置概况：连接状态与上次错误、事件游标、已映射会话数、令牌是否已配置等，用于排查消息发不出或收不到的问题。只读，且不会返回令牌原文。',
      parameters: STATUS_PARAMETERS,
      output: { schema: STATUS_OUTPUT_SCHEMA, render: renderStatus },
      execute: async () => buildStatus(deps),
    },
  ]
}

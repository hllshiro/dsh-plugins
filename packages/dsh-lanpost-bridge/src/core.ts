// lanpost-bridge 纯函数层：无 I/O、无环境变量、不依赖本包其他模块。
// 编排模块（gateway / bridge / tools / routes）共用这里的常量与判定逻辑。

/** 单条文本消息的 UTF-8 字节上限（16 KiB）。 */
export const TEXT_MAX_BYTES = 16 * 1024
/** 回复单段字节上限（含 `(i/n) ` 角标）。 */
export const REPLY_CHUNK_BYTES = 4000
/** 每会话待处理队列上限。 */
export const QUEUE_LIMIT = 20
/** 等待一轮 turn/end 的超时（10 分钟）。 */
export const TURN_TIMEOUT_MS = 10 * 60_000
/** 入站事件去重窗口条数。 */
export const SEEN_LIMIT = 500

/** 群触发前缀：`/dsh` 后跟空白或字符串结束。 */
export const GROUP_TRIGGER = /^\/dsh(?:\s+|$)/i

/** 网关默认地址：只填 `host:port`，协议由插件决定。 */
export const DEFAULT_GATEWAY_ADDRESS = 'localhost:9015'
/** 网关 WebSocket 路径固定，地址里只配 host:port。 */
export const GATEWAY_WS_PATH = '/ws/dsh'

const ADDRESS_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):\d{1,5}$/

/**
 * 归一网关地址：只接受 `host:port`。
 * 兼容用户粘贴完整 URL 的情况（去掉 `ws://`/`http://` 与路径），非法输入返回 null。
 */
export function parseGatewayAddress(input: string): string | null {
  let text = input.trim()
  if (text === '') return null
  const scheme = text.indexOf('://')
  if (scheme !== -1) text = text.slice(scheme + 3)
  const slash = text.indexOf('/')
  if (slash !== -1) text = text.slice(0, slash)
  if (!ADDRESS_PATTERN.test(text)) return null
  const port = Number(text.slice(text.lastIndexOf(':') + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return text
}

/** 由 `host:port` 组出 WebSocket URL；局域网明文连接，不使用 TLS。 */
export function gatewayWsUrl(address: string): string {
  return `ws://${address}${GATEWAY_WS_PATH}`
}

/** 设置页工作区下拉项。 */
export interface WorkspaceOption {
  id: string
  title?: string
  path: string
}

/**
 * 归一宿主工作区条目：现在 `workspaceRegistry.list()` 返回 `{id, host, record:{path,title,…}}`，
 * 旧/假实现可能是扁平的 `{id, title, path}`；缺 path 的条目丢弃。
 */
export function workspaceOption(entry: unknown): WorkspaceOption | null {
  if (typeof entry !== 'object' || entry === null) return null
  const item = entry as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id === '') return null
  const record =
    typeof item.record === 'object' && item.record !== null ? (item.record as Record<string, unknown>) : item
  const path = record.path
  if (typeof path !== 'string' || path === '') return null
  const title = record.title
  return {
    id: item.id,
    path,
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
  }
}

/** 批量归一工作区列表，顺序与宿主持平。 */
export function workspaceOptions(entries: readonly unknown[]): WorkspaceOption[] {
  const options: WorkspaceOption[] = []
  for (const entry of entries) {
    const option = workspaceOption(entry)
    if (option !== null) options.push(option)
  }
  return options
}

/** 消息来源类型：私聊或群聊。 */
export type SourceKind = 'private' | 'group'

/** 回复目标来源：私聊需要 protocolId，群聊需要 groupId。 */
export interface ReplySource {
  kind: SourceKind
  name: string
  username?: string
  groupId?: string
}

/** 群消息按 /dsh 前缀判定；命中返回剥前缀后的正文（可能为空串），不命中返回 null。 */
export function stripGroupTrigger(text: string): string | null {
  if (!GROUP_TRIGGER.test(text)) return null
  return text.replace(GROUP_TRIGGER, '')
}

/** 按 UTF-8 字节切分，单段不超过 maxBytes，不产生半个字符；maxBytes <= 0 抛错。 */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new RangeError('splitUtf8: maxBytes must be > 0')

  const parts: string[] = []
  let current = ''
  let currentBytes = 0
  // for...of 逐码点迭代，不会把代理对拆成两半。
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
      parts.push(current)
      current = ch
      currentBytes = bytes
    } else {
      // 单码点自身超过 maxBytes 时 currentBytes === 0，直接单独成段。
      current += ch
      currentBytes += bytes
    }
  }
  if (current !== '') parts.push(current)
  return parts
}

/** 回复切段：超过 4000 字节时分成多段并在每段前加 `(i/n) ` 角标（角标计入预算）。 */
export function replyParts(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') <= REPLY_CHUNK_BYTES) return [text]

  // 角标长度取决于段数的位数，先按假设段数切、再按实际段数收敛到不动点。
  let count = 1
  let chunks: string[] = []
  for (;;) {
    const prefixBytes = 2 * String(count).length + 4 // `(` i `/` n `) `
    chunks = splitUtf8(text, REPLY_CHUNK_BYTES - prefixBytes)
    if (chunks.length === count) break
    count = chunks.length
  }
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length}) ${chunk}`)
}

/** 投给 agent 的正文：首行来源说明 + 空行 + 正文。 */
export function promptTextFor(source: ReplySource, text: string): string {
  const who = source.username ? `${source.name} (${source.username})` : source.name
  const where =
    source.kind === 'private' ? '私聊' : source.groupId ? `群 ${source.groupId}` : '群'
  return `[lanpost ${where} · ${who}]\n\n${text}`
}

/** 去重窗口：已在窗口内返回 {added:false}，否则前插并裁到 limit。 */
export function dedupeAdd(
  list: readonly string[],
  id: string,
  limit: number,
): { list: string[]; added: boolean } {
  if (list.includes(id)) return { list: [...list], added: false }
  return { list: [id, ...list].slice(0, limit), added: true }
}

/** 人类可读时长：< 1 分钟 `12.3s`，否则 `1m 5s`；秒进位到分钟，不出现 `59m 60s`。 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  let minutes = Math.floor(ms / 60_000)
  let seconds = Math.round((ms % 60_000) / 1000)
  if (seconds === 60) {
    minutes += 1
    seconds = 0
  }
  return `${minutes}m ${seconds}s`
}

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

export type SourceKind = 'private' | 'group'

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

/** 人类可读时长：< 1 分钟 `12.3s`，否则 `1m 5s`。 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

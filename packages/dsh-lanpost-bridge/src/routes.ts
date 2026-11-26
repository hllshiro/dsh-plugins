// lanpost-bridge 设置页背后的五条 loopback 路由：设置读写、重连、状态、工作区列表、会话映射删除。
// 全部只服务本机浏览器，因此每条路由第一件事就是校验 loopback 来源；出错就地回 500，不吞异常。
// 请求体与响应体都是 JSON，令牌绝不进入任何响应或审计明细。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRouteLike } from './harness.ts'
import { parseGatewayAddress } from './core.ts'
import { publicSettings } from './store.ts'
import type { BridgeState } from './store.ts'

/** 一条路由的完整路径都建立在这个前缀上。 */
export const BASE = '/api/lanpost-bridge'
/** 设置读写。 */
export const SETTINGS = `${BASE}/settings`
/** 网关状态快照。 */
export const STATUS = `${BASE}/status`
/** 可选工作区列表。 */
export const WORKSPACES = `${BASE}/workspaces`
/** 手动重连。 */
export const RECONNECT = `${BASE}/reconnect`
/** 会话映射（前缀路由，DELETE 到 `/sessions/<key>`）。 */
export const SESSIONS = `${BASE}/sessions`

/** 设置页请求体上限：设置项都是短字符串，1 MiB 远够用，防止被灌爆内存。 */
export const JSON_BODY_LIMIT = 1024 * 1024

/** 工作区下拉的一项（与 `workspaceRegistry.list()` 同形）。 */
export interface WorkspaceEntry {
  id: string
  title?: string
  path: string
}

/** 网关状态里允许回给浏览器的字段；其余字段（未来可能出现的敏感值）一律丢弃。 */
export interface RouteStatus {
  state: string
  since?: number
  error?: string
  notice?: string
  lastSequence?: number
}

/** 路由取数据的接缝；设置页只读，真正的落盘、重连、清映射由 index 组合时提供。 */
export interface RouteDeps {
  state(): BridgeState
  patch(patch: Record<string, unknown>): Promise<void> | void
  reconnect(): void | Promise<void>
  /** 网关状态；响应只投影 `RouteStatus` 的已知字段。 */
  status(): object
  workspaces(): WorkspaceEntry[] | Promise<WorkspaceEntry[]>
  clearSession(key: string): void
  /** 审计钩子；由宿主侧写入 `$DSH_HOME/dsh-lanpost-bridge.audit.log`。 */
  audit?(kind: string, detail: Record<string, unknown>): void
  /** 日志钩子；仅用于未预期异常的记录。 */
  log?(message: string): void
}

/** 请求级错误：带 HTTP 状态码与稳定的错误码，由路由边界转成 JSON。 */
class HttpError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  if (address.startsWith('127.')) return true
  if (address === '::1') return true
  const mapped = '::ffff:'
  return address.startsWith(mapped) && address.slice(mapped.length).startsWith('127.')
}

/** 只信任 TCP 来源地址：本机浏览器经 loopback 连入；反向代理头一律不看。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress)
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  throw new HttpError(400, 'invalid-json')
}

/** 读取并解析 JSON 对象请求体：空体 / 非法 JSON / 非对象都是 400，超限是 413。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  let oversized = false
  for await (const chunk of req as AsyncIterable<unknown>) {
    const buffer = toBuffer(chunk)
    total += buffer.length
    if (total > JSON_BODY_LIMIT) {
      // 只保留上限内的字节，其余边读边丢：读完整请求再回 413，连接才能干净复用。
      oversized = true
      continue
    }
    chunks.push(buffer)
  }
  if (oversized) throw new HttpError(413, 'payload-too-large')
  if (total === 0) throw new HttpError(400, 'invalid-json')

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid-json')
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'invalid-json')
  return parsed
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value
}

/** 只读取对象自身的键；继承来的属性（含被污染的原型）一律视为未提供。 */
function own(input: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : undefined
}

/** 只保留白名单键，并做路由边界的两处归一：空字符串路径 → null，令牌 trim 后为空表示不改。 */
function cleanSettingsPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const enabled = own(input, 'enabled')
  if (typeof enabled === 'boolean') patch.enabled = enabled
  const gatewayAddress = own(input, 'gatewayAddress')
  if (typeof gatewayAddress === 'string') {
    const address = parseGatewayAddress(gatewayAddress)
    if (address === null) throw new HttpError(400, 'invalid-address')
    patch.gatewayAddress = address
  }
  const workspaceId = own(input, 'workspaceId')
  if (workspaceId === null) patch.workspaceId = null
  else if (typeof workspaceId === 'string') patch.workspaceId = nullIfEmpty(workspaceId)
  const selfProtocolId = own(input, 'selfProtocolId')
  if (typeof selfProtocolId === 'string') {
    patch.selfProtocolId = nullIfEmpty(selfProtocolId)
  } else if (selfProtocolId === null) {
    patch.selfProtocolId = null
  }
  const sessionMode = own(input, 'sessionMode')
  if (sessionMode === 'continue' || sessionMode === 'new') {
    patch.sessionMode = sessionMode
  }
  const showProcess = own(input, 'showProcess')
  if (typeof showProcess === 'boolean') patch.showProcess = showProcess
  const token = own(input, 'token')
  if (typeof token === 'string') {
    const trimmed = token.trim()
    if (trimmed !== '') patch.token = trimmed
  }
  return patch
}

/** 从网关状态里只挑已知字段，避免未来新增的敏感字段被整体展开到 HTTP 响应。 */
function pickStatus(status: object): RouteStatus {
  const record = isRecord(status) ? status : {}
  const state = record.state
  if (typeof state !== 'string') {
    throw new Error('lanpost-bridge route status is missing state')
  }
  const picked: RouteStatus = { state }
  if (typeof record.since === 'number') picked.since = record.since
  if (typeof record.error === 'string') picked.error = record.error
  if (typeof record.notice === 'string') picked.notice = record.notice
  if (typeof record.lastSequence === 'number') picked.lastSequence = record.lastSequence
  return picked
}

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? ''
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

/** `/sessions/<key>` 的 key 取最后一段并解码；缺段或非法百分号编码都是 400。 */
function sessionKeyOf(pathname: string): string {
  const prefix = `${SESSIONS}/`
  if (!pathname.startsWith(prefix)) throw new HttpError(400, 'missing-key')
  const last = pathname.slice(prefix.length).split('/').pop() ?? ''
  if (last === '') throw new HttpError(400, 'missing-key')
  try {
    return decodeURIComponent(last)
  } catch {
    throw new HttpError(400, 'invalid-key')
  }
}

type RouteWork = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** 统一的路由外壳：loopback → 方法白名单 → 业务 → 异常边界。 */
function makeRoute(
  kind: 'exact' | 'prefix',
  path: string,
  allowed: readonly string[],
  work: RouteWork,
  deps: RouteDeps,
): WebRouteLike {
  return {
    kind,
    path,
    async handler(req: IncomingMessage, res: ServerResponse) {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      if (!allowed.includes(req.method ?? '')) {
        res.setHeader('allow', allowed.join(', '))
        writeJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      try {
        await work(req, res)
      } catch (error) {
        if (error instanceof HttpError) {
          writeJson(res, error.statusCode, { error: error.code })
          return
        }
        // 只记方法与路径：query 里可能有令牌，下游 message 也可能回显敏感内容。
        deps.log?.(`lanpost-bridge route ${req.method ?? ''} ${requestPath(req)} failed`)
        writeJson(res, 500, { error: 'internal' })
      }
    },
  }
}

/** 组装五条路由；注册与卸载由 index 交给 `ctx.webServer`。 */
export function createRoutes(deps: RouteDeps): WebRouteLike[] {
  return [
    makeRoute(
      'exact',
      SETTINGS,
      ['GET', 'PATCH'],
      async (req, res) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { settings: publicSettings(deps.state()) })
          return
        }
        const patch = cleanSettingsPatch(await readJsonBody(req))
        const selected = own(patch, 'workspaceId')
        if (typeof selected === 'string') {
          // 工作区只能选 DSH 当前已打开的目录，不再支持手填路径。
          const known = (await deps.workspaces()).some((workspace) => workspace.id === selected)
          if (!known) throw new HttpError(400, 'unknown-workspace')
        }
        if (Object.keys(patch).length > 0) {
          await deps.patch(patch)
          deps.audit?.('settings.patch', { keys: Object.keys(patch).sort() })
        }
        writeJson(res, 200, { settings: publicSettings(deps.state()) })
      },
      deps,
    ),
    makeRoute(
      'exact',
      RECONNECT,
      ['POST'],
      async (_req, res) => {
        const state = deps.state()
        if (!state.enabled || state.gatewayAddress === '' || state.token === '') {
          writeJson(res, 409, { error: 'not-configured' })
          return
        }
        await deps.reconnect()
        writeJson(res, 200, { ok: true, status: pickStatus(deps.status()) })
      },
      deps,
    ),
    makeRoute(
      'exact',
      STATUS,
      ['GET'],
      (_req, res) => {
        const state = deps.state()
        writeJson(res, 200, {
          ...pickStatus(deps.status()),
          sessions: state.sessions,
          settings: publicSettings(state),
        })
      },
      deps,
    ),
    makeRoute(
      'exact',
      WORKSPACES,
      ['GET'],
      async (_req, res) => {
        writeJson(res, 200, { workspaces: await deps.workspaces() })
      },
      deps,
    ),
    makeRoute(
      'prefix',
      SESSIONS,
      ['DELETE'],
      (req, res) => {
        const key = sessionKeyOf(requestPath(req))
        const removed = Object.hasOwn(deps.state().sessions, key)
        deps.clearSession(key)
        deps.audit?.('sessions.delete', { key, removed })
        writeJson(res, 200, { ok: true, removed })
      },
      deps,
    ),
  ]
}

/** 设置页取公开设置时用的形状，转发 store 的定义。 */
export type { PublicSettings } from './store.ts'

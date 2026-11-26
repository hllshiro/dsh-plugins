// lanpost-bridge 唯一做类型断言的文件：DSH 服务取用桥。
// 已发布到 npm 的 `@deepseek-ai/dsh-*` 类型包与运行时版本不匹配，禁止 import 它们，
// 因此这里按宿主实际方法本地声明最小接口。服务取不到一律抛错（AGENTS：出错就地崩溃，无 fallback）。
import type { Context } from '@deepseek-ai/cordis'
import { appendAudit } from './audit.ts'

/** 工具注册服务（宿主 `ctx.tools`）。 */
export interface ToolsService {
  register(definition: ToolDefinitionLike): () => void
}

/** HTTP 路由注册服务（宿主 `ctx.webServer`）。 */
export interface WebServerService {
  register(route: WebRouteLike): () => void
}

/** 会话控制服务（宿主 `ctx.sessionController`）。 */
export interface SessionControllerService {
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

/** 工作区注册服务（宿主 `ctx.workspaceRegistry`）。 */
export interface WorkspaceRegistryService {
  list(): Array<{
    id: string
    title?: string
    path?: string
    record?: { title?: string; path?: string }
  }>
}

/** 提示段注册服务（宿主 `ctx.systemPrompt`）；`section()` 返回 Cordis effect disposer。 */
export interface SystemPromptService {
  section(section: { name: string; order: number; text: string }): () => void
}

/** 工具定义的最小形状：schema、参数、执行与结果渲染。 */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown, exec: { signal?: AbortSignal }): Promise<unknown>
}

/** HTTP 路由：`exact` 逐字匹配路径，`prefix` 匹配自身及其 `/` 子路径。 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: any, res: any): void | Promise<void>
}

/** 日志服务的最小形状（宿主 `ctx.logger`）。 */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 一段会话事件：桥接只关心消息来源、助手正文、工具调用与回合结束。 */
export type SessionEventLike =
  | { type: 'user/message'; data: { source?: { kind?: string; rpcId?: string } } }
  | {
      type: 'assistant/message'
      data: { message: { content: ReadonlyArray<{ type: string; text?: string }> } }
    }
  | { type: 'tool/call'; data: unknown }
  | { type: 'turn/end'; data: { reason: { kind: string } } }

/** 取工具服务；宿主没提供就抛错。 */
export function toolsOf(ctx: Context): ToolsService {
  const service = (ctx as unknown as { get(name: string): unknown }).get('tools')
  if (!service) throw new Error('lanpost-bridge: service "tools" unavailable')
  return service as ToolsService
}

/** 取 HTTP 路由服务；宿主没提供就抛错。 */
export function webServerOf(ctx: Context): WebServerService {
  const service = (ctx as unknown as { get(name: string): unknown }).get('webServer')
  if (!service) throw new Error('lanpost-bridge: service "webServer" unavailable')
  return service as WebServerService
}

/** 取会话控制服务；宿主没提供就抛错。 */
export function sessionControllerOf(ctx: Context): SessionControllerService {
  const service = (ctx as unknown as { get(name: string): unknown }).get('sessionController')
  if (!service) throw new Error('lanpost-bridge: service "sessionController" unavailable')
  return service as SessionControllerService
}

/** 取工作区注册服务；宿主没提供就抛错。 */
export function workspaceRegistryOf(ctx: Context): WorkspaceRegistryService {
  const service = (ctx as unknown as { get(name: string): unknown }).get('workspaceRegistry')
  if (!service) throw new Error('lanpost-bridge: service "workspaceRegistry" unavailable')
  return service as WorkspaceRegistryService
}

/** 取提示段注册服务；宿主没提供就抛错。 */
export function systemPromptOf(ctx: Context): SystemPromptService {
  const service = (ctx as unknown as { get(name: string): unknown }).get('systemPrompt')
  if (!service) throw new Error('lanpost-bridge: service "systemPrompt" unavailable')
  return service as SystemPromptService
}

/** 订阅 `session/event`；返回取消订阅的 disposer。 */
export function onSessionEvent(
  ctx: Context,
  handler: (session: { id: string }, event: SessionEventLike) => void,
): () => void {
  return (ctx as unknown as { on(event: string, handler: (...a: any[]) => void): () => void }).on(
    'session/event',
    handler,
  )
}

/** 取日志服务。logger 是 cordis 构造时直接挂在 ctx 上的属性，不经服务容器，所以不走 `ctx.get`。 */
export function loggerOf(ctx: Context): LoggerLike {
  const logger = ctx.logger
  if (!logger) throw new Error('lanpost-bridge: logger unavailable')
  return logger
}

/** 写一条审计记录，委托 `appendAudit`；home 为 `$DSH_HOME`。 */
export function writeAudit(home: string, kind: string, detail: Record<string, unknown>): void {
  appendAudit(home, kind, detail)
}

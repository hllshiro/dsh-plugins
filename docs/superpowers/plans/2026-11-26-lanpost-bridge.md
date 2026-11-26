# DSH ↔ lanpost-im 适配插件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/dsh-lanpost-bridge` 落地一个双面 DSH 插件：agent 能通过工具给 lanpost 发消息，lanpost 消息能触发并驱动 DSH 会话，结果回发到原会话，全部行为可在设置页配置。

**Architecture:** 宿主半（`src/index.ts`）装配三件事：一个 `ws` 网关客户端（`src/gateway.ts`，JSON-RPC + ACK 顺序 + 重连）、一个入站编排器（`src/bridge.ts`，过滤 → 建/取会话 → `ctx.sessionController.prompt` → 监听 `session/event` 等 `turn/end` → 回发）、三个 agent 工具与五个 loopback 路由。浏览器半（`src/client.ts`）在 `settings.section` 渲染配置页，全部读写走宿主路由。状态存 `$DSH_HOME/dsh-lanpost-bridge.json`（0600 原子写）。DSH 侧只经 `sessionController.create/prompt/rename` 与会话事件，不自己建 agent。

**Tech Stack:** TypeScript（tsdown 构建，host ESM + client `__ModuleLoader__` 包装）、cordis 4.1 插件 API、`ws` 8.23（自签证书需 `rejectUnauthorized:false`，Node 内置 WebSocket 不支持）、`node:test`（Node 24 原生跑 `.ts`，无需测试框架）。

**Spec:** `docs/superpowers/specs/2026-11-26-lanpost-bridge-design.md`

## Global Constraints

- 包名 `@hllshiro/dsh-lanpost-bridge`，行 id `our-dsh-lanpost-bridge`，目录 `packages/dsh-lanpost-bridge`。
- 本仓库**不是 git 仓库**：每个任务结尾不 `git commit`，改为运行该任务列出的验证命令并把结果贴进对话。
- 宿主半只具名导出 `name` / `inject` / `apply`，无 default export；每项注册必须经 `ctx.effect()` 记账，卸载回卷；不写模块级副作用。
- 语言常量（全部集中 `src/core.ts`）：文本上限 16×1024 字节、回复切段 4000 字节、每会话队列 20 条、等一轮 10 分钟、去重窗口 500 条、网关超时 `users.list` 10s / `send*` 30s / `ack` 10s / `resume` 15s / `login` 10s、重连退避 1s 起翻倍封顶 30s。
- group 触发前缀固定 `/^\/dsh(?:\s+|$)/i`。
- 令牌只落盘 `$DSH_HOME/dsh-lanpost-bridge.json`（0600），任何 HTTP 响应、工具输出、日志都不回显；错误信息不含令牌。
- 模型可见文本（工具描述、systemPrompt 段）保持常量字符串，不拼动态内容。
- 所有 `/api/lanpost-bridge/*` 路由先 `isLoopbackRequest(req)`，否则 403；不设 `auth:'anonymous'`（沿用默认 required）。
- 类型桥接集中在 `src/harness.ts`：只有该文件对 `ctx` 做类型断言，其余模块只 import 本地接口。
- 仓库根 `tsconfig.json` 增加 `allowImportingTsExtensions: true` 并把 `packages/*/test` 纳入 include（`node:test` 里用 `./x.ts` 显式后缀导入）。

## Review Focus

- **16 KiB / 多字节**：回复超过 4000 字节要分段且不切断 emoji 代理对；输入 UTF-8 超过 16 KiB 时发给网关要报清晰错误而不是 `-32013`。Task 2 的 `splitUtf8` 测试与 Task 7 的切段测试钉住。
- **至少一次投递**：同一 `event_id` 重复到达只能触发一次会话，但仍要 ACK。Task 6 去重测试钉住。
- **`/dsh` 边界**：`/dsh`、`/dsh ` 空正文、`/dshfoo`、`/DSH 你好` 四种输入的触发判定。Task 2 测试钉住。
- **会话被删**：映射到的 session 在 GUI 里被删后再来消息，应重建会话并重投一次，而不是回错误。Task 6 测试钉住。
- **空回复**：agent 只调工具、没产生文本时回复「（本轮没有文本回复）」，不发空消息。Task 7 测试钉住。

---

## 模块接口（所有任务共用的契约）

```ts
// src/core.ts
export const GROUP_TRIGGER: RegExp
export type SourceKind = 'private' | 'group'
export interface ReplySource { kind: SourceKind; name: string; username?: string; groupId?: string }
/** 群消息按 /dsh 前缀判定；命中返回剥前缀后的正文（可能为空串），不命中返回 null。私聊调用方直接传原文。 */
export function stripGroupTrigger(text: string): string | null
/** 按 UTF-8 字节切分，单段不超过 maxBytes，不产生半个字符；maxBytes <= 0 抛错。 */
export function splitUtf8(text: string, maxBytes: number): string[]
/** 回复切段：超过 4000 字节时分成多段并在每段前加 `(i/n) ` 角标（角标计入预算）。 */
export function replyParts(text: string): string[]
/** 投给 agent 的正文：首行来源说明 + 空行 + 正文。 */
export function promptTextFor(source: ReplySource, text: string): string
/** 去重窗口：已在窗口内返回 {added:false}，否则前插并裁到 limit。 */
export function dedupeAdd(list: readonly string[], id: string, limit: number): { list: string[]; added: boolean }
export function formatDuration(ms: number): string
```

```ts
// src/store.ts
export interface BridgeSettings {
  enabled: boolean
  gatewayUrl: string
  token: string
  workspaceId: string | null
  workspacePath: string | null
  sessionMode: 'continue' | 'new'
  showProcess: boolean
  selfProtocolId: string | null
}
export interface SessionMapEntry { sessionId: string; updatedAt: string }
export interface BridgeState extends BridgeSettings {
  version: 1
  lastSequence: number
  seenEventIds: string[]
  sessions: Record<string, SessionMapEntry>
}
export const DEFAULTS: BridgeState
export function statePath(home?: string): string
export function loadState(home?: string): BridgeState
export function saveState(state: BridgeState, home?: string): void
export interface PublicSettings extends Omit<BridgeSettings, 'token'> { tokenSet: boolean }
export function publicSettings(state: BridgeState): PublicSettings
export function mergeSettings(state: BridgeState, patch: Record<string, unknown>): BridgeState
```

```ts
// src/gateway.ts
export interface GatewayStatus { state: 'idle' | 'connecting' | 'connected' | 'error'; since?: number; error?: string }
export interface InboundMessage {
  eventId: string; sequence: number; messageId: string
  conversationType: 'private' | 'group'; groupId?: string
  sender: { protocolId: string; username: string; displayName?: string }
  content: { type: 'text'; text: string } | { type: 'image'; mimeType: string; name?: string }
  timestamp: string
}
export interface GatewayEvents {
  onMessage(event: InboundMessage): void | Promise<void>
  onDelivery(status: { messageId?: string; status: string; reason?: string }): void
  onState(status: GatewayStatus): void
}
export interface GatewayTransport {
  send(data: string): void
  close(): void
  on(event: 'open' | 'close' | 'message' | 'error', handler: (arg: any) => void): void
}
export function createTransport(url: string): GatewayTransport
export class LanpostGateway {
  constructor(options: { url: string; token: string; lastSequence: number; events: GatewayEvents })
  start(): void
  stop(): void
  status(): GatewayStatus
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  sendUser(protocolId: string, text: string): Promise<{ message_id: string; delivery_status: string }>
  sendGroup(groupId: string, text: string): Promise<{ message_id: string; delivery_status: string }>
}
```

```ts
// src/bridge.ts
export interface InboundDeps {
  state(): BridgeState
  update(mutate: (state: BridgeState) => void): void
  sessions: {
    create(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string }>
    prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> }, signal: AbortSignal): Promise<{ accepted: true }>
    rename(request: { sessionId: string; title: string }): Promise<unknown>
  }
  send(target: { kind: 'user'; protocolId: string } | { kind: 'group'; groupId: string }, text: string): Promise<{ message_id: string; delivery_status: string }>
  onSessionEvent(handler: (sessionId: string, event: SessionEventLike) => void): () => void
  log(message: string): void
  now?(): number
}
export type SessionEventLike =
  | { type: 'user/message'; data: { source?: { kind?: string; rpcId?: string } } }
  | { type: 'assistant/message'; data: { message: { content: ReadonlyArray<{ type: string; text?: string }> } } }
  | { type: 'tool/call'; data: unknown }
  | { type: 'turn/end'; data: { reason: { kind: string } } }
export class InboundBridge {
  constructor(deps: InboundDeps)
  /** 处理一条 message.received；内部负责 ACK 回调由 gateway 侧触发，这里只保证不抛。 */
  handleMessage(event: InboundMessage): Promise<void>
  handleDelivery(status: { messageId?: string; status: string; reason?: string }): void
  dispose(): void
}
```

```ts
// src/tools.ts
export function createTools(deps: { gateway(): LanpostGateway | undefined }): ToolDefinitionLike[]
```

```ts
// src/routes.ts
export interface RouteDeps {
  state(): BridgeState
  patch(patch: Record<string, unknown>): Promise<void> | void
  reconnect(): void
  status(): unknown
  workspaces(): Array<{ id: string; title?: string; path: string }>
  clearSession(key: string): void
}
export function createRoutes(deps: RouteDeps): WebRouteLike[]
```

```ts
// src/harness.ts（唯一做类型断言的文件）
export interface ToolsService { register(definition: ToolDefinitionLike): () => void }
export interface WebServerService { register(route: WebRouteLike): () => void }
export interface SessionControllerService { create(...): ...; prompt(...): ...; rename(...): ... }
export interface WorkspaceRegistryService { list(): Array<{ id: string; title?: string; path: string }> }
export interface ToolDefinitionLike { name: string; description: string; parameters: Record<string, unknown>; output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> }; execute(args: unknown, exec: { signal?: AbortSignal }): Promise<unknown> }
export interface WebRouteLike { kind: 'exact'; path: string; handler(req: any, res: any): void | Promise<void> }
export function toolsOf(ctx: Context): ToolsService
export function webServerOf(ctx: Context): WebServerService
export function sessionControllerOf(ctx: Context): SessionControllerService
export function workspaceRegistryOf(ctx: Context): WorkspaceRegistryService
export function onSessionEvent(ctx: Context, handler: (session: { id: string }, event: SessionEventLike) => void): () => void
export function loggerOf(ctx: Context): { info(message: string): void; warn(message: string): void; error(message: string): void }
export function writeAudit(home: string, kind: string, detail: Record<string, unknown>): void
```

---

### Task 1: 包骨架、构建外置 ws、注入验证

**Files:**
- Create: `packages/dsh-lanpost-bridge/package.json`
- Create: `packages/dsh-lanpost-bridge/cordis.patch.yml`
- Create: `packages/dsh-lanpost-bridge/tsdown.config.ts`
- Create: `packages/dsh-lanpost-bridge/src/index.ts`（本任务只放空 apply 与常量导出）
- Create: `packages/dsh-lanpost-bridge/src/client.ts`（空 apply 桩，避免客户端 404）
- Create: `packages/dsh-lanpost-bridge/README.md`（占位，Task 12 补全）
- Modify: `scripts/plugin-build.ts`（给 `pluginBuilds` 增加 `external?: readonly string[]`，并入 `neverBundle`）
- Modify: `tsconfig.json`（加 `allowImportingTsExtensions: true`，include 加 `packages/*/test`）
- Modify: `pnpm-workspace.yaml`（catalog 增加 `ws: ^8.23.0`）
- Modify: `README.md`（插件表加一行 `@hllshiro/dsh-lanpost-bridge` / `our-dsh-lanpost-bridge` / host+client）

**Interfaces:**
- Consumes: 无。
- Produces: 可构建、可注入的空插件；`pluginBuilds(dir, { client: true, external: ['ws'] })` 签名。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "@hllshiro/dsh-lanpost-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } },
  "files": ["lib", "cordis.patch.yml"],
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "test": "node --test \"test/*.test.ts\""
  },
  "dependencies": { "ws": "catalog:" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "devDependencies": {
    "@deepseek-ai/cordis": "catalog:",
    "@types/node": "^24.0.0",
    "tsdown": "catalog:"
  }
}
```

- [ ] **Step 2: 写 cordis.patch.yml 与 tsdown.config.ts**

`cordis.patch.yml`：

```yaml
# lanpost-im 适配插件的组合行：宿主半与浏览器半同包
- insert:
    - id: our-dsh-lanpost-bridge
      name: '@hllshiro/dsh-lanpost-bridge'
```

`tsdown.config.ts`：

```ts
import { pluginBuilds } from '../../scripts/plugin-build'
export default pluginBuilds(import.meta.dirname, { client: true, external: ['ws'] })
```

- [ ] **Step 3: 给 pluginBuilds 加 external 选项**

`scripts/plugin-build.ts`：签名改 `export function pluginBuilds(packageDir: string, options: { client?: boolean; external?: readonly string[] } = {})`；`isExternal` 里追加 `options.external?.includes(specifier) ?? false`。

- [ ] **Step 4: 写空插件入口与客户端桩**

`src/index.ts`：`export const name = 'our-dsh-lanpost-bridge'`，`export const inject = ['tools', 'webServer', 'sessionController']`，`export function apply(ctx) { ctx.logger.info('lanpost-bridge activated') }`。
`src/client.ts`：`export function apply(_ctx) {}`。

- [ ] **Step 5: 安装依赖并构建**

Run: `pnpm install` → 期望 `+ ws 8.23.0` 落到 `packages/dsh-lanpost-bridge/node_modules/ws`。
Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge build` → 期望产出 `lib/index.js` 与 `lib/client.js`；`lib/index.js` 里 `ws` 保持 `import ... from "ws"`（外置，未被内联）。

- [ ] **Step 6: 类型检查与注入验证**

Run: `pnpm run check` → PASS。
Run: `$env:DSH_HOME='D:\hllshiro\ai-agent-plugins\.dsh-dev'; node scripts/inject.mjs` → 期望末行含 `✓ our-dsh-lanpost-bridge ← @hllshiro/dsh-lanpost-bridge`；再 `dsh --profile web --dump-config` 里 our- 行共 3 条。

---

### Task 2: `src/core.ts` 纯函数（TDD）

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/core.ts`
- Test: `packages/dsh-lanpost-bridge/test/core.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: 上文 `src/core.ts` 全部导出（`stripGroupTrigger`、`splitUtf8`、`replyParts`、`promptTextFor`、`dedupeAdd`、`formatDuration`、`GROUP_TRIGGER`）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeAdd, formatDuration, promptTextFor, replyParts, splitUtf8, stripGroupTrigger } from '../src/core.ts'

test('群前缀：命中剥掉，不命中返回 null', () => {
  assert.equal(stripGroupTrigger('/dsh 今天天气如何？'), '今天天气如何？')
  assert.equal(stripGroupTrigger('/DSH 你好'), '你好')
  assert.equal(stripGroupTrigger('/dsh'), '')
  assert.equal(stripGroupTrigger('/dshfoo'), null)
  assert.equal(stripGroupTrigger('今天天气'), null)
})

test('splitUtf8 不切坏多字节字符且不超预算', () => {
  const parts = splitUtf8('你好世界'.repeat(100), 7)
  assert.ok(parts.every((p) => Buffer.byteLength(p, 'utf8') <= 7))
  assert.equal(parts.join(''), '你好世界'.repeat(100))
  const emoji = splitUtf8('😀😀😀', 4)
  assert.deepEqual(emoji, ['😀', '😀', '😀'])
  assert.throws(() => splitUtf8('x', 0))
})

test('replyParts 超过 4000 字节才切段且带角标', () => {
  assert.deepEqual(replyParts('短回复'), ['短回复'])
  const long = '啊'.repeat(3000) // 9000 字节
  const parts = replyParts(long)
  assert.equal(parts.length, 3)
  assert.ok(parts[0].startsWith('(1/3) '))
  assert.ok(parts.every((p) => Buffer.byteLength(p, 'utf8') <= 4000))
})

test('promptTextFor 首行带来源', () => {
  assert.equal(
    promptTextFor({ kind: 'private', name: '张三', username: 'zhangsan' }, '你好'),
    '[lanpost 私聊 · 张三 (zhangsan)]\n\n你好',
  )
  assert.equal(
    promptTextFor({ kind: 'group', name: '李四', username: 'lisi', groupId: '998877' }, '你好'),
    '[lanpost 群 998877 · 李四 (lisi)]\n\n你好',
  )
})

test('dedupeAdd 窗口上限与重复判定', () => {
  let list: string[] = []
  for (const id of ['a', 'b', 'c']) list = dedupeAdd(list, id, 2).list
  assert.deepEqual(list, ['c', 'b'])
  assert.equal(dedupeAdd(list, 'c', 2).added, false)
})

test('formatDuration', () => {
  assert.equal(formatDuration(12300), '12.3s')
  assert.equal(formatDuration(65000), '1m 5s')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/core.ts'`。

- [ ] **Step 3: 实现 core.ts**

按接口实现：`GROUP_TRIGGER = /^\/dsh(?:\s+|$)/i`；`stripGroupTrigger` 用 `text.replace(GROUP_TRIGGER, '')` 且命中判断用 `GROUP_TRIGGER.test`；`splitUtf8` 逐码点累加 `Buffer.byteLength`，超预算就换段（单码点本身超预算时单独成段）；`replyParts` 先按 4000−角标长度切，若段数 1 返回原文；`promptTextFor` 按上面测试的两种格式；`dedupeAdd` 用 `includes` 判重、`[id, ...list].slice(0, limit)`；`formatDuration` `<60000` 输出 `(ms/1000).toFixed(1)+'s'`，否则 `Math.floor(ms/60000)+'m '+Math.round((ms%60000)/1000)+'s'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 6 个测试全 PASS。

---

### Task 3: `src/store.ts` 状态文件（TDD）

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/store.ts`
- Test: `packages/dsh-lanpost-bridge/test/store.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `statePath`/`loadState`/`saveState`/`publicSettings`/`mergeSettings`/`DEFAULTS`/`BridgeState`/`BridgeSettings`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, loadState, mergeSettings, publicSettings, saveState, statePath } from '../src/store.ts'

const home = () => mkdtempSync(join(tmpdir(), 'lanpost-bridge-'))

test('缺文件时返回默认值且不落盘', () => {
  const dir = home()
  assert.deepEqual(loadState(dir), DEFAULTS)
  assert.equal(statSync(dir).isDirectory(), true)
})

test('保存后可读回，文件权限 0600', () => {
  const dir = home()
  const state = mergeSettings(DEFAULTS, { gatewayUrl: 'wss://127.0.0.1:1/ws/dsh', token: 'secret-token' })
  saveState(state, dir)
  assert.equal(loadState(dir).gatewayUrl, 'wss://127.0.0.1:1/ws/dsh')
  assert.equal(loadState(dir).token, 'secret-token')
  if (process.platform !== 'win32') assert.equal(statSync(statePath(dir)).mode & 0o777, 0o600)
})

test('publicSettings 不回显令牌', () => {
  const pub = publicSettings(mergeSettings(DEFAULTS, { token: 'secret-token' }))
  assert.equal(pub.tokenSet, true)
  assert.equal('token' in pub, false)
})

test('mergeSettings 忽略未知键，空 token 表示不改', () => {
  const base = mergeSettings(DEFAULTS, { token: 'keep-me' })
  const next = mergeSettings(base, { token: '', bogus: 1, sessionMode: 'new' })
  assert.equal(next.token, 'keep-me')
  assert.equal(next.sessionMode, 'new')
  assert.equal('bogus' in next, false)
})

test('损坏文件回退默认值', () => {
  const dir = home()
  writeFileSync(statePath(dir), '{not json')
  assert.deepEqual(loadState(dir), DEFAULTS)
  assert.equal(readFileSync(statePath(dir), 'utf8').length > 0, true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/store.ts'`。

- [ ] **Step 3: 实现 store.ts**

`statePath(home = process.env.DSH_HOME ?? join(homedir(), '.dsh'))` → `join(home, 'dsh-lanpost-bridge.json')`；`loadState` 读不到或 JSON 解析失败返回 `{...DEFAULTS}`（`sessions: {}`、`seenEventIds: []` 每次新数组）；`saveState` 先写 `${path}.tmp` 再 `renameSync`，`mode: 0o600`；`publicSettings` 解构掉 `token` 并加 `tokenSet: token !== ''`；`mergeSettings` 白名单键 `enabled/gatewayUrl/workspaceId/workspacePath/sessionMode/showProcess/selfProtocolId/token`，`token: ''` 或非字符串忽略，`sessionMode` 只接受 `continue|new`，`workspaceId/workspacePath/selfProtocolId` 接受 `string | null`。`DEFAULTS`：`enabled: false`、`gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh'`、`token: ''`、`workspaceId: null`、`workspacePath: null`、`sessionMode: 'continue'`、`showProcess: false`、`selfProtocolId: null`、`version: 1`、`lastSequence: 0`、`seenEventIds: []`、`sessions: {}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 全 PASS。

---

### Task 4: `src/harness.ts` 类型桥 + `src/audit.ts`

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/harness.ts`
- Create: `packages/dsh-lanpost-bridge/src/audit.ts`
- Test: `packages/dsh-lanpost-bridge/test/audit.test.ts`

**Interfaces:**
- Consumes: `@deepseek-ai/cordis` 的 `Context` 类型（已在 repо 依赖）。
- Produces: 上文 `harness.ts` 全部访问器与 `writeAudit(home, kind, detail)`；`audit.ts` 的 `auditLine(kind, detail, iso)` 供测试。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditLine, auditPath, appendAudit } from '../src/audit.ts'

test('audit 行格式：ISO 制表 kind 制表 JSON', () => {
  const line = auditLine('inbound', { conversationId: 'direct:x' }, '2026-11-26T02:00:00.000Z')
  assert.equal(line, '2026-11-26T02:00:00.000Z\tinbound\t{"conversationId":"direct:x"}')
})

test('appendAudit 追加到 $DSH_HOME 文件', () => {
  const home = mkdtempSync(join(tmpdir(), 'lanpost-audit-'))
  appendAudit(home, 'reply', { bytes: 12 })
  appendAudit(home, 'reply', { bytes: 34 })
  const text = readFileSync(auditPath(home), 'utf8')
  assert.equal(text.trim().split('\n').length, 2)
  assert.match(text, /\treply\t\{"bytes":34\}/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/audit.ts'`。

- [ ] **Step 3: 实现 audit.ts 与 harness.ts**

`audit.ts`：`auditPath(home) = join(home, 'dsh-lanpost-bridge.audit.log')`；`auditLine` 按测试格式；`appendAudit` 用 `appendFileSync(path, line + '\n', { mode: 0o600 })`。
`harness.ts`：每个访问器都写成 `const service = (ctx as unknown as { get(name: string): unknown }).get(name)`，取不到直接 `throw new Error('lanpost-bridge: service "<name>" unavailable')`（AGENTS：出错就地崩溃，无 fallback）；`onSessionEvent` 用 `(ctx as unknown as { on(event: string, handler: (...a: any[]) => void): () => void }).on('session/event', handler)`；`writeAudit` 委托 `appendAudit`；接口形状照上文契约。

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → PASS。
Run: `pnpm run check` → PASS（确认 `Context` 导入与断言写法可编译）。

---

### Task 5: `src/gateway.ts` 网关客户端（TDD，假 transport）

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/gateway.ts`
- Test: `packages/dsh-lanpost-bridge/test/gateway.test.ts`

**Interfaces:**
- Consumes: `ws`、`core` 的 `dedupeAdd`。
- Produces: `LanpostGateway`（构造、`start`/`stop`/`status`/`call`/`sendUser`/`sendGroup`）、`createTransport`、`InboundMessage`、`GatewayEvents`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LanpostGateway } from '../src/gateway.ts'

function fakeTransport() {
  const sent: string[] = []
  const handlers = new Map<string, (arg: any) => void>()
  return {
    sent,
    transport: {
      send: (data: string) => sent.push(data),
      close: () => handlers.get('close')?.({ code: 1000 }),
      on: (event: string, handler: (arg: any) => void) => handlers.set(event, handler),
    },
    emit: (event: string, arg?: unknown) => handlers.get(event)?.(arg),
  }
}

test('连接后按登录、订阅、resume 顺序发帧', () => {
  const f = fakeTransport()
  const gw = new LanpostGateway({ url: 'wss://x/ws', token: 'tok', lastSequence: 7, events: {}, transport: f.transport } as any)
  gw.start()
  f.emit('open')
  const methods = f.sent.map((line) => JSON.parse(line).method)
  assert.deepEqual(methods, ['rpc.login', 'subscribe', 'events.resume'])
  assert.deepEqual(JSON.parse(f.sent[0]).params, { token: 'tok' })
  assert.deepEqual(JSON.parse(f.sent[2]).params, { last_sequence: 7 })
})

test('ACK 严格按 sequence 递增，乱序先不发', () => {
  const f = fakeTransport()
  const gw = new LanpostGateway({ url: 'wss://x/ws', token: 't', lastSequence: 0, events: {}, transport: f.transport } as any)
  gw.start(); f.emit('open')
  gw.noteEvent(3); gw.noteEvent(1)
  const acks = () => f.sent.map((l) => JSON.parse(l)).filter((m) => m.method === 'events.ack').map((m) => m.params.sequence)
  assert.deepEqual(acks(), [1])
  gw.noteEvent(2)
  assert.deepEqual(acks(), [1, 2, 3])
})

test('收到 message.received 通知转为 InboundMessage 交给 events.onMessage', async () => {
  const f = fakeTransport()
  const got: any[] = []
  const gw = new LanpostGateway({ url: 'wss://x/ws', token: 't', lastSequence: 0, events: { onMessage: (e) => got.push(e) }, transport: f.transport } as any)
  gw.start(); f.emit('open')
  f.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'message.received', params: {
    event_id: 'evt_1', sequence: 1, method: 'message.received',
    data: { message_id: 'm1', conversation_id: 'direct:p1', conversation_type: 'private',
      sender: { protocol_id: 'p1', username: 'zhangsan', display_name: '张三' },
      content: { type: 'text', text: '你好' }, timestamp: '2026-11-26T02:00:00Z' } } }))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(got.length, 1)
  assert.equal(got[0].conversationType, 'private')
  assert.equal(got[0].sender.displayName, '张三')
})

test('4401 关闭后停止重连并报错', () => {
  const f = fakeTransport()
  const gw = new LanpostGateway({ url: 'wss://x/ws', token: 't', lastSequence: 0, events: {}, transport: f.transport } as any)
  gw.start(); f.emit('open')
  f.emit('close', { code: 4401 })
  assert.equal(gw.status().state, 'error')
  assert.match(gw.status().error!, /令牌/)
})

test('call 超时拒绝', async () => {
  const f = fakeTransport()
  const gw = new LanpostGateway({ url: 'wss://x/ws', token: 't', lastSequence: 0, events: {}, transport: f.transport } as any)
  gw.start(); f.emit('open')
  await assert.rejects(gw.call('users.list', {}, 10), /timeout|超时/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/gateway.ts'`。

- [ ] **Step 3: 实现 gateway.ts**

要点：
- 构造参数额外接受可选的 `transport?: GatewayTransport`（测试注入；生产用 `createTransport(url)`），`createTransport` 用 `new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 10_000 })`。
- `start()`：建 transport，`on('open')` 后依次 `call('rpc.login',{token},10_000)`、`call('subscribe',['message.received','message.deliveryStatus'],10_000)`、`call('events.resume',{last_sequence},15_000)`；login 返回非 `true` 报错；全部完成置 `connected` 并回调 `onState`。
- `call` 维护 `pending: Map<id, {resolve,reject,timer}>`，自增 `id`；`on('message')` 里解析 JSON：有 `id` 归位（`error` → reject `GatewayError(code,message)`），无 `id` 且 `method` 为事件 → 走 `dispatchNotification`。
- `dispatchNotification(params)`：`data` 交给 `events.onMessage`（转成 `InboundMessage`，文本/图片判定），`deliveryStatus` 交给 `onDelivery`；随后 `noteEvent(sequence)`。
- `noteEvent(seq)`：放入 `pendingAcks: Set<number>`，`while (pendingAcks.has(nextSeq)) { sendAck(nextSeq); nextSeq++ }`，ACK 用 `call('events.ack',{event_id,sequence},10_000)` 但失败只记日志不抛；需要按 seq 找 event_id → 用 `Map<number,string>`。
- `close`：`4401` → 清定时器、状态 `error`、`error = '令牌已轮换，请更新令牌'`、不再重连；`4409` → `error = '连接数超限'` 并退避；其他 → `disconnected` 后 `scheduleReconnect()`（1s 起翻倍封顶 30s，±20% 抖动）。
- `sendUser`/`sendGroup`：`call('message.sendUser',{ request_id: crypto.randomUUID(), protocol_id, content: { type:'text', text } }, 30_000)`；群同理用 `group_id`。超过 16 KiB 抛 `new Error('消息超过 16 KiB 上限')`。
- `status()` 返回 `{ state, since, error }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 5 个网关测试全 PASS。

---

### Task 6: `src/bridge.ts` 入站过滤、会话映射、串行队列（TDD，假 controller）

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/bridge.ts`（本任务只实现 `handleMessage` 的过滤/建会话/投递部分，回复收集留给 Task 7）
- Test: `packages/dsh-lanpost-bridge/test/bridge.inbound.test.ts`

**Interfaces:**
- Consumes: `core`（`stripGroupTrigger`、`promptTextFor`、`dedupeAdd`）、`store` 类型。
- Produces: `InboundBridge` 与 `InboundDeps`（Task 7 在同一文件追加回复收集）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InboundBridge } from '../src/bridge.ts'
import { DEFAULTS } from '../src/store.ts'

function setup(overrides: any = {}) {
  const state: any = { ...DEFAULTS, enabled: true, ...overrides.state }
  const prompts: any[] = []
  const created: any[] = []
  const sent: any[] = []
  const deps = {
    state: () => state,
    update: (mutate: (s: any) => void) => mutate(state),
    sessions: {
      create: async (req: any) => { created.push(req); return { sessionId: 'sess-' + created.length } },
      prompt: async (req: any) => { prompts.push(req); return { accepted: true } },
      rename: async () => ({}),
    },
    send: async (target: any, text: string) => { sent.push({ target, text }); return { message_id: 'm', delivery_status: 'queued' } },
    onSessionEvent: () => () => {},
    log: () => {},
    ...overrides.deps,
  }
  return { bridge: new InboundBridge(deps), prompts, created, sent, state }
}

const msg = (data: Partial<any> = {}) => ({
  eventId: 'evt_1', sequence: 1, messageId: 'm1', conversationType: 'private',
  sender: { protocolId: 'p1', username: 'zhangsan', displayName: '张三' },
  content: { type: 'text', text: '你好' }, timestamp: '2026-11-26T02:00:00Z', ...data,
})

test('私聊文本：建会话并投递带来源说明的 prompt', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg())
  assert.equal(s.created.length, 1)
  assert.equal(s.prompts[0].sessionId, 'sess-1')
  assert.equal(s.prompts[0].content[0].text, '[lanpost 私聊 · 张三 (zhangsan)]\n\n你好')
})

test('会话模式 continue 复用映射，new 每条新建', async () => {
  const cont = setup()
  await cont.bridge.handleMessage(msg({ eventId: 'e1', messageId: 'm1' }))
  await cont.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2' }))
  assert.equal(cont.created.length, 0 + 1)
  assert.equal(cont.prompts[1].sessionId, 'sess-1')

  const fresh = setup({ state: { sessionMode: 'new' } })
  await fresh.bridge.handleMessage(msg({ eventId: 'e1', messageId: 'm1' }))
  await fresh.bridge.handleMessage(msg({ eventId: 'e2', messageId: 'm2' }))
  assert.equal(fresh.prompts[0].sessionId !== fresh.prompts[1].sessionId, true)
})

test('群消息无 /dsh 前缀不触发，有前缀剥掉', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ eventId: 'e1', conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '大家好' } }))
  assert.equal(s.prompts.length, 0)
  await s.bridge.handleMessage(msg({ eventId: 'e2', conversationType: 'group', groupId: 'g1', content: { type: 'text', text: '/dsh 帮我看下' } }))
  assert.equal(s.prompts.length, 1)
  assert.match(s.prompts[0].content[0].text, /\[lanpost 群 g1 · 张三 \(zhangsan\)\]\n\n帮我看下$/)
})

test('图片消息不触发，回一句暂不支持', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ content: { type: 'image', mimeType: 'image/png' } }))
  assert.equal(s.prompts.length, 0)
  assert.equal(s.sent[0].text, '暂不支持图片消息（当前仅支持文本）。')
  assert.deepEqual(s.sent[0].target, { kind: 'user', protocolId: 'p1' })
})

test('同一 event_id 重复到达只处理一次', async () => {
  const s = setup()
  await s.bridge.handleMessage(msg({ eventId: 'same', messageId: 'm1' }))
  await s.bridge.handleMessage(msg({ eventId: 'same', messageId: 'm1' }))
  assert.equal(s.prompts.length, 1)
})

test('会话被删后重建一次并重投', async () => {
  let calls = 0
  const s = setup({ deps: { sessions: {
    create: async () => ({ sessionId: 'sess-new' }),
    prompt: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('not found'), { code: 'session/not-found' }); return { accepted: true } },
    rename: async () => ({}),
  } } })
  await s.bridge.handleMessage(msg())
  assert.equal(calls, 2)
})

test('来源自回环被丢弃', async () => {
  const s = setup({ state: { selfProtocolId: 'p1' } })
  await s.bridge.handleMessage(msg())
  assert.equal(s.prompts.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/bridge.ts'`。

- [ ] **Step 3: 实现 bridge.ts（入站部分）**

要点：`handleMessage(event)` = 去重（`dedupeAdd(state.seenEventIds, event.eventId, 500)`，未新增直接 return；处理完 `deps.update` 落盘）→ `selfProtocolId` 命中丢弃 → 判定来源与正文（私聊取原文；群走 `stripGroupTrigger`，`null` 或空串则丢弃）→ 图片走固定回复 → 非文本丢弃 → 会话键 `direct:<protocolId>` / `group:<groupId>` → 取/建会话（按 `sessionMode`；`continue` 时命中映射直接复用；`create` 传 `workspaceId ?? undefined` / `cwd: workspacePath ?? undefined`，两者互斥）→ `rename` 标题 `lanpost · <displayName||username|group <id>>`（失败 log 不抛）→ 每个会话键一条 promise 链串行，队列计数超 20 回「我这边还排着 20 条消息，稍后再发。」→ `prompt({ requestId: 'lanpost-' + randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: promptTextFor(...) }] }, AbortSignal.timeout(30_000))`；`prompt` 抛 `session/not-found` 时删映射、重建、重投一次；其他错误回「会话忙或不可用：<message>」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 7 个入站测试 PASS。

---

### Task 7: `src/bridge.ts` 回复收集与回发（TDD）

**Files:**
- Modify: `packages/dsh-lanpost-bridge/src/bridge.ts`
- Test: `packages/dsh-lanpost-bridge/test/bridge.reply.test.ts`

**Interfaces:**
- Consumes: `core` 的 `replyParts`、`formatDuration`；`InboundDeps.onSessionEvent`。
- Produces: 完整的 `InboundBridge`（`handleMessage` 现在会等待并回发）。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InboundBridge } from '../src/bridge.ts'
import { DEFAULTS } from '../src/store.ts'

function setup(overrides: any = {}) {
  const state: any = { ...DEFAULTS, enabled: true, ...overrides.state }
  const prompts: any[] = []
  const sent: any[] = []
  let listener: ((sessionId: string, event: any) => void) | undefined
  const deps = {
    state: () => state,
    update: (mutate: (s: any) => void) => mutate(state),
    sessions: {
      create: async () => ({ sessionId: 'sess-1' }),
      prompt: async (req: any) => { prompts.push(req); return { accepted: true } },
      rename: async () => ({}),
    },
    send: async (target: any, text: string) => { sent.push({ target, text }); return { message_id: 'm', delivery_status: 'queued' } },
    onSessionEvent: (handler: any) => { listener = handler; return () => {} },
    log: () => {},
    ...overrides.deps,
  }
  const bridge = new InboundBridge(deps)
  return { bridge, prompts, sent, state, emit: (sessionId: string, event: any) => listener?.(sessionId, event) }
}

const msg = (data: Partial<any> = {}) => ({
  eventId: 'evt_1', sequence: 1, messageId: 'm1', conversationType: 'private',
  sender: { protocolId: 'p1', username: 'zhangsan', displayName: '张三' },
  content: { type: 'text', text: '你好' }, timestamp: '2026-11-26T02:00:00Z', ...data,
})

test('turn/end 后把最终文本回发到私聊', async () => {
  const s = setup()
  const done = s.bridge.handleMessage(msg())
  await new Promise((r) => setTimeout(r, 0))
  const rpcId = s.prompts[0].requestId
  s.emit('sess-1', { type: 'user/message', data: { source: { kind: 'user', rpcId } } })
  s.emit('sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '答案' }] } } })
  s.emit('sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await done
  assert.equal(s.sent[0].text, '答案')
  assert.deepEqual(s.sent[0].target, { kind: 'user', protocolId: 'p1' })
})

test('没有文本回复时发占位句', async () => {
  const s = setup()
  const done = s.bridge.handleMessage(msg())
  await new Promise((r) => setTimeout(r, 0))
  const rpcId = s.prompts[0].requestId
  s.emit('sess-1', { type: 'user/message', data: { source: { rpcId } } })
  s.emit('sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await done
  assert.equal(s.sent[0].text, '（本轮没有文本回复）')
})

test('showProcess 打开时附用时与工具次数', async () => {
  const s = setup({ state: { showProcess: true } })
  const done = s.bridge.handleMessage(msg())
  await new Promise((r) => setTimeout(r, 0))
  const rpcId = s.prompts[0].requestId
  s.emit('sess-1', { type: 'user/message', data: { source: { rpcId } } })
  s.emit('sess-1', { type: 'tool/call', data: {} })
  s.emit('sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答案' }] } } })
  s.emit('sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await done
  assert.match(s.sent[0].text, /^答案\n\n— 用时 .*，工具 1 次$/)
})

test('异常结束的回合给出原因', async () => {
  const s = setup()
  const done = s.bridge.handleMessage(msg())
  await new Promise((r) => setTimeout(r, 0))
  const rpcId = s.prompts[0].requestId
  s.emit('sess-1', { type: 'user/message', data: { source: { rpcId } } })
  s.emit('sess-1', { type: 'turn/end', data: { reason: { kind: 'error' } } })
  await done
  assert.match(s.sent[0].text, /没有正常完成（error）/)
})

test('超长回复按段发送', async () => {
  const s = setup()
  const done = s.bridge.handleMessage(msg())
  await new Promise((r) => setTimeout(r, 0))
  const rpcId = s.prompts[0].requestId
  s.emit('sess-1', { type: 'user/message', data: { source: { rpcId } } })
  s.emit('sess-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '啊'.repeat(3000) }] } } })
  s.emit('sess-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await done
  assert.equal(s.sent.length, 3)
  assert.ok(s.sent[0].text.startsWith('(1/3) '))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望回复断言失败（当前实现还没等待/回发）。

- [ ] **Step 3: 实现回复收集**

要点：构造函数里 `this.unsubscribe = deps.onSessionEvent((sessionId, event) => this.observe(sessionId, event))`。每个排队的消息创建一个 `waiter = { sessionId, rpcId, started: false, texts: [], reasoning: [], tools: 0, resolve, timer }` 放进 `Map<rpcId, waiter>`，并 `await waiter.promise`（`AbortSignal.timeout(10*60_000)` 竞速）。`observe`：`user/message` 且 `source.rpcId === rpcId` → `started = true`；`started` 后的 `assistant/message` 收集 `type === 'text'` 与 `type === 'reasoning'` 的 `text`；`tool/call` → `tools += 1`；`turn/end` → `finish(reason.kind)`。`finish`：组装正文（`texts.join('')` 为空时用「（本轮没有文本回复）」；`reason.kind !== 'completed'` 时用「这一轮没有正常完成（<kind>）」；`showProcess` 时正文后加 `\n\n> <reasoning 前 500 字>\n\n— 用时 <formatDuration>，工具 N 次`）→ `replyParts` → 逐段 `deps.send` → 清定时器与 waiter。超时：`finish('timeout')` 并回「处理超时，已放弃等待。」；`prompt` 抛错路径也要清 waiter（避免泄漏）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 5 个回复测试 PASS。

---

### Task 8: `src/tools.ts` 三个 agent 工具（TDD）

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/tools.ts`
- Test: `packages/dsh-lanpost-bridge/test/tools.test.ts`

**Interfaces:**
- Consumes: `LanpostGateway`（`status`/`sendUser`/`sendGroup`/`call`）。
- Produces: `createTools(deps)` 返回 `[lanpost_send_message, lanpost_find_contact, lanpost_bridge_status]` 三个 `ToolDefinitionLike`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.ts'

const fakeGateway: any = {
  status: () => ({ state: 'connected' }),
  sendUser: async () => ({ message_id: 'im:1', delivery_status: 'queued' }),
  sendGroup: async () => ({ message_id: 'im:2', delivery_status: 'queued' }),
  call: async () => ({ users: Array.from({ length: 30 }, (_, i) => ({ protocol_id: 'p' + i, username: 'u' + i, display_name: 'U' + i, online: i < 2 })) }),
}

test('未连接时 lanpost_send_message 报明确错误', async () => {
  const [send] = createTools({ gateway: () => undefined })
  await assert.rejects(send.execute({ target: 'user', id: 'p1', text: 'hi' }, {}), /未连接/)
})

test('私聊发送走 sendUser，返回 message_id', async () => {
  const [send] = createTools({ gateway: () => fakeGateway })
  const value: any = await send.execute({ target: 'user', id: 'p1', text: 'hi' }, {})
  assert.deepEqual(value, { message_id: 'im:1', delivery_status: 'queued' })
  const blocks = send.output.render({ target: 'user', id: 'p1', text: 'hi' }, value)
  assert.match(blocks[0].text, /queued/)
})

test('群发送走 sendGroup', async () => {
  const [send] = createTools({ gateway: () => fakeGateway })
  await send.execute({ target: 'group', id: 'g1', text: 'hi' }, {})
  assert.equal(send.parameters.type, 'object')
})

test('find_contact 最多返回 20 条并标注截断', async () => {
  const [, find] = createTools({ gateway: () => fakeGateway })
  const value: any = await find.execute({ keyword: 'u' }, {})
  assert.equal(value.contacts.length, 20)
  assert.equal(value.truncated, true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/tools.ts'`。

- [ ] **Step 3: 实现 tools.ts**

三个工具都用裸 JSON Schema 描述 `parameters`（`{ type: 'object', properties: {...}, required: [...], additionalProperties: false }`），`output.schema` 描述返回值，`output.render` 返回 `[{ type: 'text', text }]`。`execute` 里手工校验参数（`target` 只允许 `user`/`group`；`text` 非空；`text` 字节数 ≤ 16384 否则抛「消息超过 16 KiB 上限」）。`find_contact` 调 `call('users.list', { keyword, page: 1, page_size: 20, ...(online_only ? { online: true } : {}) }, 10_000)`，按 `users` 数组取前 20，`truncated` 用原始长度判断。返回给模型的 `render` 文本要包含可检索 id。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 4 个工具测试 PASS。

---

### Task 9: `src/routes.ts` 五个 loopback 路由（TDD）

**Files:**
- Create: `packages/dsh-lanpost-bridge/src/routes.ts`
- Test: `packages/dsh-lanpost-bridge/test/routes.test.ts`

**Interfaces:**
- Consumes: `store` 的 `publicSettings`。
- Produces: `createRoutes(deps)`，路由路径常量 `BASE = '/api/lanpost-bridge'`、`SETTINGS`、`STATUS`、`WORKSPACES`、`RECONNECT`、`SESSIONS`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoutes } from '../src/routes.ts'
import { DEFAULTS } from '../src/store.ts'

function harness(overrides: any = {}) {
  const state: any = { ...DEFAULTS, token: 'secret' }
  const patches: any[] = []
  let reconnected = 0
  const cleared: string[] = []
  const deps = {
    state: () => state,
    patch: (p: any) => { patches.push(p); Object.assign(state, p) },
    reconnect: () => { reconnected += 1 },
    status: () => ({ connection: 'connected' }),
    workspaces: () => [{ id: 'w1', title: 'demo', path: 'D:/demo' }],
    clearSession: (key: string) => { cleared.push(key) },
    ...overrides,
  }
  return { routes: createRoutes(deps), patches, cleared, reconnected: () => reconnected, state }
}

function fakeRes() {
  const out: any = { code: 0, body: undefined }
  return { out, writeHead: (code: number) => { out.code = code }, end: (body: string) => { out.body = JSON.parse(body) }, setHeader: () => {} }
}

test('GET settings 不回显 token', async () => {
  const { routes } = harness()
  const route = routes.find((r) => r.path.endsWith('/settings'))!
  const res = fakeRes()
  await route.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {}, url: '/api/lanpost-bridge/settings' } as any, res as any)
  assert.equal(res.out.code, 200)
  assert.equal(res.out.body.tokenSet, true)
  assert.equal('token' in res.out.body, false)
})

test('PATCH settings 只接受白名单字段并落盘', async () => {
  const h = harness()
  const route = h.routes.find((r) => r.path.endsWith('/settings') && r.kind === 'exact')!
  const res = fakeRes()
  await route.handler({
    method: 'PATCH', socket: { remoteAddress: '127.0.0.1' }, headers: { 'content-type': 'application/json' },
    url: '/api/lanpost-bridge/settings', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionMode: 'new', token: '', evil: 1 })) },
  } as any, res as any)
  assert.equal(res.out.code, 200)
  assert.deepEqual(h.patches[0], { sessionMode: 'new' })
})

test('非 loopback 一律 403', async () => {
  const { routes } = harness()
  const route = routes.find((r) => r.path.endsWith('/status'))!
  const res = fakeRes()
  await route.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.5' }, headers: {}, url: '/api/lanpost-bridge/status' } as any, res as any)
  assert.equal(res.out.code, 403)
})

test('DELETE sessions/:key 清映射', async () => {
  const h = harness()
  const route = h.routes.find((r) => r.kind === 'prefix' && r.path.endsWith('/sessions'))!
  const res = fakeRes()
  await route.handler({ method: 'DELETE', socket: { remoteAddress: '::1' }, headers: {}, url: '/api/lanpost-bridge/sessions/direct:p1' } as any, res as any)
  assert.deepEqual(h.cleared, ['direct:p1'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望 `Cannot find module '../src/routes.ts'`。

- [ ] **Step 3: 实现 routes.ts**

`isLoopbackRequest(req)`：`req.socket.remoteAddress` 属于 `127.0.0.0/8`、`::1`、`::ffff:127.*` 之一。响应统一 `writeJson(res, code, body)`（`setHeader('content-type','application/json; charset=utf-8')` + `end(JSON.stringify(body))`）。`readJsonBody(req)` 上限 1 MiB，非法 JSON 抛 400。路由表：`GET/PATCH /settings`（PATCH 走 `mergeSettings` 白名单后 `deps.patch(mergedDiff)`）、`POST /reconnect`、`GET /status`（`{ ...deps.status(), sessions: state.sessions }`）、`GET /workspaces`、`DELETE /sessions`（`kind:'prefix'`，从 `url` 取最后一段 `decodeURIComponent`）。`deps.patch` 收的是「用户提交的白名单差异」（测试断言 `{sessionMode:'new'}`），由 index 组合时负责 `mergeSettings` + `saveState` + 重启连接。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 4 个路由测试 PASS。

---

### Task 10: `src/index.ts` 装配与生命周期（TDD 假 ctx）

**Files:**
- Modify: `packages/dsh-lanpost-bridge/src/index.ts`
- Modify: `packages/dsh-lanpost-bridge/src/bridge.ts`（若需要按实际 SessionController 形状微调 `InboundDeps` 适配）
- Test: `packages/dsh-lanpost-bridge/test/plugin.test.ts`

**Interfaces:**
- Consumes: 全部模块。
- Produces: 可运行的宿主插件。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../src/index.ts'

function fakeCtx() {
  const tools: string[] = []
  const routes: string[] = []
  const effects: Array<() => void> = []
  const services: Record<string, any> = {
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      prompt: async () => ({ accepted: true }),
      rename: async () => ({ title: 'x', seq: 1 }),
    },
    workspaceRegistry: { list: () => [{ id: 'w1', title: 'demo', path: 'D:/demo' }] },
  }
  const ctx: any = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn: () => any) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
    on: () => () => {},
    inject: (_deps: string[], cb: (c: any) => void) => cb(ctx),
    get: (serviceName: string) => services[serviceName],
    systemPrompt: { section: () => () => {} },
    tools: { register: (def: any) => { tools.push(def.name); return () => {} } },
    webServer: { register: (route: any) => { routes.push(`${route.kind} ${route.path}`); return () => {} } },
  }
  return { ctx, tools, routes, effects }
}

test('apply 注册三个工具与路由，且可回卷', () => {
  const home = mkdtempSync(join(tmpdir(), 'lanpost-plugin-'))
  process.env.DSH_HOME = home
  const f = fakeCtx()
  apply(f.ctx)
  assert.equal(name, 'our-dsh-lanpost-bridge')
  assert.deepEqual(f.tools.sort(), ['lanpost_bridge_status', 'lanpost_find_contact', 'lanpost_send_message'])
  assert.equal(f.routes.length, 5)
  for (const dispose of f.effects) dispose()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 期望断言失败（还没有注册工具/路由）。

- [ ] **Step 3: 实现 index.ts**

要点：`apply(ctx)` 里
1. `const logger = loggerOf(ctx)`；
2. 读状态 `let state = loadState()`；`const update = (mutate) => { mutate(state); saveState(state) }`；
3. `let gateway: LanpostGateway | undefined`；`const startGateway = () => { if (!state.enabled || state.token === '') return; gateway?.stop(); gateway = new LanpostGateway({ url: state.gatewayUrl, token: state.token, lastSequence: state.lastSequence, events: { onMessage: (e) => bridge.handleMessage(e), onDelivery: (s) => bridge.handleDelivery(s), onState: (s) => { logger.info(...) } } }); gateway.start() }`；
4. `const bridge = new InboundBridge({ state: () => state, update, sessions: sessionControllerOf(ctx), send: (target, text) => target.kind === 'user' ? gateway!.sendUser(target.protocolId, text) : gateway!.sendGroup(target.groupId, text), onSessionEvent: (h) => onSessionEvent(ctx, (session, event) => h(session.id, event)), log: (m) => logger.info(m), onAck: (seq) => update((s) => { s.lastSequence = Math.max(s.lastSequence, seq) }) })`；
5. `ctx.effect(() => { startGateway(); return () => { gateway?.stop(); bridge.dispose() } })`；
6. `ctx.effect(() => ctx.tools.register(...))` × 3（用 `createTools({ gateway: () => gateway })`）；
7. `ctx.effect(() => createRoutes(deps).map((r) => webServerOf(ctx).register(r)))`，`deps.patch` = `(diff) => { state = mergeSettings(state, diff); saveState(state); startGateway() }`；
8. `ctx.effect(() => ctx.systemPrompt.section({ name: 'lanpost-bridge', order: 900, text: LANPOST_PROMPT }))`，`LANPOST_PROMPT` 为常量说明（何时用 `lanpost_send_message`/`lanpost_find_contact`，2–4 句）。

**Step 3b: 修 bridge 的 send 签名**：`InboundDeps.send` 的返回值改为 `Promise<unknown>`（bridge 不关心 message_id），并在 index 里不依赖 gateway 非空断言（`gateway === undefined` 时抛「网关未连接」，由 bridge 的错误分支回复）。

- [ ] **Step 4: 跑测试与全量验证**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 全 PASS（含前面所有用例）。
Run: `pnpm run check && pnpm run build` → PASS。

---

### Task 11: `src/client.ts` 设置页

**Files:**
- Modify: `packages/dsh-lanpost-bridge/src/client.ts`
- Modify: `packages/dsh-lanpost-bridge/package.json`（devDependencies 加 `react` 类型来源：`"@types/react": "^19.0.0"`，`"react": "^19.0.0"` 作为 peer 之外的 dev 依赖只用于类型与本地检查）

**Interfaces:**
- Consumes: 宿主路由 `/api/lanpost-bridge/*`。
- Produces: `settings.section` 页面。

- [ ] **Step 1: 写客户端入口**

`src/client.ts` 只导出 `apply(ctx)`：`(ctx as unknown as ClientCtx).slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'lanpost-bridge', order: 120, label: () => 'lanpost 连接' }, Section))`，组件用 `React.createElement`（不写 JSX，避免 jsx 编译配置），`useState/useEffect` 从 `require('react')` 的等价 ESM 导入（构建预设把 `react` 外置为 require，源码用 `import * as React from 'react'` 即可）。

- [ ] **Step 2: 实现表单与状态区**

字段：启用开关、网关地址、令牌（`type=password`，空表示不改）、工作区下拉（GET `/workspaces`）+ 自定义路径、会话模式（continue/new 单选）、是否附思考与工具摘要、自己的 protocol_id。动作：保存（PATCH）、重新连接（POST）、解除某来源映射（DELETE `/sessions/:key`）。状态区：连接状态徽标、错误文本、映射表（`key` + `sessionId` + 时间）。顶部固定一行安全警示：「私聊对所有联系人放行：任何能私聊到本机的人都可以驱动本机 agent。」

- [ ] **Step 3: 构建**

Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge build` → 期望 `lib/client.js` 是 `window.__ModuleLoader__.load({ id: "@hllshiro/dsh-lanpost-bridge", ... })` 包装，且 `require('react')` 出现在产物中、React 未被内联。

- [ ] **Step 4: 在 dsh web 里确认**

启动仓库开发环境 `$env:DSH_HOME='D:\hllshiro\ai-agent-plugins\.dsh-dev'; pnpm dev`，打开 GUI 设置，确认「lanpost 连接」分区出现、保存后刷新仍保留、浏览器控制台无未捕获错误。

---

### Task 12: 文档、全量验证与实测清单

**Files:**
- Modify: `packages/dsh-lanpost-bridge/README.md`
- Modify: `README.md`（插件表补全职责描述）
- Modify: `AGENTS.md`（若需要，补一行本插件的运行前提：需 lanpost 客户端提供网关与令牌）
- Modify: `docs/superpowers/specs/2026-11-26-lanpost-bridge-design.md`（状态改为「已实现」，补充实测结论）

- [ ] **Step 1: 写 README**

必需内容：装法（`pnpm run inject` 开发 / Plugins → Add plugin 装本地目录 / `plugin_manager install_bundle`）、令牌获取方式（lanpost 客户端设置里生成）、默认地址与自签证书说明、设置页每项含义、三种工具说明、安全警示、已知限制（v1 仅文本、无历史、群只投在线成员、私聊全放行）、排错（`--dump-config`、状态页、审计日志路径）。

- [ ] **Step 2: 全量验证**

Run: `pnpm run check` → PASS。
Run: `pnpm run build` → 3 个包全部产出。
Run: `pnpm --filter @hllshiro/dsh-lanpost-bridge test` → 全 PASS。
Run: `$env:DSH_HOME='D:\hllshiro\ai-agent-plugins\.dsh-dev'; node scripts/inject.mjs` → `✓ our-dsh-lanpost-bridge`，`--dump-config` our- 行 3 条。

- [ ] **Step 3: 实测清单（需要用户在 lanpost 侧配合，无法自动化）**

1. 设置页填令牌 → 状态变「已连接」。
2. 私聊发「你好」→ GUI 出现 `lanpost · 张三` 会话 → lanpost 收到回复。
3. 群里发 `/dsh 你好` → 触发；发「你好」→ 不触发。
4. 触发器会话里让 agent 调 `lanpost_send_message` 给另一个人发消息 → 对方收到。
5. 发图片 → 收到「暂不支持图片消息」。
6. 重启 dsh → 不重复处理已 ACK 的旧消息（对照审计日志）。

- [ ] **Step 4: 把实测结论写回设计文档**

在 `docs/superpowers/specs/2026-11-26-lanpost-bridge-design.md` 末尾追加「实测记录」小节，逐条记结果与偏差。

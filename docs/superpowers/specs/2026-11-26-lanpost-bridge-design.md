# DSH ↔ lanpost-im 适配插件 设计文档

- 日期：2026-11-26
- 包：`packages/lanpost-bridge` → `@hllshiro/lanpost-bridge`（行 id `our-lanpost-bridge`）
- 状态：待评审
- 协议依据：lanpost Agent Gateway API 1.0（2026-11-26 冻结），原文 `C:\Users\xqkj\.dsh\attachments\v1\files\71\7172fc40dee5d9ecbe34699d197ace3a21a9b1379503e50779becdb5e77d7a62\gateway-api.md`

## 1. 目标

1. **出站**：DSH 里的 agent 能主动给 lanpost 的某个人或某个群发文本消息（通过 agent 工具）。
2. **入站**：lanpost 收到消息后，插件能创建/唤醒一个 DSH 会话，把消息作为**用户发言**投进去，agent 的最终回答再发回原会话。
3. **可配置**：DSH 设置里有一个「lanpost 连接」页，可选工作区、选「继续会话 / 新建会话」、填网关地址与令牌、看连接状态。

非目标（v1 不做）：图片收发（收到图片回一句提示）、历史消息回填、群列表、已读/撤回、多账号、局域网暴露的安全代理。

## 2. 约束（设计不能绕开的事实）

### 2.1 网关侧

- WebSocket：`wss://127.0.0.1:8443/ws/dsh`，自签证书；令牌 43 字符 base64url；方法名带命名空间（`rpc.login`、`users.list`、`message.sendUser`、`message.sendGroup`、`media.prepareUpload`、`events.ack`、`events.resume`）。
- 连接序列：open → `rpc.login({token})`（必须严格返回 `true`）→ `subscribe(['message.received','message.deliveryStatus'])` → `events.resume({last_sequence})`。库自带重连**不会**重做 login/subscribe，必须自己重做；关闭码 `4401` 令牌轮换、`4409` 连接超限。
- 只提供：联系人列表 `users.list`（keyword/online/page/page_size）、一对一/群发消息、图片上传、事件 ACK/resume。
- 文本 UTF-8 ≤ 16 KiB（超出 `-32013`）；`request_id` 幂等 24h，同 id 不同内容 `-32021`；一对一离线 `queued` 后补发，24h 未送达 `failed`；群只投在线成员，无人可达立即 `failed`。
- 事件：至少一次投递，按 `event_id` 去重、按 `sequence` 顺序 ACK（不许跳号），未 ACK 最多留 7 天；`events.resume(0)` 不补历史。
- 超时：`users.list` 10s，`message.send*` 30s，`events.ack` 10s，`events.resume` 15s。
- 没有「我是谁」接口：无法从 API 得知自己的 `protocol_id`，只能靠配置或忽略策略避免自回环。

### 2.2 DSH 侧（已在源码核实）

- `ctx.sessionController`（`session-controller`，web-app 组合已装）：
  - `create({ workspaceId? | cwd?, sessionId?, agentPreset? }) → { sessionId }`；`workspaceId` 与 `cwd` 互斥；都不给用默认目录；`sessionId` 只在「同目录、同 Workspace、未被别人写、空白」时复用。
  - `prompt({ requestId, sessionId, mode:'queue'|'steer', content, clientTimeZone? }) → { accepted:true }`：内部 `resolveAgent` 会 resume 冷会话；构造 `MessageSource{kind:'user', rpcId:requestId}`；本地插件调用是 owner，不写 `principal`；`requestId` 幂等（按会话已记录的去重）。**接受只代表入 inbox，不代表这一轮跑完。**
  - `rename({ sessionId, title })` 给会话改名。
- 观察结果：`ctx.on('session/event', (session, event) => …)`；`assistant/message` 的 `event.data.message.content` 是文本块数组（`text` / `reasoning`），`turn/end` 的 `event.data.reason` 表示本轮结束原因（完成/取消/失败等），`tool/call` 用于计数。
- 工具：`ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`（`@deepseek-ai/dsh-tools` 由宿主 resolver 提供）。
- 设置面板：没有任何官方客户端渲染「自动表单」，必须自己写 `settings.section`（`dsh.client` + `./client` 导出 + `window.__ModuleLoader__.load` 包装，本仓库 `scripts/plugin-build.ts` 已支持 `client: true`），页面通过宿主的 `/api/...` 路由读写自己的状态；工作区下拉读 `ctx.workspaceRegistry.list()`（每项 `{id, title, path}`）。
- 现有可照抄的范式：`dsh-n8n-plugin`（`inject = ['webServer','tools','systemPrompt']`、`ctx.webServer.register({kind:'exact', path, handler})`、原子写 0600 的 JSON 存储、`ctx.effect` 记账、loopback 校验）。

## 3. 方案选择

选定 **方案 A：`sessionController.create/prompt` 驱动**。被否决的 B（`ctx.agents.create` + `followup` 直驱）唯一优势是能把消息标成 `source.kind='lanpost'`，代价是自己建会话、挂 workspace、选模型、管生命周期，收益不足以抵成本；来源区分改用「会话标题 `lanpost · 张三` + 回复首行来源说明」实现。

「继续 / 新建」两种模式都保留在设置页里（用户明确要求），由使用者在面板切换。

## 4. 总体结构

```
packages/lanpost-bridge/
  package.json           # name、dsh.bundle.patch、dsh.client{platform:'web',inject}、exports ./client
  cordis.patch.yml       # - insert: [{ id: our-lanpost-bridge, name: '@hllshiro/lanpost-bridge' }]
  src/index.ts           # 宿主入口：inject、apply、mountOnce、sync（连接/store→各 surface）
  src/gateway.ts         # 网关 JSON-RPC 客户端（ws + 重连 + ACK 队列 + 事件分发）
  src/store.ts           # $DSH_HOME/dsh-lanpost-bridge.json 原子读写（0600）
  src/bridge.ts          # 入站编排：过滤 → 建/取会话 → prompt → 等 turn/end → 回发
  src/routes.ts          # /api/lanpost-bridge/* 设置、状态、工作区、重连
  src/tools.ts           # 三个 agent 工具（发送、找联系人、状态）
  src/render.ts          # 工具输出的人类可读渲染
  src/client.ts          # 设置页（settings.section）
  README.md              # 用法 + 安全提示
```

宿主半与浏览器半同包（`dsh.client` 声明），照 `dsh-n8n-plugin` 的双面包形状。

## 5. 数据模型

单文件 `$DSH_HOME/dsh-lanpost-bridge.json`（默认 `~/.dsh/`），tmp + rename 原子写，`mode 0600`：

```jsonc
{
  "version": 1,
  "enabled": true,
  "gatewayUrl": "wss://127.0.0.1:8443/ws/dsh",
  "token": "<43 字符>",          // 只写不读：HTTP/工具投影都不回显
  "workspaceId": null,           // 与 workspacePath 二选一；都空 = 默认目录
  "workspacePath": null,
  "sessionMode": "continue",     // continue | new
  "showProcess": false,          // true = 回复附思考与工具/耗时摘要
  "selfProtocolId": null,        // 可选：自己的 protocol_id，用来丢弃自回环
  "lastSequence": 0,             // 已 ACK 的最大事件序号（断点续传）
  "seenEventIds": ["evt_…"],     // 去重窗口，最多 500 条（FIFO）
  "sessions": {                  // 来源 → DSH 会话
    "direct:0123abcd…": { "sessionId": "…", "updatedAt": "2026-11-26T…" },
    "group:998877": { "sessionId": "…", "updatedAt": "2026-11-26T…" }
  }
}
```

运行态只在内存：连接状态、`lastError`、`connectedSince`、每来源的串行队列、进行中的 prompt 等待器。

## 6. 网关客户端（`src/gateway.ts`）

- 依赖 `ws`（Node 内建 WebSocket 无法对自签证书设置 `rejectUnauthorized:false`）。`new WebSocket(url, { rejectUnauthorized:false, handshakeTimeout: 10000 })`。若目标 profile 装不上 `ws`，退路是内置一个只支持文本帧的最小 RFC6455 客户端（不首选）。
- JSON-RPC 2.0 子集：请求 `{jsonrpc:'2.0', id, method, params}`，响应按 id 归位，`error` 转成本地 `GatewayError{code, message}`；通知按信封识别：`method ∈ {message.received, message.deliveryStatus}` 或 `params` 里带 `event_id/sequence/data`。
- 连接序列严格按文档：`open` → `rpc.login` → `subscribe` → `events.resume(lastSequence)`；任一步失败都进 `disconnected` 并带原因。
- 重连：指数退避 1s→2s→4s…→30s，带 ±20% 抖动；`4401` 停止重试并在设置页提示「令牌已轮换，请更新令牌」；`4409` 退避拉长并在状态里提示「连接数超限」。
- 超时：每个请求带 `AbortSignal.timeout(见 2.1 表)`；`events.ack` 失败不阻塞后续（重连后 resume 会补）。
- ACK 队列：收到的 `sequence` 入待确认集合，只有当 `lastAcked + 1` 在集合里才发送 `events.ack`，逐条推进（满足「不许跳号」）；`lastAcked` 立即落盘（至少每 10 条或 3 秒刷一次）。
- 订阅回调把事件交给 `bridge.handle(event)`，**处理失败也要 ACK**（否则会 7 天内反复补发同一条），失败原因写状态页与审计日志。
- 提供：`connect()`、`disconnect()`、`call(method, params, timeoutMs)`、`state()`、`sendUser/sendGroup` 薄封装。

## 7. 入站编排（`src/bridge.ts`）

### 7.1 过滤

- 只处理 `message.received`；`message.deliveryStatus` 只更新统计（failed 计数并记状态页，不回消息）。
- `sender.protocol_id === selfProtocolId` → 丢弃（防自回环）；未配置 `selfProtocolId` 时靠「不订阅自己发出的 message_id」不可行，故默认只丢弃与最近发送 `message_id` 相同的回显（24h 窗口内），并建议用户填 `selfProtocolId`。

### 7.2 权限与触发

| 来源 | 规则 |
| --- | --- |
| 私聊 `conversation_type='private'` | 全放行（用户要求）。文本进会话；图片回「暂不支持图片消息（v1 仅文本）」。 |
| 群 `conversation_type='group'` | 文本必须以 `/dsh` 开头（`/^\/dsh(?:\s|$)/i`），剥掉前缀后去首尾空白；空正文忽略。图片/非文本忽略（不回复，避免刷群）。 |

非文本、空文本、被过滤的消息一律 ACK 后丢弃。

### 7.3 会话键与创建

- 键：私聊 `direct:<sender.protocol_id>`，群 `group:<group_id>`。
- `sessionMode='continue'`：查 `sessions[key]`；有则复用；无则 `create({ workspaceId | cwd })` 后写入映射。
- `sessionMode='new'`：每条消息都 `create({...})`，不更新映射（新会话在侧栏按时间排，标题带来源，可回看）。
- 新建后 `rename(sessionId, 'lanpost · <display_name|username>' / 'lanpost · 群 <group_id>')`；改名失败只记日志。
- 复用的会话若 `prompt` 抛 `session/not-found`（用户删了会话），删映射、重建一次，再投一次（仅重试一次）。

### 7.4 投递与串行

- 每个会话键一条 promise 链：消息依次「prompt → 等本轮结束 → 发回复」，保证一问一答顺序；队列上限 20 条，超出回「我这边还排着 20 条，稍后再发」并 ACK。
- `requestId = 'lanpost-' + uuid`，`mode:'queue'`，`content:[{type:'text', text}]`。
- 发送的文本加上来源说明首行（帮助 agent 知道谁在说话、往哪回）：
  - 私聊：`[lanpost 私聊 · 张三 (username)]`
  - 群：`[lanpost 群 998877 · 张三 (username)]`
  - 只影响投给 agent 的内容，不影响回复给对方的内容。

### 7.5 等待与捕获回复

- prompt 被接受后注册一次「本轮收集器」：监听 `session/event`，`session.id` 匹配后：
  1. 等到 `user/message` 且 `source.rpcId === requestId`，标记本轮开始；
  2. 累积 `assistant/message` 的 `text` 块；`showProcess=true` 时把 `reasoning` 块以 `> ` 引用形式收进附注；`tool/call` 计数；
  3. `turn/end` 收尾，`reason` 不是完成态时文本换成「这一轮没有正常完成（<reason>）」；
  4. 兜底超时 10 分钟 → 回「处理超时，已放弃等待」，不 cancel agent（用户可以自己看会话）。
- 文本为空 → 「（DSH 没有产生文本回复）」。
- 回复按 UTF-8 字节切段（每段 ≤ 4000 字节且不切坏多字节字符），多段时加 `(1/3)` 角标，逐条 `sendUser`/`sendGroup`，`request_id` 每段独立。
- 回复目标：私聊回 `sender.protocol_id`；群回 `group_id`。
- `showProcess=true` 时末尾追加一行：`— 用时 12.3s，工具 4 次`。

## 8. 出站工具（`src/tools.ts`）

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `lanpost_send_message` | `target: 'user'\|'group'`、`id`、`text`（≤16KiB） | 调 `message.sendUser` / `message.sendGroup`；返回 `{message_id, delivery_status}`；未连接直接报错（不排队）。 |
| `lanpost_find_contact` | `keyword`、`online_only?` | `users.list`，返回最多 20 个 `{protocol_id, username, display_name, online, last_seen_at}`，标注截断。 |
| `lanpost_bridge_status` | — | 连接状态、上次错误、映射数量、游标；只读，用于排查。 |

工具描述写「做什么/什么时候用」，参数规则写在参数 `description` 里；返回值带显式截断标记。工具注册不受连接状态影响（未连接时调用给出明确错误）。

## 9. 设置路由与页面

### 9.1 宿主路由（全部 `isLoopbackRequest` 校验）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/lanpost-bridge/settings` | 返回设置（token 只回 `tokenSet: boolean`） |
| PATCH | `/api/lanpost-bridge/settings` | 局部更新（无 `token` 字段则保持原值），落盘后热应用 |
| POST | `/api/lanpost-bridge/reconnect` | 主动重连（清重试退避） |
| GET | `/api/lanpost-bridge/status` | 连接状态、错误、游标、映射表（来源 + 会话 id + 时间） |
| GET | `/api/lanpost-bridge/workspaces` | `workspaceRegistry.list()` → `{id,title,path}` |
| DELETE | `/api/lanpost-bridge/sessions/:key` | 清除某来源的映射（下次消息新建会话） |

### 9.2 设置页（`settings.section`，id `lanpost-bridge`）

- 开关：启用桥接。
- 网关地址（默认 `wss://127.0.0.1:8443/ws/dsh`）+ 令牌（password 输入，留空 = 不变，占位显示「已保存」）。
- 工作区：下拉（来自 `/workspaces`）+「自定义路径」输入 + 「默认目录」。
- 会话模式：继续会话 / 每条消息新建会话（单选，带解释文案）。
- 回复内容：是否包含思考与工具摘要。
- 可选：自己的 `protocol_id`（防自回环）。
- 状态区：徽标（已连接/连接中/已断开/错误）、错误文本、游标、映射表（每条可「解除」）、「重新连接」按钮。
- 保存即生效：`PATCH` 成功后就地刷新状态；不改的话不重连。

## 10. 安全

- 私聊对所有人放行 = 任何一个有私有号的联系人都能驱动本机 agent（含工具权限、工作区写权限）。页面顶部固定显示这条警示；README 同步写明。缓解：工作区默认指向专用目录，`selfProtocolId` 可选填写。
- 令牌只落盘 0600、不回显；路由只接受 loopback 请求；错误信息里不回显令牌。
- 审计：写入 `$DSH_HOME/dsh-lanpost-bridge.audit.log`（进站触发、会话创建、出站发送、失败原因），与 n8n 插件同款行格式。
- 回复内容不含工具输出（`showProcess` 只含思考摘要与计数），避免把本机路径/命令发到聊天里。

## 11. 失败矩阵

| 情况 | 行为 |
| --- | --- |
| 无令牌 / 未启用 | 不建连；状态页提示；工具报「未配置」。 |
| 网关未启动（ECONNREFUSED） | 状态页显示原因 + 提示「请先打开 lanpost 客户端」；持续退避重连。 |
| 令牌失效（4401） | 停止重连，状态页提示更新令牌。 |
| `-32020`（事件被清理） | 游标重置为 0 再 resume，状态页提示「可能缺少量历史事件」。 |
| 会话创建失败 | 回复「创建会话失败：<原因>」，ACK，不重试。 |
| prompt 被拒（agent-busy 等） | 回复「会话忙，稍后再试」；同一条消息不重投（避免死循环）。 |
| 回复发送失败（`failed`） | 状态页与审计记录，不回聊天。 |
| 插件卸载 / 停用 | `ctx.effect` 回卷：关闭 socket、注销路由与工具、清空队列。 |

## 12. 验证清单（AGENTS.md 完成判据）

1. `pnpm run check`、`pnpm run build` 通过；`DSH_HOME=.dsh-dev pnpm run inject` 后有 `✓ our-lanpost-bridge`，`--dump-config` 里 our- 行 3 条。
2. 在运行中的 `dsh web`（GUI http://127.0.0.1:30894）实测：
   - 设置页能保存并热应用（改地址 → 状态变化，不必重启）；
   - 私聊发一条 → 侧栏出现 `lanpost · …` 会话、agent 正常回答、lanpost 收到回复；
   - 群里 `/dsh 你好` 触发、不带前缀不触发；
   - 工具 `lanpost_send_message` 在对话框里被调用并真的发出；
   - 图片消息回「暂不支持」；
   - 重启 dsh 后按 `lastSequence` 续传、不重复处理旧事件（看审计日志）。
3. 需要用户在 lanpost 侧配合（给令牌、发消息），无法自动化的步骤在 README 记录。

## 13. 风险与未决

- `ws` 依赖：dev profile（`packages/*` 有 node_modules 链接）应可直接解析；装到桌面 profile 时由 `plugin_manager install_bundle` 负责装依赖，需实测。兜底：内置最小 WS 客户端。
- `@deepseek-ai/dsh-tools` 的 `defineTool` 走宿主 resolver；若 workspace 内 pnpm 解析不到，先以 `peerDependencies` + 运行时解析验证，再决定是否 vendor 一份极简定义。
- `session/event` 的事件细节（`user/message` 的 `source.rpcId` 字段名、`turn/end.reason` 取值）在实现时以 `packages/core/agent` 与 `session-format` 的事件类型为准，写单测锁定。
- 群消息没有群名，只能显示 `group:<id>`；后续可加「别名」配置。
- 长回答切段后对方看到多条消息，可接受；后续可加「合并为一条」的开关（不行，16KiB 是硬限）。

## 14. 里程碑

1. **M1 链路**：gateway + store + bridge（先固定一个默认会话/工作区，无面板），用脚本或工具手动跑通「私聊 → 会话 → 回复」。
2. **M2 面板**：routes + 设置页 + 工作区下拉 + 映射表 + 状态；接上「继续/新建」两种模式。
3. **M3 打磨**：审计、失败矩阵、切段、思考摘要、README、验证清单全绿。

# @hllshiro/dsh-lanpost-bridge

DSH ↔ lanpost-im 适配插件：agent 可以用工具给 lanpost 联系人/群发消息，lanpost 的私聊与群消息也能反向驱动本机 DSH 会话，并把这一轮的结果回发到原会话。

- 包名 `@hllshiro/dsh-lanpost-bridge`，组合行 id `our-dsh-lanpost-bridge`
- 双面：宿主半 `src/index.ts`，浏览器半 `src/client.ts`（经 `./client` 导出，挂在设置页 `settings.section`）
- 依赖 lanpost-im 客户端内嵌的 Agent Gateway（WebSocket JSON-RPC，明文 `ws://`，地址只填 `host:port`，默认 `localhost:9015`）

## 运行前提

1. lanpost-im 客户端已安装并登录，且在它的设置里开启了 Agent Gateway、生成了访问令牌（43 字符 base64url）。
2. DSH 侧运行 Node ≥ 22（本仓库开发用 Node 24）；插件宿主半依赖 `ws`（已作为包依赖声明，构建时外置）。
3. 局域网内明文连接、不启用 TLS；令牌只落盘到 `$DSH_HOME/dsh-lanpost-bridge.json`（0600），任何 HTTP 响应、工具输出、日志都不回显。

## 安装

开发仓库内：

```powershell
$env:DSH_HOME = 'D:\hllshiro\ai-agent-plugins\.dsh-dev'   # 或你的开发 profile
pnpm run inject                                            # 构建 + 注入 + 组合校验
```

用户机器上（不碰源码）：

- GUI：Plugins → Add plugin，选这个包的绝对目录；或
- 让 agent 调 `plugin_manager action: install_bundle`，`target` 传包目录的绝对路径。

装完重启 `dsh web`，打开 设置 → lanpost 连接。

## 设置页

| 字段 | 含义 |
| --- | --- |
| 启用 | 关闭时断开网关、卸载订阅，工具返回「桥未启用」。 |
| 网关地址 | 只填 `ip:port`（如 `192.168.2.8:9015`），默认 `localhost:9015`；插件自动用 `ws://<地址>/ws/dsh` 连接，不走 TLS。粘贴带 `ws://` 或路径的地址会被归一。 |
| 访问令牌 | 从 lanpost 客户端生成。输入框留空表示不改动已保存的令牌。 |
| 工作区 | 新会话落在哪个目录；下拉只列出 DSH 当前已打开的工作区，也可以不绑定（用 DSH 默认目录）。不接受手填路径。 |
| 会话模式 | `continue`：同一来源复用同一个 DSH 会话；`new`：每条消息新建会话。 |
| 附思考与工具摘要 | 开启时回复末尾追加「— 用时 Xs，工具 N 次」，异常回合带原因。 |
| 自己的 protocol_id | 可选；网关没有 whoami 接口，填了才能在联系人列表里把自己标出来。 |

状态区显示连接状态、最近错误、网关提示（令牌轮换/连接数超限/游标重置）与当前会话映射，可「刷新状态」「重新连接」，也可按来源解除某条映射。触发保存时只有 `启用/网关地址/令牌` 变化才会重启网关，其余只改本地行为。

## 触发规则

- **私聊**：所有联系人都能触发（这是默认行为，也是本插件最大的风险面，见下）。
- **群聊**：消息必须以 `/dsh` 开头（`/^\/dsh(?:\s+|$)/i`，前缀会被剥掉）才触发；不带前缀的群消息直接忽略并 ACK。
- 图片等非文本内容：回一句「暂不支持图片消息」并 ACK，不动会话。
- 会话键：私聊 `direct:<protocol_id>`，群聊 `group:<group_id>`；continue 模式下首次触发会新建会话并重命名为 `lanpost · <对方名称>`。
- 入站事件按网关的单条串行链处理：同一来源的消息排队（每股最多 20 条，超出回「我这边还排着 20 条消息，稍后再发。」）；一轮最长等 10 分钟，超时回「处理超时，已放弃等待。」
- 投递是至少一次语义：入站事件按 `event_id` 去重（窗口 500 条），处理并持久化后按 `sequence` 顺序 ACK。

## agent 工具

| 工具 | 用途 |
| --- | --- |
| `lanpost_send_message` | 给联系人（`protocol_id`）或群（`group_id`）发文本。要先 `lanpost_list_contacts` 拿 `protocol_id`；`group_id` 只能来自入站消息或用户提供。 |
| `lanpost_list_contacts` | 列出联系人名册（可按关键词/在线过滤并分页），返回 `protocol_id`、用户名、显示名、在线状态；`keyword` 省略即全量，`page_size` 默认 50、上限 200。 |
| `lanpost_bridge_status` | 查桥的连接状态、最近错误、当前映射，用于排查「为什么消息没到」。 |

工具的失败统一返回 `{ok:false,error,code}`，不抛异常；文本上限 16 KiB（UTF-8），超限在本地就拒绝（`-32013` 是网关侧同类错误）。

## 安全警示

**私聊对所有联系人放行：任何能私聊到这台机器的人，都可以直接驱动本机 agent（默认拥有本机工作区的读写能力）。** 请确认 lanpost 联系人范围可信。建议：

- 需要收口时先停用插件（设置页「启用」关闭），或
- 用群聊 + `/dsh` 前缀作为唯一入口（把私聊联系人清空），或
- 给 DSH 会话配一个受限的 agent preset（本插件不改变宿主 preset 策略）。

## 已知限制（v1）

- 只处理文本；图片/文件回「暂不支持」。附件与会话无关，不会写入工作区。
- 网关没有历史消息、群列表、群成员、已读、撤回、多账号接口；本插件也不缓存这些。
- 群消息只投递给在线成员；无人在线时网关直接返回 `failed`（`reason: "群成员都不在线"`）；本机不在群里报 `-32012`。
- 一对一离线消息由网关排队，24 小时未送达转 `failed`；同一 `request_id` 的幂等窗口也是 24 小时。
- 网关无 whoami，无法自动得知本机自己的 `protocol_id`（可手动填）。
- 该网关不提供任何订阅方法（`subscribe` 系列全部 `-32601`）、也不主动推送：插件从不调用 `subscribe`，握手完成后每 3 秒用 `events.resume` 拉一次未 ACK 事件（`ACK` 之前不会重复下发）；不是「消息到达即触发」，最坏延迟约 3 秒。
- 明文 `ws://`、无 TLS：只在可信局域网内使用；不要把 9015 端口暴露到不受信任的网络。
- 工作区只能从 DSH 已打开的工作区里选，不再接受手填路径；没有打开的项目时下拉为空。
- 令牌只能替换、不能清空（要彻底断开请关闭「启用」并删除 `$DSH_HOME/dsh-lanpost-bridge.json`）。
- 回复按 4000 字节切段（多段带 `(1/3)` 角标）；中文按 UTF-8 边界切，不会截断半个字。
- 插件重载/停用会把在途回合静默取消（不发「已取消」消息），排队未开始的消息会被 ACK 但不再回复。
- 网关只有一条串行通知链：某来源的上一轮跑到 10 分钟超时期间，**其他来源的入站消息也会被压后**（最多 10 分钟）。这是网关通知串行 + 每条消息要等 prompt 被接受的共同结果。

## 排错

| 现象 | 检查 |
| --- | --- |
| 设置页一直「未连接」 | 网关地址/端口、lanpost 客户端是否在运行、令牌是否最新；状态区「最近错误」有原文。 |
| 关闭码 4401 | 令牌已轮换：到 lanpost 客户端重新生成，粘贴后保存。 |
| 关闭码 4409 | 连接数超限：通常是另一个 DSH 实例也连着同一网关。 |
| 日志出现 `-32606` | 握手顺序被破坏（login 必须严格返回 `true` 后才继续）；重启插件会自动重做。 |
| 入站消息没反应 | 群里是否带 `/dsh` 前缀；审计日志 `$DSH_HOME/dsh-lanpost-bridge.audit.log` 里应有 `accepted`/`ignored` 记录。 |
| 插件没进组合 | `$env:DSH_HOME=...; pnpm exec dsh --profile web --dump-config`，确认有 `our-dsh-lanpost-bridge`。 |
| 工具说没连上 | 设置页看状态；工具与入站共用同一条连接。 |

## 开发

```powershell
pnpm --filter @hllshiro/dsh-lanpost-bridge test    # node --test（Node 24 原生跑 .ts）
pnpm --filter @hllshiro/dsh-lanpost-bridge build   # tsdown：host ESM + client __ModuleLoader__ 包装
pnpm run check                                     # 仓库根 tsc --noEmit
```

- 本地状态：`$DSH_HOME/dsh-lanpost-bridge.json`（0600，原子写）。
- 审计日志：`$DSH_HOME/dsh-lanpost-bridge.audit.log`（0600，仅记录事件动作与会话键，不含令牌与消息正文）。
- 关键常量集中在 `src/core.ts`：16 KiB 文本上限、4000 字节切段、队列 20、10 分钟超时、去重窗口 500、退避 1s→30s、默认地址 `localhost:9015`、`ws://<地址>/ws/dsh`；轮询间隔在 `src/gateway.ts` 的 `POLL_INTERVAL_MS = 3000`。

### 更多边界行为

- `lanpost_list_contacts` 优先用网关的 `total` 判断后续页；网关没给 `total` 时，本页取满 `page_size` 就提示「可能还有更多」，不臆造总数。
- 被队列回绝（「我这边还排着 20 条消息」）的那条事件已经进入去重窗口：网关用同一 `event_id` 重投也不会再处理。
- 群 `group_id` 只出现在入站来源行 `[lanpost 群 <groupId> · 显示名 (@username)]` 里；`lanpost_list_contacts` 只列联系人，不列群。
- 来源行与群名会净化（控制字符、`[`/`]`、换行折叠为空格，零宽连接符保留），显示可能与对方原文略有差异。
- `status.sessions` 可能是「未知」（`null`，刚重连还没拉到映射表）；`{}` 才表示确实没有映射。
- 设置页的每个宿主请求 15 秒超时；超时只影响页面读写反馈，不影响后台网关连接与消息收发。
- `status.error`（上次连接/发送失败）与 `status.notice`（连接正常但需提示，如游标被网关重置）会各用一条横幅同时展示。
- 状态文件落盘失败时 PATCH 返回 500，此时内存设置与文件可能不一致；再保存一次或重启 `dsh web` 即可恢复。（本轮修复后为新顺序：先落盘再改内存。）
- 未启用时插件不订阅 `session/event`，也不会建连；必须先保存令牌并勾选启用。
- 手工编辑状态文件时写入 `__proto__` / `constructor` / `prototype` 的会话键会被丢弃（防原型污染）。

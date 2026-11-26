# AGENTS.md — AI Agent 插件开发仓库

DSH 插件的开发仓库：pnpm workspace，一个插件一个包，经 `link:` 注入隔离的 DSH 运行时开发调试。结构、命令、注入机制见 README.md；需求硬约束（不改 DSH 源码、技能无明文文件、会话层拦截、换标、构建解耦）见 `../ai-agent-plan/README.md`。

## 完成判据

每个改动收尾必须全部满足：

1. `pnpm run check` 与 `pnpm run build` 通过；
2. `pnpm run inject` 通过：新增插件的行 id 出现在 `--dump-config` 验证清单里；
3. 改动模型可见内容（工具 schema、skill 正文、提示词段）时，在 `dsh web` 会话里实测一次对应调用路径；
4. 改动客户端呈现时，在 `dsh web` 界面确认变化且刷新后不残留。

## 插件约定

- function plugin 只具名导出 `name` / `inject` / `Config`（有配置时）/ `apply`，没有 default export；宿主半为空的客户端包只导出 `apply`。
- 每项注册都经 `ctx.effect()` / `ctx.on()` 记账，插件卸载时全部回卷；禁止模块级副作用注册。
- 行 id 用 `our-` 前缀且全组合唯一；patch 的 `config` 字段是整体替换，覆盖配置时写完整对象。
- waterfall 监听器（`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*`）必须调用 `next()` 委托；`agent/turn-stopping` 例外，它串行且没有 `next()`。
- 模型可见文本（工具描述、schema、提示词段、skill 正文）保持确定性与稳定，动态内容不进模型可见表面，避免无谓的 KV Cache 失效。
- 出错就地崩溃：不捕获错误吞掉，不写 fallback。

## 内容纪律

- skill 正文只写「调用时机 + 参数含义 + 结果解读」；算法、业务规则、数据样本、内部端点一律留在绑定 CLI / MCP 的实现侧。论证与检验标准见 `../ai-agent-plan/docs/03-实现方案架构-为何Skill非核心.html`。
- skill 注册走无文档位（正文为插件内字符串或 provider `get()` 运行时拉取），`userInvocable: false` 收口用户侧。
- 业务能力先挂 `ctx.tools`（工具 schema 进提示词组装），说明书由插件内注册（正文为字符串或 provider 运行时拉取）。

## 客户端插件约定

- 双面包：`exports["./client"]` 指向 `lib/client.js`，包装格式由 `scripts/plugin-build.ts` 产出，不要手写 `__ModuleLoader__` 包装。
- 客户端代码运行时只 import 模块表内的包（react、声明在 `dsh.client.inject` 的 `@deepseek-ai/*`）与本包相对路径；跨插件值导入禁止，协作走 cordis 服务与 slot；`import type` 不受此限制。
- slot 注册声明自己渲染的 `children`，向他人声明的插槽贡献内容用 `ctx.slots.inject()` 等待声明出现。
- 样式与图片资源管道尚未接入共享预设，需要时先扩展 `scripts/plugin-build.ts` 再写业务代码。

## 开发调试事实

- host 代码改动重启 `dsh web` 生效；客户端 bundle 改动经 rev 重哈希热刷新；`dev/cordis.patch.yml` 改动 HMR 热组合。
- 插件不生效先看 `--dump-config` 的组合行，再看激活审计（fiber 因 `inject` 服务缺失停在 inactive 是常见原因），最后看 `ctx.logger` 输出。
- `.dsh-dev/` 的 profile 由 `dsh plugin` 命令维护，组合改动走 `dev/cordis.patch.yml` 与 `pnpm run inject`，不手工编辑。
- `dsh-lanpost-bridge` 的真实链路要 lanpost-im 客户端在场（内嵌网关默认 `wss://127.0.0.1:8443/ws/dsh` + 令牌），本机没有客户端时只能验证到「插件激活 + 设置页路由」；工具 output schema 只支持宿主子集（`type/oneOf/properties/required/additionalProperties/items/enum/const`，**不能用 `anyOf`**，否则插件激活即失败）。

## 指针

- 换标工作、构建发行策略、验证清单：`../ai-agent-plan/README.md` 第 6、7、9 节（做品牌或打包相关改动前读）。
- DSH 机制细节（事件三域、能力接缝、slot、组合层序）：`../ai-agent-plan/docs/04-dsh-架构详解.html`（写拦截器、注册工具、调 slot 前读）。
- DSH API 事实：`../deepseek-harness` 仓库源码（API 处于 pre-stable，第三方指南仅作辅助）。

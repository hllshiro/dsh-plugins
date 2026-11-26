# AI Agent 插件开发仓库

DSH（DeepSeek Harness）插件的开发仓库：pnpm workspace 单仓多包，一个插件一个包。开发调试时经官方 `dsh plugin add link:` 机制把全部插件自动注入隔离的 DSH 运行时，`pnpm dev` 一条命令构建、注入并启动。

需求与边界见 `../ai-agent-plan/README.md`（硬约束、扩展位置分解、构建发行策略），此处只记录仓库自身的结构与用法。

## 快速开始

```sh
pnpm install    # 安装依赖（含 @deepseek-ai/dsh 运行时，版本锁定）
pnpm run check  # 类型检查
pnpm run inject # 构建全部插件并注入开发 profile，用 --dump-config 验证组合
pnpm dev        # 注入后启动 dsh web（后台 watch 重建插件）
```

`pnpm dev -- --no-open` 可禁止自动打开浏览器，其余参数同样透传给 `dsh web`。

## 目录结构

| 路径 | 职责 |
|---|---|
| `packages/*` | 插件包，一个插件一个包（清单见下） |
| `scripts/plugin-build.ts` | 构建共享预设：宿主半 ESM，客户端半产出 `__ModuleLoader__` 工厂包装 |
| `scripts/inject.mjs` | 自动注入：`link:` 安装进开发 profile 并验证组合（幂等） |
| `scripts/dev.mjs` | 开发入口：watch 重建 + 启动 `dsh web` |
| `dev/cordis.patch.yml` | 开发调试覆盖层，`pnpm dev` 经 `--patch` 传入 |
| `.dsh-dev/` | 隔离的开发 DSH_HOME（gitignore，勿手工修改其 profiles） |

## 插件清单

| 包 | 行 id | 类型 | 职责 |
|---|---|---|---|
| `@hllshiro/business-example` | `our-business-example` | host | 业务系统对接插件模板，每个业务系统一个 |
| `@hllshiro/ui-brand` | `our-ui-brand` | client | 自有品牌呈现（四个品牌 slot） |

行 id 一律以 `our-` 开头，与官方配置行区分；各插件的机制归属与开发要点见各包 `src/index.ts` 注释与 `AGENTS.md`。

## 注入机制

- 每个插件包是标准 bundle：`dsh.bundle.patch` 声明 `cordis.patch.yml`，其中 `insert` 一行插件（行 id + 包名）。
- `scripts/inject.mjs` 把 `packages/*` 逐个以 `link:` 依赖安装进 `.dsh-dev/profiles/web`，安装走官方 `dsh plugin` 命令；随后 `dsh --profile web --dump-config` 验证每一行进入组合。
- 注入幂等：已安装的包跳过，可反复执行。
- 客户端插件经 `dsh-client-modules` 扫描进 `__DSH_BOOT__` 引导清单，`lib/client.js` 由 `/plugins/??<包名>/client.js&rev=<哈希>` 路由提供，整条外部客户端插件链路已在 `dsh web` 下验证。
- `DSH_HOME` 环境变量可指向其他 home（例如把插件注入自己的日常环境），默认 `<仓库>/.dsh-dev`。

## 开发循环

| 改动 | 生效方式 |
|---|---|
| host 插件代码 | 保存后 watch 自动重建，需重启 `dsh web` |
| 客户端插件代码 | 保存后 watch 自动重建，运行中的页面经 rev 重哈希自动刷新 |
| `dev/cordis.patch.yml` | HMR 热组合，无需重启 |
| 新增插件包 | `pnpm run inject` 后重启 `dsh web` |

调试排查顺序：`dsh --profile web --dump-config` 看行是否进组合，激活审计看 fiber 是否因服务缺失停在 inactive，`ctx.logger` 输出带 fiber 名。

## 版本策略

`@deepseek-ai/*` 依赖精确锁定（当前 dsh `0.2.2-rc.5`、cordis `4.1.0`），升级即改版本号并全量回归；API 处于 pre-stable，机制事实以 `../deepseek-harness` 仓库源码为准。

## 已知限制

- `link:` 依赖指向本仓库源码目录，安装产物不包含构建结果拷贝；发行打包另行处理（见 `../ai-agent-plan/README.md` 第 6 节）。
- 客户端共享预设目前只处理 JavaScript 与 TypeScript；CSS Modules、样式与图片资源管道需要时先扩展 `scripts/plugin-build.ts`。

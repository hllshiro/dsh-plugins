# @hllshiro/dsh-lanpost-bridge

DSH ↔ lanpost-im 适配插件（骨架占位，说明在后续任务补全）。

- 行 id：`our-dsh-lanpost-bridge`
- 双面：宿主半 `src/index.ts`，浏览器半 `src/client.ts`（经 `./client` 导出）
- 构建：`pnpm --filter @hllshiro/dsh-lanpost-bridge build`（共享预设 `scripts/plugin-build.ts`，`ws` 外置）

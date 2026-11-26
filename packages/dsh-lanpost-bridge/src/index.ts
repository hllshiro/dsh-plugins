import type { Context } from '@deepseek-ai/cordis'

export const name = 'our-dsh-lanpost-bridge'
export const inject = ['tools', 'webServer', 'sessionController']

// DSH ↔ lanpost-im 适配插件（骨架）：
// 宿主半装配 ws 网关客户端、入站编排器、agent 工具与 loopback 路由；
// 浏览器半在 settings.section 渲染配置页。当前任务只落空壳与注入通路。
export function apply(ctx: Context): void {
  ctx.logger.info('lanpost-bridge activated')
}

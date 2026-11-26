import type { Context } from '@deepseek-ai/cordis'

export const name = 'our-business-example'
export const inject = []

// 业务系统对接插件模板：每个业务系统一个包，只含三部分开发内容。
// 1. 工具定义：ctx.tools.register 注册工具 schema 与调用入口，能力实现留在
//    服务端或编译产物（绑定 CLI / MCP），算法、业务规则、数据不进本包；
// 2. 技能说明书：ctx.skills.register 注册，正文只写调用时机、参数含义、结果解读；
// 3. 鉴权配置：接入 tool-credentials 的令牌与配额体系，无凭证拒绝运行或降级。
export function apply(ctx: Context): void {
  ctx.logger.info('business-example activated')
}

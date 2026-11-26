import type { Context } from '@deepseek-ai/cordis'

// 职责：自有品牌呈现——占用 sidebar.brand.mark、sidebar.brand.name、
// conversation.hero.brand.mark、conversation.hero.frame 四个 slot。
// hero-mark 插槽必须占用：其回退动画本身就是官方标志。
export function apply(_ctx: Context): void {
  // TODO: 占用四个品牌 slot，注册自有标志与名称
}

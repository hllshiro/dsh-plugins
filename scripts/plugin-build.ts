// 插件构建共享预设：宿主半产出 ESM 的 lib/index.js；客户端半产出 DSH 模块加载器
// 要求的工厂包装（window.__ModuleLoader__.load），外部解析经注入的 require 走模块表。
// 包装格式遵循 DSH 仓库 packages/client/tsdown.client.ts 的输出契约。
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import type { UserConfig } from 'tsdown'

export function pluginBuilds(packageDir: string, options: { client?: boolean } = {}): UserConfig[] {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { name: string }
  const name = manifest.name
  // 模块表内的包（react、@deepseek-ai/*）保持 require 导入由加载器应答，其余全部内联
  const isExternal = (specifier: string): boolean =>
    specifier === 'react' || specifier === 'react-dom' || specifier.startsWith('@deepseek-ai/')
  const deps = {
    neverBundle: (specifier: string) => isBuiltin(specifier) || isExternal(specifier),
    alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isExternal(specifier),
  }
  const host: UserConfig = {
    name: `${name}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps,
  }
  if (options.client !== true) return [host]
  const client: UserConfig = {
    name: `${name}/client`,
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'cjs',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    deps,
    // cjs 格式在顶层 platform 下被当作 Node 目标，浏览器解析意图声明在 inputOptions
    inputOptions: { platform: 'browser' },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }
  return [host, client]
}

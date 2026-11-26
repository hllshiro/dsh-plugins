// 自动注入：把 packages/* 逐个以 link: 依赖安装进隔离开发 home 的 web profile，
// 并用 --dump-config 验证每一行进入组合。幂等：已安装的包跳过安装步骤。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const dshHome = process.env.DSH_HOME ?? join(repoRoot, '.dsh-dev')
const profile = 'web'

function fail(message) {
  console.error(`inject: ${message}`)
  process.exit(1)
}

export function dshBinPath() {
  const manifestPath = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(manifestPath)) fail('未找到 @deepseek-ai/dsh 安装，先运行 pnpm install')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string') fail('@deepseek-ai/dsh 未声明 dsh bin')
  return join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', bin)
}

export function runDsh(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [dshBinPath(), ...args], {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) fail(`dsh ${args.join(' ')} 无法执行：${result.error.message}`)
  if (result.status !== 0) {
    if (capture) {
      console.error(result.stdout)
      console.error(result.stderr)
    }
    fail(`dsh ${args.join(' ')} 退出码 ${result.status}`)
  }
  return result.stdout ?? ''
}

// 插件包 = 声明 dsh.bundle 的 packages/* 子目录；行 id 取其 cordis.patch.yml 的 insert 行
export function pluginPackages() {
  const packages = []
  for (const entry of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(repoRoot, 'packages', entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.dsh?.bundle?.patch === undefined) fail(`${manifest.name} 未声明 dsh.bundle.patch，无法注入`)
    const patch = readFileSync(join(dir, manifest.dsh.bundle.patch), 'utf8')
    const rowId = /^ *- id: *(\S+)/m.exec(patch)?.[1]
    if (rowId === undefined) fail(`${manifest.name} 的 ${manifest.dsh.bundle.patch} 没有 insert 行 id`)
    packages.push({ name: manifest.name, dir, rowId })
  }
  if (packages.length === 0) fail('packages/ 下没有插件包')
  packages.sort((a, b) => a.name.localeCompare(b.name))
  return packages
}

function profileDependencies() {
  const manifestPath = join(dshHome, 'profiles', profile, 'package.json')
  if (!existsSync(manifestPath)) return {}
  return JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies ?? {}
}

export function injectAll() {
  const packages = pluginPackages()
  console.log(`注入目标：DSH_HOME=${dshHome}，profile=${profile}`)
  for (const pkg of packages) {
    if (profileDependencies()[pkg.name] !== undefined) {
      console.log(`- ${pkg.name} 已安装，跳过`)
      continue
    }
    const spec = `link:${pkg.dir.split(sep).join('/')}`
    console.log(`- 安装 ${pkg.name}（${spec}）`)
    runDsh(['plugin', '--profile', profile, 'add', spec])
  }
  const dump = runDsh(['--profile', profile, '--dump-config'], { capture: true })
  for (const pkg of packages) {
    if (!dump.includes(pkg.rowId)) fail(`行 ${pkg.rowId}（${pkg.name}）未进入组合，请检查其 cordis.patch.yml 与安装输出`)
  }
  console.log('组合验证通过：')
  for (const pkg of packages) console.log(`  ✓ ${pkg.rowId} ← ${pkg.name}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) injectAll()

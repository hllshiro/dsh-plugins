// 开发调试入口（经 pnpm dev 调用，注入已在前置脚本完成）：
// 后台 watch 重建全部插件，前台启动 dsh web；dsh 退出时回收 watch 进程。
// 额外参数透传给 dsh web，例如 pnpm dev -- --no-open。
import { spawn } from 'node:child_process'
import { dshBinPath, dshHome, repoRoot } from './inject.mjs'

const shell = process.platform === 'win32'

const watchers = spawn('pnpm', ['-r', '--parallel', '--if-present', 'dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell,
})

const web = spawn(process.execPath, [dshBinPath(), 'web', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: dshHome },
})

web.on('exit', code => {
  watchers.kill()
  process.exit(code ?? 0)
})

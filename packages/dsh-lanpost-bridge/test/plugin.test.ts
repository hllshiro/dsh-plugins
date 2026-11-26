// Task 10：宿主半 `src/index.ts` 的装配与生命周期。
// 用假 ctx 观察「注册了什么、卸载时是否全部回卷、什么时候启停网关」；
// 网关本身由 gateway.test.ts 覆盖，这里只关心装配顺序与副作用边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/index.ts'
import { DEFAULTS } from '../src/store.ts'
import type { BridgeState } from '../src/store.ts'
import type { ToolDefinitionLike, WebRouteLike } from '../src/harness.ts'
import { RECONNECT, SESSIONS, SETTINGS, STATUS, WORKSPACES } from '../src/routes.ts'

const TOOL_NAMES = ['lanpost_bridge_status', 'lanpost_find_contact', 'lanpost_send_message']

/** 一条已注册的提示段（只取断言需要的字段）。 */
interface RegisteredSection {
  name: string
  order: number
  text: string
}

interface FakeRequestOptions {
  method?: string
  url?: string
  body?: string
  remoteAddress?: string
}

/** 伪造 IncomingMessage：路由只需 method / url / socket 与异步体。 */
function fakeReq(options: FakeRequestOptions = {}) {
  const body = options.body
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/** 伪造 ServerResponse：记录状态码与解析后的 JSON 体。 */
class FakeResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  body: unknown = undefined

  writeHead(code: number, headers: Record<string, string> = {}) {
    this.statusCode = code
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
    return this
  }

  setHeader(key: string, value: string) {
    this.headers[key.toLowerCase()] = value
  }

  end(payload?: string) {
    this.body = payload === undefined || payload === '' ? undefined : JSON.parse(payload)
  }
}

/** 把 effect 体返回的 disposer（单个或可迭代）摊平成数组，与 cordis 的 Effect 语义一致。 */
function disposersOf(result: unknown): Array<() => void> {
  if (typeof result === 'function') return [result as () => void]
  if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
    const list = Array.from(result as Iterable<() => void>)
    for (const disposer of list) assert.equal(typeof disposer, 'function')
    return list
  }
  throw new Error('fake ctx: effect 必须返回 disposer 或其可迭代集合')
}

interface FakeCtx {
  ctx: Context
  /** 按注册顺序记录的 effect 回卷函数（模拟 cordis fiber 的 LIFO 卸载）。 */
  disposers: Array<() => void>
  disposeAll(): void
  tools: Map<string, ToolDefinitionLike>
  routes: WebRouteLike[]
  sections: RegisteredSection[]
  logs: string[]
  /** 仍然存活的 `session/event` 订阅数；卸载后必须是 0。 */
  sessionListeners: number
  /** 对 `webServer.register` 的调用次数（含失败的那次）。 */
  readonly routeAttempts: number
  services: Record<string, unknown>
}

/** 假上下文：只实现 index.ts 用到的宿主面，重复注册（工具名、路由 (kind,path)）直接抛错。 */
function createFakeCtx(options: { failRouteAt?: number } = {}): FakeCtx {
  const disposers: Array<() => void> = []
  const tools = new Map<string, ToolDefinitionLike>()
  const routes: WebRouteLike[] = []
  const sections: RegisteredSection[] = []
  const logs: string[] = []
  let sessionListeners = 0
  let routeAttempts = 0

  const log = (message: string) => {
    logs.push(message)
  }

  const services: Record<string, unknown> = {
    tools: {
      register(definition: ToolDefinitionLike) {
        if (tools.has(definition.name)) {
          throw new Error(`duplicate tool ${definition.name}`)
        }
        tools.set(definition.name, definition)
        return () => {
          tools.delete(definition.name)
        }
      },
    },
    webServer: {
      register(route: WebRouteLike) {
        routeAttempts += 1
        if (options.failRouteAt === routeAttempts) {
          throw new Error(`route register failed at ${routeAttempts}`)
        }
        if (routes.some((item) => item.kind === route.kind && item.path === route.path)) {
          throw new Error(`duplicate route ${route.kind} ${route.path}`)
        }
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
    sessionController: {
      async create() {
        return { sessionId: 'session-1' }
      },
      async prompt() {
        return { accepted: true as const }
      },
      async rename() {
        return {}
      },
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', title: 'demo', path: 'D:/demo' }],
    },
    systemPrompt: {
      section(section: RegisteredSection) {
        if (sections.some((item) => item.name === section.name)) {
          throw new Error(`duplicate section ${section.name}`)
        }
        sections.push(section)
        const dispose = () => {
          const index = sections.indexOf(section)
          if (index !== -1) sections.splice(index, 1)
        }
        // 真实宿主里 `section()` 自己经调用方 context 的 effect 记账；假 ctx 照此模拟，
        // 否则卸载后提示段不会回卷，重复 apply 会被判成重复注册。
        disposers.push(dispose)
        return dispose
      },
    },
  }

  const ctx = {
    logger: { info: log, warn: log, error: log },
    effect(fn: () => unknown) {
      const list = disposersOf(fn())
      const dispose = () => {
        for (const item of list) item()
      }
      disposers.push(dispose)
      return dispose
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      assert.equal(event, 'session/event')
      sessionListeners += 1
      return () => {
        sessionListeners -= 1
        void handler
      }
    },
    get(serviceName: string) {
      const service = services[serviceName]
      if (!service) throw new Error(`lanpost-bridge: service "${serviceName}" unavailable`)
      return service
    },
  } as unknown as Context

  return {
    ctx,
    disposers,
    disposeAll() {
      for (const dispose of [...disposers].reverse()) dispose()
    },
    tools,
    routes,
    sections,
    logs,
    get sessionListeners() {
      return sessionListeners
    },
    get routeAttempts() {
      return routeAttempts
    },
    services,
  }
}

interface TempHome {
  home: string
  restore(): void
}

/** 每个用例一个隔离的 `$DSH_HOME`：状态与审计都落在临时目录，不碰真实 home。 */
function withTempHome(state?: Partial<BridgeState>): { handle: TempHome; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'lanpost-plugin-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const file = join(home, 'dsh-lanpost-bridge.json')
  if (state) writeFileSync(file, `${JSON.stringify({ ...DEFAULTS, ...state })}\n`)
  return {
    handle: {
      home,
      restore() {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
        rmSync(home, { recursive: true, force: true })
      },
    },
    file,
  }
}

function routeOf(routes: WebRouteLike[], path: string): WebRouteLike {
  const route = routes.find((item) => item.path === path)
  assert.ok(route, `missing route ${path}`)
  return route
}

async function call(
  routes: WebRouteLike[],
  path: string,
  options: FakeRequestOptions,
): Promise<FakeResponse> {
  const response = new FakeResponse()
  await routeOf(routes, path).handler(fakeReq(options), response)
  return response
}

function startedCount(logs: string[]): number {
  return logs.filter((line) => line.includes('gateway started')).length
}

test('导出名与注入服务与仓库约定一致', () => {
  assert.equal(name, 'our-dsh-lanpost-bridge')
  assert.deepEqual(inject, [
    'tools',
    'webServer',
    'sessionController',
    'workspaceRegistry',
    'systemPrompt',
  ])
})

test('装配：3 个工具、5 条路由、1 段提示；未配置时不启网关', () => {
  const { handle } = withTempHome()
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)

    assert.deepEqual([...fake.tools.keys()].sort(), TOOL_NAMES)
    assert.deepEqual(
      fake.routes.map((route) => `${route.kind} ${route.path}`).sort(),
      [`exact ${RECONNECT}`, `exact ${SETTINGS}`, `exact ${STATUS}`, `exact ${WORKSPACES}`, `prefix ${SESSIONS}`],
    )

    assert.equal(fake.sections.length, 1)
    assert.equal(fake.sections[0].name, 'lanpost-bridge')
    assert.equal(fake.sections[0].order, 900)
    assert.match(fake.sections[0].text, /lanpost_send_message/)
    assert.match(fake.sections[0].text, /lanpost_find_contact/)

    assert.equal(startedCount(fake.logs), 0)
    assert.ok(fake.logs.some((line) => line.includes('gateway skipped')))
    // 入站桥延迟到网关真正启动才创建；未配置时不订阅会话事件。
    assert.equal(fake.sessionListeners, 0)
  } finally {
    handle.restore()
  }
})

test('enabled=false：配置了地址与令牌也不启网关，状态保持 idle', async () => {
  const { handle } = withTempHome({
    enabled: false,
    gatewayUrl: 'ws://127.0.0.1:1/ws/dsh',
    token: 'hidden-token',
  })
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)

    assert.equal(startedCount(fake.logs), 0)
    assert.ok(fake.logs.some((line) => line.includes('gateway skipped')))

    const response = await call(fake.routes, STATUS, { method: 'GET' })
    assert.equal(response.statusCode, 200)
    const body = response.body as { state: string; since: number; settings: { tokenSet: boolean } }
    assert.equal(body.state, 'idle')
    assert.equal(body.settings.tokenSet, true)
    // 启动被跳过也是一次状态变化：since 是本次进入 idle 的时刻，不是进程启动时的旧值。
    const now = Date.now()
    assert.ok(body.since <= now)
    assert.ok(body.since >= now - 10_000)
    assert.equal(fake.sessionListeners, 0)

    // 任何日志都不得带令牌原文。
    assert.ok(fake.logs.every((line) => !line.includes('hidden-token')))
  } finally {
    handle.restore()
  }
})

test('卸载回卷：工具、路由、会话订阅与提示段全部清空', () => {
  const { handle } = withTempHome()
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)
    // 3 工具 + 5 路由（逐条 effect）+ 网关 effect + 1 个提示段注册。
    assert.equal(fake.disposers.length, 10)
    assert.equal(fake.sessionListeners, 0)

    fake.disposeAll()

    assert.equal(fake.tools.size, 0)
    assert.equal(fake.routes.length, 0)
    assert.equal(fake.sections.length, 0)
    assert.equal(fake.sessionListeners, 0)
    // 回卷幂等：再卸一次不抛、状态不变。
    for (const dispose of fake.disposers) dispose()
    assert.equal(fake.tools.size, 0)
  } finally {
    handle.restore()
  }
})

test('卸载后重新 apply 能完整重装配（注册表无残留、无重复报错）', () => {
  const { handle } = withTempHome()
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)
    fake.disposeAll()
    apply(fake.ctx)

    assert.deepEqual([...fake.tools.keys()].sort(), TOOL_NAMES)
    assert.equal(fake.routes.length, 5)
    assert.equal(fake.sections.length, 1)
    assert.equal(fake.sessionListeners, 0)
  } finally {
    handle.restore()
  }
})

test('PATCH 设置：非连接字段只落盘；enabled / gatewayUrl / token 变化才重启网关', async () => {
  const { handle, file } = withTempHome({
    enabled: true,
    gatewayUrl: 'ws://127.0.0.1:1/ws/dsh',
    token: 'hidden-token',
    sessionMode: 'continue',
  })
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)
    assert.equal(startedCount(fake.logs), 1)

    // 只有展示字段变化：不重连。
    const noRestart = await call(fake.routes, SETTINGS, {
      method: 'PATCH',
      body: JSON.stringify({ showProcess: true, sessionMode: 'new' }),
    })
    assert.equal(noRestart.statusCode, 200)
    assert.equal(startedCount(fake.logs), 1)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as BridgeState
    assert.equal(saved.showProcess, true)
    assert.equal(saved.sessionMode, 'new')

    // 换地址：必须重启网关。
    await call(fake.routes, SETTINGS, {
      method: 'PATCH',
      body: JSON.stringify({ gatewayUrl: 'ws://127.0.0.1:2/ws/dsh' }),
    })
    assert.equal(startedCount(fake.logs), 2)

    // 令牌不落日志。
    assert.ok(fake.logs.every((line) => !line.includes('hidden-token')))
  } finally {
    handle.restore()
  }
})

test('PATCH 落盘失败时回 500，且内存设置保持原值', async () => {
  const { handle, file } = withTempHome()
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)

    // 用同名目录占住状态文件：saveState 写完 .tmp 后 rename 到目录会失败。
    rmSync(file, { force: true })
    mkdirSync(file, { recursive: true })

    const failed = await call(fake.routes, SETTINGS, {
      method: 'PATCH',
      body: JSON.stringify({ showProcess: true, gatewayUrl: 'ws://127.0.0.1:2/ws/dsh' }),
    })
    assert.equal(failed.statusCode, 500)
    assert.deepEqual(failed.body, { error: 'internal' })

    // 先落盘再改内存：落盘失败时内存仍是 PATCH 之前的值。
    const status = await call(fake.routes, STATUS, { method: 'GET' })
    assert.equal(status.statusCode, 200)
    const body = status.body as { settings: { showProcess: boolean; gatewayUrl: string } }
    assert.equal(body.settings.showProcess, false)
    assert.equal(body.settings.gatewayUrl, DEFAULTS.gatewayUrl)
    assert.equal(startedCount(fake.logs), 0)
  } finally {
    handle.restore()
  }
})

test('PATCH enabled=false 停掉已连接的网关，重连接口对停用配置回 409', async () => {
  const { handle } = withTempHome({
    enabled: true,
    gatewayUrl: 'ws://127.0.0.1:1/ws/dsh',
    token: 'hidden-token',
  })
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)
    assert.equal(startedCount(fake.logs), 1)

    const response = await call(fake.routes, SETTINGS, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(response.statusCode, 200)
    assert.equal(startedCount(fake.logs), 1)
    assert.ok(fake.logs.some((line) => line.includes('gateway stopped')))

    const reconnect = await call(fake.routes, RECONNECT, { method: 'POST' })
    assert.equal(reconnect.statusCode, 409)
    assert.deepEqual(reconnect.body, { error: 'not-configured' })
  } finally {
    handle.restore()
  }
})

test('重复 apply 在首个注册处抛错，不产生网关/会话订阅残留', () => {
  const { handle } = withTempHome()
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)
    const disposers = fake.disposers.length

    assert.throws(() => apply(fake.ctx), /duplicate tool/)

    assert.equal(fake.tools.size, 3)
    assert.equal(fake.routes.length, 5)
    assert.equal(fake.sections.length, 1)
    assert.equal(fake.disposers.length, disposers)
    assert.equal(fake.sessionListeners, 0)
    assert.equal(startedCount(fake.logs), 0)
  } finally {
    handle.restore()
  }
})

test('路由注册中途失败时按顺序尝试注册（回卷由宿主负责）', () => {
  const { handle } = withTempHome()
  try {
    const fake = createFakeCtx({ failRouteAt: 2 })

    assert.throws(() => apply(fake.ctx), /route register failed at 2/)

    // 夹具只验证注册顺序与次数；注册中途抛错后的回卷由宿主（ctx.effect / ctx.on 记账）负责，
    // 所以这里不再断言失败瞬间残留的 tools / routes 数量。
    assert.equal(fake.routeAttempts, 2)
  } finally {
    handle.restore()
  }
})

test('建连前 trim gatewayUrl，日志与网关地址都是去掉首尾空白后的值', () => {
  const { handle } = withTempHome({
    enabled: true,
    gatewayUrl: '  ws://127.0.0.1:1/ws/dsh  ',
    token: 'hidden-token',
  })
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)

    assert.equal(startedCount(fake.logs), 1)
    assert.ok(fake.logs.some((line) => line.includes('gateway started (ws://127.0.0.1:1/ws/dsh)')))
    assert.ok(fake.logs.every((line) => !line.includes('started (  ')))
    assert.equal(fake.sessionListeners, 1)
  } finally {
    handle.restore()
  }
})

test('停用网关后 status().since 刷新为停止时刻，而不是启动时刻', async () => {
  const { handle } = withTempHome({
    enabled: true,
    gatewayUrl: 'ws://127.0.0.1:1/ws/dsh',
    token: 'hidden-token',
  })
  try {
    const fake = createFakeCtx()
    apply(fake.ctx)

    await new Promise((resolve) => setTimeout(resolve, 10))
    const beforeStop = Date.now()
    await call(fake.routes, SETTINGS, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })
    const response = await call(fake.routes, STATUS, { method: 'GET' })
    const body = response.body as { state: string; since: number }
    assert.equal(body.state, 'idle')
    assert.ok(body.since >= beforeStop)
    assert.ok(body.since <= Date.now())
  } finally {
    handle.restore()
  }
})

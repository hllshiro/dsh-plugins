// Task 10：宿主半 `src/index.ts` 的装配与生命周期。
// 用假 ctx 观察「注册了什么、卸载时是否全部回卷、什么时候启停网关」；
// 网关本身由 gateway.test.ts 覆盖，这里只关心装配顺序与副作用边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  services: Record<string, unknown>
}

/** 假上下文：只实现 index.ts 用到的宿主面，重复注册（工具名、路由 (kind,path)）直接抛错。 */
function createFakeCtx(): FakeCtx {
  const disposers: Array<() => void> = []
  const tools = new Map<string, ToolDefinitionLike>()
  const routes: WebRouteLike[] = []
  const sections: RegisteredSection[] = []
  const logs: string[] = []
  let sessionListeners = 0

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
    assert.equal(fake.sessionListeners, 1)
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
    const body = response.body as { state: string; settings: { tokenSet: boolean } }
    assert.equal(body.state, 'idle')
    assert.equal(body.settings.tokenSet, true)

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
    // 5 个 effect（网关 + 3 工具 + 路由）+ 1 个提示段注册。
    assert.equal(fake.disposers.length, 6)
    assert.equal(fake.sessionListeners, 1)

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
    assert.equal(fake.sessionListeners, 1)
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

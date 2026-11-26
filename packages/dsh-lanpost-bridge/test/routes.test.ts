import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  BASE,
  JSON_BODY_LIMIT,
  RECONNECT,
  SESSIONS,
  SETTINGS,
  STATUS,
  WORKSPACES,
  createRoutes,
} from '../src/routes.ts'
import type { RouteDeps } from '../src/routes.ts'
import { DEFAULTS, publicSettings } from '../src/store.ts'
import type { BridgeState } from '../src/store.ts'
import type { WebRouteLike } from '../src/harness.ts'

interface FakeRequestOptions {
  method?: string
  url?: string
  remoteAddress?: string
  body?: string | Buffer | Array<string | Buffer>
  headers?: Record<string, string>
}

/** 伪造的 IncomingMessage：只需要 method / url / socket / headers 与异步体。 */
function fakeReq(options: FakeRequestOptions = {}) {
  const body = options.body
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
    async *[Symbol.asyncIterator]() {
      const chunks = Array.isArray(body) ? body : body === undefined ? [] : [body]
      for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    },
  }
}

/** 伪造的 ServerResponse：记录状态码、头与解析后的 JSON 体。 */
class FakeResponse {
  statusCode = 0
  headers: Record<string, string> = {}
  raw = ''
  body: unknown = undefined

  writeHead(code: number, headers: Record<string, string> = {}) {
    this.statusCode = code
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    return this
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }

  end(payload?: string) {
    this.raw = payload ?? ''
    this.body = this.raw === '' ? undefined : JSON.parse(this.raw)
  }
}

interface Harness {
  routes: WebRouteLike[]
  state: BridgeState
  patches: Record<string, unknown>[]
  audits: Array<{ kind: string; detail: Record<string, unknown> }>
  cleared: string[]
  logs: string[]
  reconnects: () => number
}

function harness(overrides: Partial<RouteDeps> = {}): Harness {
  const state: BridgeState = { ...DEFAULTS, token: 'secret', sessions: {} }
  const patches: Record<string, unknown>[] = []
  const audits: Array<{ kind: string; detail: Record<string, unknown> }> = []
  const cleared: string[] = []
  const logs: string[] = []
  let reconnects = 0
  const deps: RouteDeps = {
    state: () => state,
    patch: (patch) => {
      patches.push(patch)
      Object.assign(state, patch)
    },
    reconnect: () => {
      reconnects += 1
    },
    status: () => ({ state: 'connected', since: 123 }),
    workspaces: () => [{ id: 'w1', title: 'demo', path: 'D:/demo' }],
    clearSession: (key) => {
      cleared.push(key)
    },
    audit: (kind, detail) => {
      audits.push({ kind, detail })
    },
    log: (message) => {
      logs.push(message)
    },
    ...overrides,
  }
  return { routes: createRoutes(deps), state, patches, audits, cleared, logs, reconnects: () => reconnects }
}

function routeOf(routes: WebRouteLike[], path: string): WebRouteLike {
  const route = routes.find((candidate) => candidate.path === path)
  assert.ok(route, `missing route ${path}`)
  return route
}

async function call(
  routes: WebRouteLike[],
  path: string,
  options: FakeRequestOptions,
): Promise<FakeResponse> {
  const res = new FakeResponse()
  await routeOf(routes, path).handler(fakeReq(options), res)
  return res
}

test('导出五个路由：四个 exact 加一个 prefix', () => {
  const { routes } = harness()
  assert.equal(routes.length, 5)
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ['exact', SETTINGS],
      ['exact', RECONNECT],
      ['exact', STATUS],
      ['exact', WORKSPACES],
      ['prefix', SESSIONS],
    ],
  )
  assert.equal(BASE, '/api/lanpost-bridge')
  assert.equal(SETTINGS, '/api/lanpost-bridge/settings')
  assert.equal(SESSIONS, '/api/lanpost-bridge/sessions')
})

test('非 loopback 一律 403，且在 405 判定之前', async () => {
  const h = harness()
  const cases: Array<[string, FakeRequestOptions]> = [
    [SETTINGS, { method: 'GET', url: SETTINGS }],
    [SETTINGS, { method: 'PATCH', url: SETTINGS, body: '{"sessionMode":"new"}' }],
    [SETTINGS, { method: 'POST', url: SETTINGS }],
    [RECONNECT, { method: 'POST', url: RECONNECT }],
    [STATUS, { method: 'GET', url: STATUS }],
    [WORKSPACES, { method: 'GET', url: WORKSPACES }],
    [SESSIONS, { method: 'DELETE', url: `${SESSIONS}/direct:p1` }],
  ]
  for (const [path, options] of cases) {
    const res = await call(h.routes, path, { ...options, remoteAddress: '10.0.0.5' })
    assert.equal(res.statusCode, 403, `${options.method} ${path}`)
    assert.deepEqual(res.body, { error: 'forbidden' })
  }
  assert.deepEqual(h.patches, [])
  assert.deepEqual(h.cleared, [])
  assert.equal(h.reconnects(), 0)
})

test('loopback 地址 127.0.0.1 / ::1 / ::ffff:127.0.0.1 均放行', async () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const res = await call(harness().routes, STATUS, { method: 'GET', url: STATUS, remoteAddress })
    assert.equal(res.statusCode, 200, remoteAddress)
  }
})

test('GET settings 返回 publicSettings，不回显 token', async () => {
  const res = await call(harness().routes, SETTINGS, { method: 'GET', url: SETTINGS })
  assert.equal(res.statusCode, 200)
  const body = res.body as { settings: Record<string, unknown> }
  assert.equal(body.settings.tokenSet, true)
  assert.equal('token' in body.settings, false)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
})

test('PATCH 只传白名单差异：未知键与空 token 丢弃，空字符串归一为 null', async () => {
  const h = harness()
  const res = await call(h.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionMode: 'new',
      token: '',
      evil: 1,
      workspaceId: '',
      selfProtocolId: '',
    }),
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(h.patches[0], {
    sessionMode: 'new',
    workspaceId: null,
    selfProtocolId: null,
  })
  assert.equal(h.state.token, 'secret')
  assert.equal(h.state.sessionMode, 'new')
  assert.equal(h.state.workspaceId, null)
  const body = res.body as { settings: { sessionMode: string; tokenSet: boolean } }
  assert.equal(body.settings.sessionMode, 'new')
  assert.equal(body.settings.tokenSet, true)
})

test('PATCH 的 token 提交前 trim，全空白视同不改', async () => {
  const h = harness()
  await call(h.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ token: '   new-secret   ' }),
  })
  assert.deepEqual(h.patches[0], { token: 'new-secret' })
  assert.equal(h.state.token, 'new-secret')

  const h2 = harness()
  await call(h2.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ token: '   ' }),
  })
  assert.deepEqual(h2.patches, [])
  assert.equal(h2.state.token, 'secret')
})

test('PATCH 忽略类型不符的白名单字段', async () => {
  const h = harness()
  await call(h.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ enabled: 'yes', sessionMode: 'bogus', showProcess: 1, workspaceId: 42 }),
  })
  assert.deepEqual(h.patches, [])
})

test('PATCH 忽略继承属性：原型被污染时也不会进入 patch', async () => {
  const h = harness()
  const polluted: Record<string, unknown> = {
    enabled: true,
    gatewayAddress: 'w-evil:1',
    workspaceId: 'w-evil',
    selfProtocolId: 'evil',
    sessionMode: 'new',
    showProcess: true,
    token: 'evil-token',
  }
  try {
    for (const [key, value] of Object.entries(polluted)) {
      Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true })
    }
    const res = await call(h.routes, SETTINGS, {
      method: 'PATCH',
      url: SETTINGS,
      body: JSON.stringify({ pad: 1 }),
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(h.patches, [])
    assert.equal(h.state.token, 'secret')
    assert.equal(h.state.sessionMode, 'continue')
  } finally {
    for (const key of Object.keys(polluted)) {
      delete (Object.prototype as Record<string, unknown>)[key]
    }
  }
})

test('PATCH 非法 JSON / 非对象 JSON / 空体一律 400', async () => {
  for (const body of ['{oops', '[]', 'null', '42', '']) {
    const h = harness()
    const res = await call(h.routes, SETTINGS, { method: 'PATCH', url: SETTINGS, body })
    assert.equal(res.statusCode, 400, `body=${body}`)
    assert.equal((res.body as { error: string }).error, 'invalid-json')
    assert.deepEqual(h.patches, [])
  }
})

test('PATCH 超出 body 上限返回 413，超限后不再累积字节', async () => {
  const h = harness()
  const req = fakeReq({
    method: 'PATCH',
    url: SETTINGS,
    body: ['x'.repeat(JSON_BODY_LIMIT), 'y'.repeat(4096)],
  })
  const res = new FakeResponse()
  await routeOf(h.routes, SETTINGS).handler(req, res)
  assert.equal(res.statusCode, 413)
  assert.deepEqual(res.body, { error: 'payload-too-large' })
  // destroy 会先毁 socket，客户端只会收到连接重置而不是 413。
  assert.equal(req.destroyed, false)
  assert.deepEqual(h.patches, [])
})

test('方法不符返回 405 并带 Allow', async () => {
  const cases: Array<[string, string, string, Array<string>]> = [
    [SETTINGS, 'POST', SETTINGS, ['GET', 'PATCH']],
    [RECONNECT, 'GET', RECONNECT, ['POST']],
    [STATUS, 'POST', STATUS, ['GET']],
    [WORKSPACES, 'POST', WORKSPACES, ['GET']],
    [SESSIONS, 'GET', `${SESSIONS}/direct:p1`, ['DELETE']],
  ]
  for (const [path, method, url, allow] of cases) {
    const res = await call(harness().routes, path, { method, url })
    assert.equal(res.statusCode, 405, `${method} ${path}`)
    assert.deepEqual(res.body, { error: 'method-not-allowed' })
    assert.deepEqual(res.headers['allow'], allow.join(', '))
  }
})

test('reconnect 未启用或未配置时 409 且不触发重连', async () => {
  const disabled = harness({ state: () => ({ ...DEFAULTS, token: 'secret' }) })
  const res = await call(disabled.routes, RECONNECT, { method: 'POST', url: RECONNECT })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.body, { error: 'not-configured' })
  assert.equal(disabled.reconnects(), 0)

  const noToken = harness({ state: () => ({ ...DEFAULTS, enabled: true, token: '' }) })
  const res2 = await call(noToken.routes, RECONNECT, { method: 'POST', url: RECONNECT })
  assert.equal(res2.statusCode, 409)
  assert.equal(noToken.reconnects(), 0)

  const noUrl = harness({ state: () => ({ ...DEFAULTS, enabled: true, token: 't', gatewayAddress: '' }) })
  const res3 = await call(noUrl.routes, RECONNECT, { method: 'POST', url: RECONNECT })
  assert.equal(res3.statusCode, 409)
})

test('reconnect 成功返回 ok 与网关状态', async () => {
  const h = harness()
  h.state.enabled = true
  const res = await call(h.routes, RECONNECT, { method: 'POST', url: RECONNECT })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { ok: true, status: { state: 'connected', since: 123 } })
  assert.equal(h.reconnects(), 1)
})

test('reconnect 响应只带网关状态的已知字段', async () => {
  const h = harness({
    status: () => ({
      state: 'connected',
      since: 123,
      lastSequence: 9,
      error: 'boom',
      notice: 'hi',
      token: 'secret',
    }),
  })
  h.state.enabled = true
  const res = await call(h.routes, RECONNECT, { method: 'POST', url: RECONNECT })
  assert.equal(res.statusCode, 200)
  const body = res.body as { ok: boolean; status: Record<string, unknown> }
  assert.deepEqual(body, {
    ok: true,
    status: { state: 'connected', since: 123, lastSequence: 9, error: 'boom', notice: 'hi' },
  })
  assert.equal(res.raw.includes('secret'), false)
})

test('status 合并网关状态、sessions 与 settings', async () => {
  const h = harness()
  h.state.sessions['direct:p1'] = { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' }
  const res = await call(h.routes, STATUS, { method: 'GET', url: STATUS })
  assert.equal(res.statusCode, 200)
  const body = res.body as Record<string, unknown>
  assert.equal(body.state, 'connected')
  assert.equal(body.since, 123)
  assert.deepEqual(body.sessions, h.state.sessions)
  assert.equal((body.settings as { tokenSet: boolean }).tokenSet, true)
  assert.equal('token' in (body.settings as object), false)
})

test('status 只展开已知字段，未来新增的敏感字段不外泄', async () => {
  const h = harness({
    status: () => ({ state: 'connected', since: 123, token: 'secret', lastSequence: 7 }),
  })
  const res = await call(h.routes, STATUS, { method: 'GET', url: STATUS })
  assert.equal(res.statusCode, 200)
  const body = res.body as Record<string, unknown>
  assert.deepEqual(body, {
    state: 'connected',
    since: 123,
    lastSequence: 7,
    sessions: {},
    settings: publicSettings(h.state),
  })
  assert.equal(res.raw.includes('secret'), false)
})

test('workspaces 返回注入的工作区列表', async () => {
  const res = await call(harness().routes, WORKSPACES, { method: 'GET', url: WORKSPACES })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { workspaces: [{ id: 'w1', title: 'demo', path: 'D:/demo' }] })
})

test('workspaces 抛错冒泡为 500，日志只记方法与路径（不含 query 与下游 message）', async () => {
  const h = harness({
    workspaces: () => {
      throw new Error('registry down token=secret')
    },
  })
  const res = await call(h.routes, WORKSPACES, {
    method: 'GET',
    url: `${WORKSPACES}?token=secret`,
  })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: 'internal' })
  assert.deepEqual(h.logs, ['lanpost-bridge route GET /api/lanpost-bridge/workspaces failed'])
  assert.equal(h.logs[0]!.includes('secret'), false)
})

test('DELETE 已存在的会话键：removed true，键按 URL 解码', async () => {
  const h = harness()
  h.state.sessions['direct:p1'] = { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' }
  const res = await call(h.routes, SESSIONS, {
    method: 'DELETE',
    url: `${SESSIONS}/direct%3Ap1?x=1`,
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { ok: true, removed: true })
  assert.deepEqual(h.cleared, ['direct:p1'])
  assert.deepEqual(h.audits, [
    { kind: 'sessions.delete', detail: { key: 'direct:p1', removed: true } },
  ])
})

test('DELETE 不存在的键：removed false 而不是 404', async () => {
  const h = harness()
  const res = await call(h.routes, SESSIONS, { method: 'DELETE', url: `${SESSIONS}/direct:p9` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { ok: true, removed: false })
  assert.deepEqual(h.cleared, ['direct:p9'])
})

test('DELETE 缺少键或尾斜杠：400 missing-key', async () => {
  for (const url of [SESSIONS, `${SESSIONS}/`]) {
    const h = harness()
    const res = await call(h.routes, SESSIONS, { method: 'DELETE', url })
    assert.equal(res.statusCode, 400, url)
    assert.deepEqual(res.body, { error: 'missing-key' })
    assert.deepEqual(h.cleared, [])
  }
})

test('DELETE 非法百分号编码：400 invalid-key', async () => {
  const res = await call(harness().routes, SESSIONS, {
    method: 'DELETE',
    url: `${SESSIONS}/%E0%A4%A`,
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body, { error: 'invalid-key' })
})

test('意外异常统一 500 internal，响应不回显异常内容', async () => {
  const h = harness({
    patch: () => {
      throw new Error('disk full token=secret')
    },
  })
  const res = await call(h.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: 'internal' })
  assert.equal(h.logs.length, 1)
  assert.equal(res.raw.includes('secret'), false)
  assert.deepEqual(h.logs, ['lanpost-bridge route PATCH /api/lanpost-bridge/settings failed'])
})

test('PATCH 地址归一为 host:port，非法地址 400 invalid-address', async () => {
  const h = harness()
  const ok = await call(h.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ gatewayAddress: '  ws://127.0.0.1:9015/ws/dsh  ' }),
  })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(h.patches[0], { gatewayAddress: '127.0.0.1:9015' })

  for (const bad of ['', 'not a host', '1.2.3.4:99999', 'ws://:9015/ws/dsh']) {
    const res = await call(harness().routes, SETTINGS, {
      method: 'PATCH',
      url: SETTINGS,
      body: JSON.stringify({ gatewayAddress: bad }),
    })
    assert.equal(res.statusCode, 400, `address=${bad}`)
    assert.deepEqual(res.body, { error: 'invalid-address' })
  }
})

test('PATCH 工作区只能是 DSH 已打开的工作区', async () => {
  const ok = harness()
  const res = await call(ok.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ workspaceId: 'w1' }),
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(ok.patches[0], { workspaceId: 'w1' })

  const unknown = harness()
  const bad = await call(unknown.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ workspaceId: 'nope' }),
  })
  assert.equal(bad.statusCode, 400)
  assert.deepEqual(bad.body, { error: 'unknown-workspace' })
  assert.deepEqual(unknown.patches, [])

  const cleared = harness()
  const clear = await call(cleared.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ workspaceId: '' }),
  })
  assert.equal(clear.statusCode, 200)
  assert.deepEqual(cleared.patches[0], { workspaceId: null })
})

test('PATCH 审计只记改了哪些键，不含值', async () => {
  const h = harness()
  await call(h.routes, SETTINGS, {
    method: 'PATCH',
    url: SETTINGS,
    body: JSON.stringify({ token: 'top-secret', enabled: true }),
  })
  assert.equal(h.audits.length, 1)
  assert.equal(h.audits[0]!.kind, 'settings.patch')
  assert.deepEqual(h.audits[0]!.detail, { keys: ['enabled', 'token'] })
  assert.equal(JSON.stringify(h.audits[0]!.detail).includes('top-secret'), false)
})

test('真实 HTTP 连接上 413 能送达客户端，连接之后仍可复用', async () => {
  const h = harness()
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = h.routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const oversize = await fetch(`${base}${SETTINGS}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(JSON_BODY_LIMIT + 1) }),
    })
    assert.equal(oversize.status, 413)
    assert.deepEqual(await oversize.json(), { error: 'payload-too-large' })

    const after = await fetch(`${base}${STATUS}`)
    assert.equal(after.status, 200)
    const payload = (await after.json()) as { settings: Record<string, unknown> }
    assert.equal(Object.hasOwn(payload.settings, 'token'), false)
    assert.equal(h.patches.length, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

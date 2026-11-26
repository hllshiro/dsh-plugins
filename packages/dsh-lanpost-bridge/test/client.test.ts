// 客户端设置页的可测半区：API 层、表单映射、状态文案。
// 组件本身没有 DOM 渲染环境，这里只钉住与 UI 解耦的纯函数；模块顶层不得有副作用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { BridgeStatus } from '../src/client.ts'

const importCalls: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  importCalls.push(String(input))
  throw new Error('模块加载期间不应发起 fetch')
}) as typeof fetch
const client = await import('../src/client.ts')
globalThis.fetch = realFetch

assert.equal(importCalls.length, 0, 'client 模块顶层不得发起 fetch')
assert.equal(typeof client.apply, 'function', '导出 apply')
assert.deepEqual(client.inject, ['slots'], '导出 slots 注入声明')

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

interface HandlerResult {
  status?: number
  body?: unknown
}

/** 替换全局 fetch，记录每次调用的 URL / init，并在测试结束后还原。 */
function installFetch(
  t: TestContext,
  handler: (url: string, init: RequestInit | undefined) => HandlerResult | Promise<HandlerResult>,
): RecordedCall[] {
  const recorded: RecordedCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    recorded.push({ url, init })
    const result = await handler(url, init)
    const status = result.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    } as unknown as Response
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })
  return recorded
}

const SAMPLE_SETTINGS = {
  enabled: true,
  gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
  tokenSet: true,
  workspaceId: 'ws-1',
  workspacePath: '/work/a',
  sessionMode: 'continue' as const,
  showProcess: false,
  selfProtocolId: 'me',
}

const BLANK_FORM = {
  enabled: false,
  gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
  token: '',
  workspaceId: '',
  workspacePath: '',
  sessionMode: 'new' as const,
  showProcess: true,
  selfProtocolId: '',
}

test('fetchSettings：GET /settings 并解包 settings 字段', async (t) => {
  const recorded = installFetch(t, () => ({ body: { settings: SAMPLE_SETTINGS } }))
  const settings = await client.fetchSettings()

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].url, '/api/lanpost-bridge/settings')
  assert.equal(recorded[0].init?.method ?? 'GET', 'GET')
  assert.deepEqual(settings, SAMPLE_SETTINGS)
  assert.equal('token' in settings, false, '公开设置不得回显令牌')
})

test('fetchSettings：也接受裸 PublicSettings，并为缺失字段补默认值', async (t) => {
  installFetch(t, () => ({ body: SAMPLE_SETTINGS }))
  assert.deepEqual(await client.fetchSettings(), SAMPLE_SETTINGS)

  installFetch(t, () => ({ body: {} }))
  assert.deepEqual(await client.fetchSettings(), {
    enabled: false,
    gatewayUrl: '',
    tokenSet: false,
    workspaceId: null,
    workspacePath: null,
    sessionMode: 'continue',
    showProcess: false,
    selfProtocolId: null,
  })
})

test('fetchSettings：非 2xx 抛带 status 与错误码的 Error', async (t) => {
  installFetch(t, () => ({ status: 500, body: { error: 'internal' } }))
  await assert.rejects(client.fetchSettings(), (error: unknown) => {
    assert.ok(error instanceof client.BridgeHttpError)
    assert.equal(error.status, 500)
    assert.equal(error.message, 'internal')
    return true
  })

  installFetch(t, () => ({ status: 404, body: null }))
  await assert.rejects(client.fetchSettings(), (error: unknown) => {
    assert.ok(error instanceof client.BridgeHttpError)
    assert.equal(error.status, 404)
    assert.equal(error.message, 'HTTP 404')
    return true
  })
})

test('patchSettings：PATCH JSON 并向回解包 settings', async (t) => {
  const recorded = installFetch(t, () => ({
    body: { settings: { ...SAMPLE_SETTINGS, sessionMode: 'new' as const } },
  }))
  const result = await client.patchSettings({ sessionMode: 'new' })

  assert.equal(recorded[0].url, '/api/lanpost-bridge/settings')
  assert.equal(recorded[0].init?.method, 'PATCH')
  const headers = recorded[0].init?.headers as Record<string, string> | undefined
  assert.equal(headers?.['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(recorded[0].init?.body)), { sessionMode: 'new' })
  assert.equal(result.sessionMode, 'new')
})

test('reconnect：POST /reconnect 并解包 ok/status（响应只有引擎字段）', async (t) => {
  const recorded = installFetch(t, () => ({
    body: { ok: true, status: { state: 'connected', since: 123, lastSequence: 9 } },
  }))
  const result = await client.reconnect()

  assert.equal(recorded[0].url, '/api/lanpost-bridge/reconnect')
  assert.equal(recorded[0].init?.method, 'POST')
  assert.equal(result.ok, true)
  assert.deepEqual(result.status, { state: 'connected', since: 123, lastSequence: 9 })
  assert.equal('sessions' in result.status, false, '重连响应不含映射表，必须靠 mergeEngineStatus 合并')
})

test('fetchStatus：读取 GET /status 的真实裸形状，notice 必须进入状态模型', async (t) => {
  const recorded = installFetch(t, () => ({
    body: {
      state: 'error',
      since: 99,
      error: '令牌已轮换，请更新令牌',
      notice: '令牌已轮换，请更新令牌',
      lastSequence: 7,
      sessions: {
        'private:u1': { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' },
        broken: { sessionId: 5 },
        alsoBroken: null,
      },
      settings: SAMPLE_SETTINGS,
    },
  }))
  const status = await client.fetchStatus()

  assert.equal(recorded[0].url, '/api/lanpost-bridge/status')
  assert.deepEqual(status, {
    state: 'error',
    since: 99,
    error: '令牌已轮换，请更新令牌',
    notice: '令牌已轮换，请更新令牌',
    lastSequence: 7,
    sessions: { 'private:u1': { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' } },
    settings: SAMPLE_SETTINGS,
  })
  assert.equal(status.notice, '令牌已轮换，请更新令牌')
})

test('fetchStatus：可选字段缺省时不产生键，未知状态回落 idle', async (t) => {
  installFetch(t, () => ({ body: { state: 'connected', since: 1, lastSequence: 3 } }))
  const status = await client.fetchStatus()
  assert.deepEqual(status, { state: 'connected', since: 1, lastSequence: 3 })
  assert.equal('error' in status, false)
  assert.equal('notice' in status, false)
  assert.equal('sessions' in status, false)
  assert.equal('settings' in status, false)

  installFetch(t, () => ({ body: { state: 'weird' } }))
  assert.deepEqual(await client.fetchStatus(), { state: 'idle' })
})

test('mergeEngineStatus：替换引擎字段，保住旧映射表与设置', () => {
  const previous: BridgeStatus = {
    state: 'error',
    since: 1,
    error: '令牌已轮换，请更新令牌',
    notice: '令牌已轮换，请更新令牌',
    lastSequence: 5,
    sessions: { 'private:u1': { sessionId: 's1', updatedAt: 't1' } },
    settings: SAMPLE_SETTINGS,
  }
  const merged = client.mergeEngineStatus(previous, { state: 'connected', since: 2, lastSequence: 6 })
  assert.deepEqual(merged, {
    state: 'connected',
    since: 2,
    lastSequence: 6,
    sessions: { 'private:u1': { sessionId: 's1', updatedAt: 't1' } },
    settings: SAMPLE_SETTINGS,
  })
  assert.equal('error' in merged, false, '引擎缺省 error 视为已清除')
  assert.equal('notice' in merged, false, '引擎缺省 notice 视为已清除')

  assert.deepEqual(client.mergeEngineStatus(null, { state: 'idle' }), { state: 'idle' })

  const replaced = client.mergeEngineStatus(previous, {
    state: 'connected',
    sessions: {},
    settings: { ...SAMPLE_SETTINGS, enabled: false },
  })
  assert.deepEqual(replaced.sessions, {})
  assert.equal(replaced.settings?.enabled, false)
})

test('fetchWorkspaces：解包 workspaces 并筛掉形状不对的项', async (t) => {
  const recorded = installFetch(t, () => ({
    body: {
      workspaces: [
        { id: 'a', title: 'A', path: '/a' },
        { id: 'b', path: '/b' },
        { id: 5, path: '/bad' },
        { id: 'c' },
        { path: '/missing-id' },
      ],
    },
  }))
  const workspaces = await client.fetchWorkspaces()

  assert.equal(recorded[0].url, '/api/lanpost-bridge/workspaces')
  assert.deepEqual(workspaces, [
    { id: 'a', title: 'A', path: '/a' },
    { id: 'b', path: '/b' },
  ])

  installFetch(t, () => ({ body: {} }))
  assert.deepEqual(await client.fetchWorkspaces(), [])
})

test('deleteSession：DELETE /sessions/:key 且回传宿主是否真的删掉', async (t) => {
  const key = 'private:u 1/2?x'
  const recorded = installFetch(t, () => ({ body: { ok: true, removed: true } }))
  assert.deepEqual(await client.deleteSession(key), { removed: true })

  assert.equal(recorded[0].url, `/api/lanpost-bridge/sessions/${encodeURIComponent(key)}`)
  assert.equal(recorded[0].init?.method, 'DELETE')

  installFetch(t, () => ({ body: { ok: true, removed: false } }))
  assert.deepEqual(await client.deleteSession(key), { removed: false })

  installFetch(t, () => ({ body: null }))
  assert.deepEqual(await client.deleteSession(key), { removed: false })
})

test('toForm：公开设置转表单，令牌永远留空', () => {
  assert.deepEqual(client.toForm(SAMPLE_SETTINGS), {
    enabled: true,
    gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
    token: '',
    workspaceId: 'ws-1',
    workspacePath: '/work/a',
    sessionMode: 'continue',
    showProcess: false,
    selfProtocolId: 'me',
  })

  assert.deepEqual(client.toForm({ ...SAMPLE_SETTINGS, workspaceId: null, workspacePath: null, selfProtocolId: null }).token, '')
  assert.equal(client.toForm({ ...SAMPLE_SETTINGS, workspaceId: null }).workspaceId, '')
  assert.equal(client.toForm({ ...SAMPLE_SETTINGS, workspacePath: null }).workspacePath, '')
  assert.equal(client.toForm({ ...SAMPLE_SETTINGS, selfProtocolId: null }).selfProtocolId, '')
})

test('toPatch：空令牌不提交，空工作区/路径/身份转 null', () => {
  const patch = client.toPatch(BLANK_FORM)
  assert.deepEqual(patch, {
    enabled: false,
    gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
    workspaceId: null,
    workspacePath: null,
    sessionMode: 'new',
    showProcess: true,
    selfProtocolId: null,
  })
  assert.equal('token' in patch, false)

  const blankToken = client.toPatch({ ...BLANK_FORM, token: '   ' })
  assert.equal('token' in blankToken, false, '纯空白令牌同样视为不改')
})

test('toPatch：去空白并保留非空令牌', () => {
  const patch = client.toPatch({
    ...BLANK_FORM,
    token: '  tok-1  ',
    workspaceId: ' w1 ',
    workspacePath: ' /p ',
    selfProtocolId: ' me ',
  })
  assert.deepEqual(patch, {
    enabled: false,
    gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
    workspaceId: 'w1',
    workspacePath: '/p',
    sessionMode: 'new',
    showProcess: true,
    selfProtocolId: 'me',
    token: 'tok-1',
  })
})

test('saveSuccessText：只有 enabled/gatewayUrl/token 变化才说已重连', () => {
  const saved = client.toForm(SAMPLE_SETTINGS)
  assert.equal(client.saveSuccessText(saved, saved), '已保存。')
  assert.equal(
    client.saveSuccessText(saved, { ...saved, showProcess: !saved.showProcess, workspacePath: '/other' }),
    '已保存。',
  )
  assert.equal(client.saveSuccessText(saved, { ...saved, enabled: !saved.enabled }), '已保存，网关已按新配置重连。')
  assert.equal(
    client.saveSuccessText(saved, { ...saved, gatewayUrl: '  wss://10.0.0.1:8443/ws/dsh  ' }),
    '已保存，网关已按新配置重连。',
  )
  assert.equal(client.saveSuccessText(saved, { ...saved, token: ' tok-2 ' }), '已保存，网关已按新配置重连。')
  assert.equal(client.saveSuccessText(saved, { ...saved, token: '   ' }), '已保存。')
})

test('apply：直接经 slots.inject 注册 settings.section，由 slot 自身记账', () => {
  const event: string[] = []
  const registrations: Array<Record<string, unknown>> = []
  let contribute: () => void = () => {
    throw new Error('slots.inject 未被调用')
  }
  const ctx = {
    slots: {
      inject(name: string, next: () => void) {
        event.push(`inject:${name}`)
        contribute = next
        return () => {
          event.push('inject:dispose')
        }
      },
      register(next: Record<string, unknown>) {
        registrations.push(next)
        event.push('register')
        return () => {
          event.push('register:dispose')
        }
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(event, ['inject:settings.section'])
  assert.equal(registrations.length, 0, '贡献函数被调用前不应注册')
  contribute()
  assert.deepEqual(event, ['inject:settings.section', 'register'])
  assert.equal(registrations.length, 1)
  const options = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'lanpost-bridge')
  assert.equal(options.order, 120)
  assert.equal(typeof options.label, 'function')
})

test('formatStatus / statusTone：连接状态文案与色调', () => {
  assert.equal(client.formatStatus({ state: 'connected' }), '已连接')
  assert.equal(client.formatStatus({ state: 'connecting' }), '连接中')
  assert.equal(client.formatStatus({ state: 'idle' }), '已断开')
  assert.equal(client.formatStatus({ state: 'error' }), '连接错误')
  assert.equal(client.formatStatus(null), '未知')
  assert.equal(client.formatStatus(undefined), '未知')
  assert.equal(client.formatStatus({ state: 'weird' }), '未知（weird）')

  assert.equal(client.statusTone('connected'), 'success')
  assert.equal(client.statusTone('connecting'), 'warn')
  assert.equal(client.statusTone('error'), 'danger')
  assert.equal(client.statusTone('idle'), 'neutral')
  assert.equal(client.statusTone(undefined), 'neutral')
})

test('formatError：已知错误码翻成中文，其余原样呈现', () => {
  assert.equal(
    client.formatError(new client.BridgeHttpError(409, 'not-configured')),
    '尚未配置：请先填写网关地址与令牌并启用',
  )
  assert.equal(
    client.formatError(new client.BridgeHttpError(418, 'teapot')),
    '请求失败（418）：teapot',
  )
  assert.equal(client.formatError(new Error('boom')), 'boom')
  assert.equal(client.formatError('raw'), 'raw')
  assert.equal(client.formatError(null), '未知错误')
})

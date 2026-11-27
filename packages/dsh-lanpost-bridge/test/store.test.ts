import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, loadState, mergeSettings, publicSettings, saveState, statePath } from '../src/store.ts'
import type { BridgeState } from '../src/store.ts'

const home = () => mkdtempSync(join(tmpdir(), 'lanpost-bridge-'))

test('缺文件时返回默认值且不落盘', () => {
  const dir = home()
  assert.deepEqual(loadState(dir), DEFAULTS)
  assert.equal(statSync(dir).isDirectory(), true)
})

test('保存后可读回，文件权限 0600', () => {
  const dir = home()
  const state = mergeSettings(DEFAULTS, { gatewayAddress: '127.0.0.1:1', token: 'secret-token' })
  saveState(state, dir)
  assert.equal(loadState(dir).gatewayAddress, '127.0.0.1:1')
  assert.equal(loadState(dir).token, 'secret-token')
  if (process.platform !== 'win32') assert.equal(statSync(statePath(dir)).mode & 0o777, 0o600)
})

test('publicSettings 不回显令牌', () => {
  const pub = publicSettings(mergeSettings(DEFAULTS, { token: 'secret-token' }))
  assert.equal(pub.tokenSet, true)
  assert.equal('token' in pub, false)
})

test('mergeSettings 忽略未知键，空 token 表示不改', () => {
  const base = mergeSettings(DEFAULTS, { token: 'keep-me' })
  const next = mergeSettings(base, { token: '', bogus: 1, sessionMode: 'new' })
  assert.equal(next.token, 'keep-me')
  assert.equal(next.sessionMode, 'new')
  assert.equal('bogus' in next, false)
})

test('损坏文件回退默认值', () => {
  const dir = home()
  writeFileSync(statePath(dir), '{not json')
  assert.deepEqual(loadState(dir), DEFAULTS)
  assert.equal(readFileSync(statePath(dir), 'utf8').length > 0, true)
})

// ---- 以下为 brief 之外的边界补充 ----

test('statePath 固定文件名：显式 home 优先，否则读 DSH_HOME 或 ~/.dsh', () => {
  const explicit = join(tmpdir(), 'lanpost-explicit-home')
  assert.equal(statePath(explicit), join(explicit, 'dsh-lanpost-bridge.json'))

  const previous = process.env.DSH_HOME
  const envHome = join(tmpdir(), 'lanpost-env-home')
  try {
    process.env.DSH_HOME = envHome
    assert.equal(statePath(), join(envHome, 'dsh-lanpost-bridge.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('缺文件时 loadState 不创建状态文件', () => {
  const dir = home()
  loadState(dir)
  assert.equal(existsSync(statePath(dir)), false)
})

test('loadState 每次返回独立副本，不串改 DEFAULTS', () => {
  const dir = home()
  const first = loadState(dir)
  const second = loadState(dir)
  assert.notEqual(first.seenEventIds, second.seenEventIds)
  assert.notEqual(first.sessions, second.sessions)
  assert.notEqual(first.seenEventIds, DEFAULTS.seenEventIds)
  assert.notEqual(first.sessions, DEFAULTS.sessions)

  first.seenEventIds.push('polluted')
  first.sessions['direct:u1'] = { sessionId: 's1', updatedAt: 't' }
  assert.deepEqual(DEFAULTS.seenEventIds, [])
  assert.deepEqual(DEFAULTS.sessions, {})
  assert.deepEqual(loadState(dir), DEFAULTS)
})

test('顶层不是对象的 JSON 也回退默认值', () => {
  for (const raw of ['[]', 'null', '"x"', '42', 'true']) {
    const dir = home()
    writeFileSync(statePath(dir), raw)
    assert.deepEqual(loadState(dir), DEFAULTS)
  }
})

test('状态文件字段类型不符时逐项回退默认值，未知键丢弃', () => {
  const dir = home()
  writeFileSync(
    statePath(dir),
    JSON.stringify({
      version: 2,
      enabled: 'yes',
      gatewayAddress: 42,
      token: 123,
      workspaceId: 7,
      sessionMode: 'weird',
      showProcess: 'true',
      selfProtocolId: false,
      lastSequence: -3,
      seenEventIds: 'x',
      sessions: [],
      bogus: 'drop-me',
    }),
  )
  const state = loadState(dir)
  assert.deepEqual(state, DEFAULTS)
  assert.equal('bogus' in state, false)
})

test('损坏的会话映射条目被丢弃，合法条目保留', () => {
  const dir = home()
  writeFileSync(
    statePath(dir),
    JSON.stringify({
      ...DEFAULTS,
      lastSequence: 7,
      seenEventIds: ['e1', 2, 'e3'],
      sessions: {
        good: { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' },
        missingField: { sessionId: 's2' },
        notObject: 'oops',
      },
    }),
  )
  const state = loadState(dir)
  assert.equal(state.lastSequence, 7)
  assert.deepEqual(state.seenEventIds, ['e1', 'e3'])
  assert.deepEqual(state.sessions, {
    good: { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' },
  })
})

test('mergeSettings 白名单与类型校验，接受 string|null', () => {
  const base = mergeSettings(DEFAULTS, {})
  const next = mergeSettings(base, {
    enabled: 'yes',
    gatewayAddress: 42,
    workspaceId: 7,
    sessionMode: 'weird',
    showProcess: true,
    selfProtocolId: 'p1',
    token: 123,
  })
  assert.equal(next.enabled, false)
  assert.equal(next.gatewayAddress, DEFAULTS.gatewayAddress)
  assert.equal(next.workspaceId, null)
  assert.equal(next.sessionMode, 'continue')
  assert.equal(next.showProcess, true)
  assert.equal(next.selfProtocolId, 'p1')
  assert.equal(next.token, '')
  assert.notEqual(next, base)
  assert.equal(base.showProcess, false)

  assert.equal(mergeSettings(DEFAULTS, { workspaceId: 'w1' }).workspaceId, 'w1')
  assert.equal(mergeSettings(DEFAULTS, { workspaceId: 'w1', selfProtocolId: 'p' }).selfProtocolId, 'p')
  assert.equal(mergeSettings(mergeSettings(DEFAULTS, { workspaceId: 'w1' }), { workspaceId: null }).workspaceId, null)
  assert.equal(mergeSettings(DEFAULTS, { enabled: true }).enabled, true)
  assert.equal(mergeSettings(DEFAULTS, { sessionMode: 'new' }).sessionMode, 'new')
})

test('mergeSettings 保留非设置字段且返回新对象', () => {
  const sessions = { 'direct:u1': { sessionId: 's1', updatedAt: 't' } }
  const base: BridgeState = { ...DEFAULTS, lastSequence: 9, seenEventIds: ['e1'], sessions }
  const next = mergeSettings(base, { showProcess: true })
  assert.equal(next.lastSequence, 9)
  assert.deepEqual(next.seenEventIds, ['e1'])
  assert.deepEqual(next.sessions, sessions)
  assert.equal(next.showProcess, true)
  assert.equal(base.showProcess, false)
})

test('mergeSettings 把地址归一为 host:port，非法值保留旧地址', () => {
  const parsed = mergeSettings(DEFAULTS, { gatewayAddress: '  ws://127.0.0.1:9/ws/dsh \n' })
  assert.equal(parsed.gatewayAddress, '127.0.0.1:9')
  assert.equal(mergeSettings(parsed, { gatewayAddress: '' }).gatewayAddress, '127.0.0.1:9')
  assert.equal(mergeSettings(parsed, { gatewayAddress: 'not a host' }).gatewayAddress, '127.0.0.1:9')
  assert.equal(parsed.gatewayAddress, '127.0.0.1:9')
})

test('loadState 跳过 sessions 里的原型链键，seenEventIds 里的同名字符串只是数据', () => {
  const dir = home()
  writeFileSync(
    statePath(dir),
    JSON.stringify({
      ...DEFAULTS,
      seenEventIds: ['__proto__', 'e1'],
      sessions: JSON.parse(
        '{"__proto__":{"sessionId":"polluted","updatedAt":"t"},"constructor":{"sessionId":"polluted2","updatedAt":"t"},"prototype":{"sessionId":"polluted3","updatedAt":"t"},"ok":{"sessionId":"s1","updatedAt":"t"}}',
      ),
    }),
  )

  const state = loadState(dir)
  assert.deepEqual(state.sessions, { ok: { sessionId: 's1', updatedAt: 't' } })
  assert.equal(Object.hasOwn(state.sessions, '__proto__'), false)
  assert.equal(Object.hasOwn(state.sessions, 'constructor'), false)
  assert.equal(Object.hasOwn(state.sessions, 'prototype'), false)
  assert.equal(Object.getPrototypeOf(state.sessions), Object.prototype)
  assert.deepEqual(state.seenEventIds, ['__proto__', 'e1'])
  assert.equal(({} as { sessionId?: string }).sessionId, undefined)
})

test('saveState 自动创建父目录且不残留 .tmp', () => {
  const dir = home()
  const nested = join(dir, 'a', 'b')
  const state = mergeSettings(DEFAULTS, { token: 'tok' })
  saveState(state, nested)
  assert.equal(loadState(nested).token, 'tok')
  assert.equal(existsSync(`${statePath(nested)}.tmp`), false)
})

test('saveState 覆盖已有文件（rename 原子替换）', () => {
  const dir = home()
  saveState(mergeSettings(DEFAULTS, { token: 'first' }), dir)
  saveState(mergeSettings(DEFAULTS, { token: 'second', showProcess: true }), dir)
  const state = loadState(dir)
  assert.equal(state.token, 'second')
  assert.equal(state.showProcess, true)
  assert.equal(existsSync(`${statePath(dir)}.tmp`), false)
})

test('saveState 失败时清掉 .tmp 并抛出原始错误', () => {
  const dir = home()
  // 目标路径被同名目录占住：rename 到目录会失败，正好覆盖「写完 tmp 但替换失败」。
  mkdirSync(statePath(dir), { recursive: true })
  writeFileSync(join(statePath(dir), 'blocker'), 'x')
  const tmp = `${statePath(dir)}.tmp`

  assert.throws(() => saveState(mergeSettings(DEFAULTS, { token: 'tok' }), dir))
  assert.equal(existsSync(tmp), false)
  assert.equal(statSync(statePath(dir)).isDirectory(), true)
})

test('saveState 完整状态可无损读回', () => {
  const dir = home()
  const state: BridgeState = {
    ...mergeSettings(DEFAULTS, { token: 'tok', enabled: true, sessionMode: 'new', workspaceId: 'w1' }),
    lastSequence: 42,
    seenEventIds: ['e1', 'e2'],
    sessions: { 'group:998877': { sessionId: 's1', updatedAt: '2026-11-26T00:00:00.000Z' } },
  }
  saveState(state, dir)
  assert.deepEqual(loadState(dir), state)
  assert.deepEqual(JSON.parse(readFileSync(statePath(dir), 'utf8')), state)
})

test('publicSettings 未配置令牌时 tokenSet=false，且不含内部状态字段', () => {
  const pub = publicSettings(DEFAULTS)
  assert.equal(pub.tokenSet, false)
  assert.deepEqual(Object.keys(pub).sort(), [
    'ackEnabled',
    'ackText',
    'enabled',
    'gatewayAddress',
    'ignorePrefixes',
    'recallAck',
    'selfProtocolId',
    'sessionMode',
    'showProcess',
    'tokenSet',
    'turnTimeoutSeconds',
    'workspaceId',
  ])
  assert.equal(pub.ackEnabled, true)
  assert.equal(pub.recallAck, true)
  assert.equal(pub.turnTimeoutSeconds, 1800)
  assert.equal('lastSequence' in pub, false)
  assert.equal('sessions' in pub, false)
  assert.equal('seenEventIds' in pub, false)
})

test('loadState 迁移旧版 gatewayUrl 为 host:port', () => {
  const dir = home()
  const legacy: Record<string, unknown> = { ...DEFAULTS, gatewayUrl: 'wss://192.168.2.8:9015/ws/dsh' }
  delete legacy.gatewayAddress
  writeFileSync(statePath(dir), `${JSON.stringify(legacy)}\n`)

  const state = loadState(dir)
  assert.equal(state.gatewayAddress, '192.168.2.8:9015')
  assert.equal('gatewayUrl' in state, false)
})

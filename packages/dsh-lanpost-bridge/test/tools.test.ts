import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.ts'
import type { ToolsDeps, ToolsGateway } from '../src/tools.ts'
import { GatewayError } from '../src/gateway.ts'
import type { GatewayStatus, SendResult } from '../src/gateway.ts'
import { DEFAULTS, publicSettings } from '../src/store.ts'
import type { BridgeState } from '../src/store.ts'
import type { ToolDefinitionLike } from '../src/harness.ts'

interface GatewayCalls {
  sendUser: Array<{ protocolId: string; text: string }>
  sendGroup: Array<{ groupId: string; text: string }>
  call: Array<{ method: string; params: unknown; timeoutMs: number | undefined }>
}

interface GatewayOverrides {
  status?: GatewayStatus
  sendUser?: (protocolId: string, text: string) => Promise<SendResult>
  sendGroup?: (groupId: string, text: string) => Promise<SendResult>
  call?: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
}

function makeGateway(overrides: GatewayOverrides = {}): { gateway: ToolsGateway; calls: GatewayCalls } {
  const calls: GatewayCalls = { sendUser: [], sendGroup: [], call: [] }
  const gateway: ToolsGateway = {
    status: () => overrides.status ?? { state: 'connected', since: 1_700_000_000_000 },
    sendUser: async (protocolId, text) => {
      calls.sendUser.push({ protocolId, text })
      return overrides.sendUser
        ? overrides.sendUser(protocolId, text)
        : { message_id: 'im:1', delivery_status: 'queued' }
    },
    sendGroup: async (groupId, text) => {
      calls.sendGroup.push({ groupId, text })
      return overrides.sendGroup
        ? overrides.sendGroup(groupId, text)
        : { message_id: 'im:2', delivery_status: 'queued' }
    },
    call: async (method, params, timeoutMs) => {
      calls.call.push({ method, params, timeoutMs })
      return overrides.call ? overrides.call(method, params, timeoutMs) : { users: [] }
    },
  }
  return { gateway, calls }
}

function makeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return { ...DEFAULTS, seenEventIds: [], sessions: {}, ...overrides }
}

function makeDeps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
  const state = makeState()
  return {
    gateway: () => undefined,
    settings: () => publicSettings(state),
    state: () => state,
    ...overrides,
  }
}

function allTools(overrides: Partial<ToolsDeps> = {}): ToolDefinitionLike[] {
  return createTools(makeDeps(overrides))
}

function toolNamed(tools: ToolDefinitionLike[], name: string): ToolDefinitionLike {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool, `缺少工具 ${name}`)
  return tool
}

interface SendSuccess {
  ok: true
  messageId: string
  deliveryStatus: string
}

interface Contact {
  protocol_id: string
  username: string
  display_name: string
  online: boolean
  last_seen_at: string | null
}

interface FindSuccess {
  ok: true
  contacts: Contact[]
  truncated: boolean
}

interface Failure {
  ok: false
  error: string
  code: number | string
}

interface StatusConnection {
  state: string
  since?: number
  error?: string
  notice?: string
}

interface StatusValue {
  enabled: boolean
  gatewayUrl: string
  connection: StatusConnection
  lastSequence: number | null
  tokenSet: boolean
  sessionMode: string
  showProcess: boolean
  sessions: number | null
  selfProtocolId: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  return value as Record<string, unknown>
}

function firstText(tool: ToolDefinitionLike, args: unknown, value: unknown): string {
  const blocks = tool.output.render(args, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  return blocks[0].text
}

function usersPayload(): { users: Array<Record<string, unknown>> } {
  return {
    users: Array.from({ length: 30 }, (_, index) => ({
      protocol_id: `p${index}`,
      username: `u${index}`,
      display_name: `U${index}`,
      hostname: `h${index}`,
      online: index < 2,
      last_seen_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
    })),
  }
}

test('createTools 按顺序暴露三个工具，parameters/output 都是自包含 JSON Schema', () => {
  const tools = allTools()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['lanpost_send_message', 'lanpost_find_contact', 'lanpost_bridge_status'],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} 的 description 太短`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }

  const send = toolNamed(tools, 'lanpost_send_message')
  assert.match(send.description, /16 KiB/)
  assert.match(send.description, /私聊/)
  assert.match(send.description, /群/)
  const sendProperties = asRecord(send.parameters.properties)
  assert.deepEqual(asRecord(sendProperties.target).enum, ['user', 'group'])
  assert.deepEqual(send.parameters.required, ['target', 'content'])
  assert.ok('protocol_id' in sendProperties)
  assert.ok('group_id' in sendProperties)
  assert.ok('content' in sendProperties)

  const find = toolNamed(tools, 'lanpost_find_contact')
  assert.match(find.description, /20/)
  assert.deepEqual(find.parameters.required, ['keyword'])

  const status = toolNamed(tools, 'lanpost_bridge_status')
  assert.match(status.description, /令牌/)
  assert.deepEqual(status.parameters.properties, {})
})

test('私聊发送走 sendUser 并返回 ok/messageId/deliveryStatus', async () => {
  const { gateway, calls } = makeGateway()
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')
  const args = { target: 'user', protocol_id: 'p1', content: 'hi' }

  const value = await send.execute(args, {})

  assert.deepEqual(value, { ok: true, messageId: 'im:1', deliveryStatus: 'queued' })
  assert.deepEqual(calls.sendUser, [{ protocolId: 'p1', text: 'hi' }])
  assert.equal(calls.sendGroup.length, 0)
  const text = firstText(send, args, value)
  assert.match(text, /私聊/)
  assert.match(text, /p1/)
  assert.match(text, /im:1/)
  assert.match(text, /queued/)
})

test('群发送走 sendGroup 并带上 group_id 与 content', async () => {
  const { gateway, calls } = makeGateway({
    sendGroup: async () => ({ message_id: 'im:9', delivery_status: 'sent' }),
  })
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')
  const args = { target: 'group', group_id: 'g1', content: '大家好' }

  const value = (await send.execute(args, {})) as SendSuccess

  assert.deepEqual(value, { ok: true, messageId: 'im:9', deliveryStatus: 'sent' })
  assert.deepEqual(calls.sendGroup, [{ groupId: 'g1', text: '大家好' }])
  assert.equal(calls.sendUser.length, 0)
  const text = firstText(send, args, value)
  assert.match(text, /群/)
  assert.match(text, /g1/)
  assert.match(text, /sent/)
})

test('网关未连接时发送返回 ok=false（code=not_connected），不抛错', async () => {
  const send = toolNamed(allTools(), 'lanpost_send_message')
  const args = { target: 'user', protocol_id: 'p1', content: 'hi' }

  const value = (await send.execute(args, {})) as Failure

  assert.equal(value.ok, false)
  assert.equal(value.code, 'not_connected')
  assert.match(value.error, /未连接/)
  const text = firstText(send, args, value)
  assert.match(text, /未连接/)
  assert.match(text, /启用/)
})

test('发送参数校验失败返回 ok=false 且 render 说明怎么改、绝不发送', async () => {
  const { gateway, calls } = makeGateway()
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['缺 target', { protocol_id: 'p1', content: 'hi' }, /target/],
    ['非法 target', { target: 'channel', protocol_id: 'p1', content: 'hi' }, /target/],
    ['私聊缺 protocol_id', { target: 'user', content: 'hi' }, /protocol_id/],
    ['群聊缺 group_id', { target: 'group', content: 'hi' }, /group_id/],
    [
      '私聊却传 group_id',
      { target: 'user', protocol_id: 'p1', group_id: 'g1', content: 'hi' },
      /group_id/,
    ],
    [
      '群聊却传 protocol_id',
      { target: 'group', group_id: 'g1', protocol_id: 'p1', content: 'hi' },
      /protocol_id/,
    ],
    ['空 content', { target: 'user', protocol_id: 'p1', content: '' }, /content/],
    ['全空白 content', { target: 'user', protocol_id: 'p1', content: '   ' }, /content/],
    ['content 非字符串', { target: 'user', protocol_id: 'p1', content: 42 }, /content/],
    ['protocol_id 为空', { target: 'user', protocol_id: '  ', content: 'hi' }, /protocol_id/],
    ['未知参数', { target: 'user', protocol_id: 'p1', content: 'hi', extra: 1 }, /未知参数.*extra/],
  ]

  for (const [label, args, expected] of cases) {
    const value = (await send.execute(args, {})) as Failure
    assert.equal(value.ok, false, label)
    assert.equal(value.code, 'invalid_args', label)
    assert.match(value.error, expected, label)
    const text = firstText(send, args, value)
    assert.match(text, expected, `${label}：render 要说明失败原因`)
    assert.match(text, /target=user/, `${label}：render 要说明参数格式`)
  }
  assert.equal(calls.sendUser.length, 0)
  assert.equal(calls.sendGroup.length, 0)
})

test('发送文本按 UTF-8 字节限制 16 KiB，边界与多字节都覆盖', async () => {
  const { gateway, calls } = makeGateway()
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')

  const atLimit = 'a'.repeat(16 * 1024)
  const okValue = (await send.execute(
    { target: 'user', protocol_id: 'p1', content: atLimit },
    {},
  )) as SendSuccess
  assert.equal(okValue.ok, true)
  assert.equal(calls.sendUser.length, 1)

  const overLimit = 'a'.repeat(16 * 1024 + 1)
  const overValue = (await send.execute(
    { target: 'user', protocol_id: 'p1', content: overLimit },
    {},
  )) as Failure
  assert.equal(overValue.ok, false)
  assert.equal(overValue.code, 'invalid_args')
  assert.match(overValue.error, /16 KiB/)
  assert.match(overValue.error, /16385/)
  assert.equal(calls.sendUser.length, 1)

  // 中文每字 3 字节：5461 字 = 16383 字节（放行），5462 字 = 16386 字节（拒绝）。
  const multibyteOk = (await send.execute(
    { target: 'user', protocol_id: 'p1', content: '中'.repeat(5461) },
    {},
  )) as SendSuccess
  assert.equal(multibyteOk.ok, true)
  const multibyteOver = (await send.execute(
    { target: 'user', protocol_id: 'p1', content: '中'.repeat(5462) },
    {},
  )) as Failure
  assert.equal(multibyteOver.ok, false)
  assert.match(multibyteOver.error, /16386/)
  assert.equal(calls.sendUser.length, 2)
})

test('GatewayError 映射成 ok=false 的 error/code，且不重试', async () => {
  let attempts = 0
  const { gateway } = makeGateway({
    sendUser: async () => {
      attempts += 1
      throw new GatewayError(-32013, '目标用户不存在')
    },
  })
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')
  const args = { target: 'user', protocol_id: 'p404', content: 'hi' }

  const value = (await send.execute(args, {})) as Failure

  assert.deepEqual(value, { ok: false, error: '目标用户不存在', code: -32013 })
  assert.equal(attempts, 1)
  const text = firstText(send, args, value)
  assert.match(text, /目标用户不存在/)
  assert.match(text, /-32013/)
})

test('非 GatewayError 的异常不被吞掉', async () => {
  const { gateway } = makeGateway({
    sendUser: async () => {
      throw new Error('boom')
    },
  })
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')

  await assert.rejects(
    send.execute({ target: 'user', protocol_id: 'p1', content: 'hi' }, {}),
    /boom/,
  )
})

test('find_contact 调 users.list（page_size 20/10s 超时）并投影前 20 条、标注截断', async () => {
  const { gateway, calls } = makeGateway({ call: async () => usersPayload() })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_find_contact')
  const args = { keyword: 'u' }

  const value = (await find.execute(args, {})) as FindSuccess

  assert.equal(value.ok, true)
  assert.equal(value.contacts.length, 20)
  assert.equal(value.truncated, true)
  assert.deepEqual(calls.call, [
    {
      method: 'users.list',
      params: { keyword: 'u', page: 1, page_size: 20 },
      timeoutMs: 10_000,
    },
  ])
  assert.deepEqual(value.contacts[0], {
    protocol_id: 'p0',
    username: 'u0',
    display_name: 'U0',
    online: true,
    last_seen_at: '2026-01-01T00:00:00Z',
  })
  assert.deepEqual(value.contacts[19], {
    protocol_id: 'p19',
    username: 'u19',
    display_name: 'U19',
    online: false,
    last_seen_at: '2026-01-01T00:00:19Z',
  })
  assert.equal('hostname' in asRecord(value.contacts[0]), false)

  const text = firstText(find, args, value)
  assert.match(text, /U0/)
  assert.match(text, /u0/)
  assert.match(text, /p0/)
  assert.match(text, /截断|前 20 条/)
})

test('find_contact 的 online_only=true 会带给网关，false/缺省不带', async () => {
  const withOnline = makeGateway({ call: async () => ({ users: [] }) })
  const findWithOnline = toolNamed(
    allTools({ gateway: () => withOnline.gateway }),
    'lanpost_find_contact',
  )
  await findWithOnline.execute({ keyword: '张', online_only: true }, {})
  assert.deepEqual(withOnline.calls.call[0].params, {
    keyword: '张',
    page: 1,
    page_size: 20,
    online: true,
  })

  const withoutOnline = makeGateway({ call: async () => ({ users: [] }) })
  const findWithoutOnline = toolNamed(
    allTools({ gateway: () => withoutOnline.gateway }),
    'lanpost_find_contact',
  )
  await findWithoutOnline.execute({ keyword: '张', online_only: false }, {})
  assert.deepEqual(withoutOnline.calls.call[0].params, {
    keyword: '张',
    page: 1,
    page_size: 20,
  })
})

test('find_contact 空结果返回空数组与 truncated=false，render 可读', async () => {
  const { gateway } = makeGateway({ call: async () => ({ users: [] }) })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_find_contact')
  const args = { keyword: 'nobody' }

  const value = (await find.execute(args, {})) as FindSuccess

  assert.deepEqual(value, { ok: true, contacts: [], truncated: false })
  assert.match(firstText(find, args, value), /没有找到/)
})

test('find_contact 参数校验失败返回 ok=false 且不调用网关', async () => {
  const { gateway, calls } = makeGateway({ call: async () => usersPayload() })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_find_contact')
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['缺 keyword', {}, /keyword/],
    ['空白 keyword', { keyword: '   ' }, /keyword/],
    ['keyword 非字符串', { keyword: 7 }, /keyword/],
    ['online_only 非布尔', { keyword: 'u', online_only: 'yes' }, /online_only/],
    ['未知参数', { keyword: 'u', foo: 1 }, /未知参数.*foo/],
  ]

  for (const [label, args, expected] of cases) {
    const value = (await find.execute(args, {})) as Failure
    assert.equal(value.ok, false, label)
    assert.equal(value.code, 'invalid_args', label)
    assert.match(value.error, expected, label)
    assert.match(firstText(find, args, value), expected, `${label}：render 要说明原因`)
  }
  assert.equal(calls.call.length, 0)
})

test('find_contact 的 GatewayError 也映射成 ok=false', async () => {
  const { gateway } = makeGateway({
    call: async () => {
      throw new GatewayError(-32001, '令牌无效')
    },
  })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_find_contact')
  const args = { keyword: 'u' }

  const value = (await find.execute(args, {})) as Failure

  assert.deepEqual(value, { ok: false, error: '令牌无效', code: -32001 })
  assert.match(firstText(find, args, value), /令牌无效/)
})

test('find_contact 对异常响应（缺 users 数组）明确报错而非静默空结果', async () => {
  const { gateway } = makeGateway({ call: async () => ({ unexpected: true }) })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_find_contact')

  const value = (await find.execute({ keyword: 'u' }, {})) as Failure

  assert.equal(value.ok, false)
  assert.equal(value.code, 'bad_response')
  assert.match(value.error, /users/)
})

test('bridge_status 汇总连接/游标/映射数量，绝不返回令牌原文', async () => {
  const state = makeState({
    enabled: true,
    gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
    token: 'TOP-SECRET-TOKEN',
    lastSequence: 42,
    sessionMode: 'new',
    showProcess: true,
    selfProtocolId: 'self-1',
    sessions: {
      'private:p1': { sessionId: 's1', updatedAt: '2026-01-01T00:00:00Z' },
      'group:g1': { sessionId: 's2', updatedAt: '2026-01-01T00:00:00Z' },
    },
  })
  const { gateway } = makeGateway()
  const status = toolNamed(
    allTools({
      gateway: () => gateway,
      settings: () => publicSettings(state),
      state: () => state,
    }),
    'lanpost_bridge_status',
  )

  const value = (await status.execute({}, {})) as StatusValue

  assert.deepEqual(value, {
    enabled: true,
    gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
    connection: { state: 'connected', since: 1_700_000_000_000 },
    lastSequence: 42,
    tokenSet: true,
    sessionMode: 'new',
    showProcess: true,
    sessions: 2,
    selfProtocolId: 'self-1',
  })
  assert.equal(JSON.stringify(value).includes('TOP-SECRET-TOKEN'), false)
  const text = firstText(status, {}, value)
  assert.equal(text.includes('TOP-SECRET-TOKEN'), false)
  assert.match(text, /已连接/)
  assert.match(text, /令牌.*已配置/)
  assert.match(text, /42/)
  assert.match(text, /2/)
})

test('bridge_status 未配置/未连接时不抛错，给出可读状态', async () => {
  const state = makeState({ enabled: false, token: '' })
  const status = toolNamed(
    allTools({ gateway: () => undefined, settings: () => publicSettings(state), state: () => state }),
    'lanpost_bridge_status',
  )

  const value = (await status.execute({}, {})) as StatusValue

  assert.deepEqual(value.connection, { state: 'idle' })
  assert.equal(value.enabled, false)
  assert.equal(value.tokenSet, false)
  assert.equal(value.lastSequence, 0)
  assert.equal(value.sessions, 0)
  const text = firstText(status, {}, value)
  assert.match(text, /未启用/)
  assert.match(text, /未连接/)
  assert.match(text, /令牌.*未配置/)
})

test('bridge_status 暴露上次错误与提示，但仍不含令牌', async () => {
  const state = makeState({ enabled: true, token: 'TOP-SECRET-TOKEN', lastSequence: 3 })
  const { gateway } = makeGateway({
    status: {
      state: 'error',
      since: 1_700_000_000_000,
      error: '握手失败：certificate expired',
      notice: '事件游标不连续',
    },
  })
  const status = toolNamed(
    allTools({
      gateway: () => gateway,
      settings: () => publicSettings(state),
      state: () => state,
    }),
    'lanpost_bridge_status',
  )

  const value = (await status.execute({}, {})) as StatusValue

  assert.equal(value.connection.state, 'error')
  assert.equal(value.connection.error, '握手失败：certificate expired')
  assert.equal(value.connection.notice, '事件游标不连续')
  const text = firstText(status, {}, value)
  assert.match(text, /certificate expired/)
  assert.match(text, /事件游标不连续/)
  assert.equal(text.includes('TOP-SECRET-TOKEN'), false)
})

test('bridge_status 在未注入 state 时用 null 表示未知，不编造数据', async () => {
  const state = makeState({ enabled: true, token: 'x' })
  const { gateway } = makeGateway()
  const status = toolNamed(
    allTools({ gateway: () => gateway, settings: () => publicSettings(state), state: undefined }),
    'lanpost_bridge_status',
  )

  const value = (await status.execute({}, {})) as StatusValue

  assert.equal(value.lastSequence, null)
  assert.equal(value.sessions, null)
  assert.match(firstText(status, {}, value), /未知/)
})

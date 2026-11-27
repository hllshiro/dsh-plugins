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
  sendImage: Array<{ target: unknown; name: string }>
  recallMessage: Array<{ messageId: string }>
  listGroups: number
  listGroupMembers: Array<{ groupId: string; options: unknown }>
  call: Array<{ method: string; params: unknown; timeoutMs: number | undefined }>
}

interface GatewayOverrides {
  status?: GatewayStatus
  sendUser?: (protocolId: string, text: string) => Promise<SendResult>
  sendGroup?: (groupId: string, text: string) => Promise<SendResult>
  sendImage?: (target: unknown, image: { data: Buffer; mimeType: string; name: string }) => Promise<SendResult & { attachment_id: string }>
  recallMessage?: (messageId: string) => Promise<{ message_id: string; recalled: boolean }>
  listGroups?: () => Promise<unknown>
  listGroupMembers?: (groupId: string, options: unknown) => Promise<unknown>
  call?: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
}

function makeGateway(overrides: GatewayOverrides = {}): { gateway: ToolsGateway; calls: GatewayCalls } {
  const calls: GatewayCalls = { sendUser: [], sendGroup: [], sendImage: [], recallMessage: [], listGroups: 0, listGroupMembers: [], call: [] }
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
    sendImage: async (target, image) => {
      calls.sendImage.push({ target, name: image.name })
      return overrides.sendImage
        ? overrides.sendImage(target, image)
        : { message_id: 'im:3', delivery_status: 'queued', attachment_id: 'att-1' }
    },
    recallMessage: async (messageId) => {
      calls.recallMessage.push({ messageId })
      return overrides.recallMessage ? overrides.recallMessage(messageId) : { message_id: messageId, recalled: true }
    },
    listGroups: async () => {
      calls.listGroups += 1
      return overrides.listGroups ? overrides.listGroups() : { groups: [] }
    },
    listGroupMembers: async (groupId, options) => {
      calls.listGroupMembers.push({ groupId, options })
      return overrides.listGroupMembers ? overrides.listGroupMembers(groupId, options) : { members: [] }
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

function summaryOf(state: BridgeState): { lastSequence: number; sessions: number } {
  return { lastSequence: state.lastSequence, sessions: Object.keys(state.sessions).length }
}

function makeDeps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
  const state = makeState()
  return {
    gateway: () => undefined,
    settings: () => publicSettings(state),
    state: () => summaryOf(state),
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
  deliveryStatus: string | null
}

interface Contact {
  protocol_id: string
  username: string
  display_name: string
  online: boolean
  last_seen_at: string | null
}

interface ListSuccess {
  ok: true
  contacts: Contact[]
  total: number | null
  page: number
  page_size: number
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
  gatewayAddress: string
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

/**
 * 宿主在 render 前用工具自己的 output.schema 校验返回值，且对象一律
 * `additionalProperties: false`：多一个未声明的键就直接 `invalid output`。
 * 这里做同构的键集合检查，把驼峰/下划线这类漂移挡在测试阶段。
 */
function assertDeclaredKeys(schema: unknown, value: unknown, path: string): void {
  if (Array.isArray(value)) {
    const items = asRecord(schema).items
    if (items !== undefined) {
      value.forEach((item, index) => assertDeclaredKeys(items, item, `${path}[${index}]`))
    }
    return
  }
  if (typeof value !== 'object' || value === null) return
  const properties = asRecord(schema).properties
  if (properties === undefined) return
  const declared = asRecord(properties)
  for (const key of Object.keys(value)) {
    assert.ok(key in declared, `${path}.${key} 未在 output schema 中声明`)
  }
  for (const [key, child] of Object.entries(declared)) {
    if (key in (value as Record<string, unknown>)) {
      assertDeclaredKeys(child, (value as Record<string, unknown>)[key], `${path}.${key}`)
    }
  }
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

test('createTools 按顺序暴露七个工具，parameters/output 都是自包含 JSON Schema', () => {
  const tools = allTools()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'lanpost_send_message',
      'lanpost_list_contacts',
      'lanpost_list_groups',
      'lanpost_list_group_members',
      'lanpost_recall_message',
      'lanpost_send_image',
      'lanpost_bridge_status',
    ],
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

  const list = toolNamed(tools, 'lanpost_list_contacts')
  assert.match(list.description, /protocol_id/)
  assert.match(list.description, /page_size/)
  assert.deepEqual(list.parameters.required, [])
  const listProperties = asRecord(list.parameters.properties)
  assert.deepEqual(Object.keys(listProperties).sort(), ['keyword', 'online_only', 'page', 'page_size'])

  const status = toolNamed(tools, 'lanpost_bridge_status')
  assert.match(status.description, /令牌/)
  assert.deepEqual(status.parameters.properties, {})
})

test('所有工具的成功与失败输出都只含 output schema 声明的字段', async () => {
  const online = allTools({ gateway: () => makeGateway().gateway })
  const offline = allTools()
  const listed = allTools({
    gateway: () =>
      makeGateway({
        call: async () => ({
          total: 3,
          users: [
            {
              protocol_id: 'p1',
              username: 'u1',
              display_name: 'U1',
              online: true,
              last_seen_at: null,
            },
          ],
        }),
      }).gateway,
  })

  const cases: Array<[string, ToolDefinitionLike, unknown]> = [
    ['send 成功', toolNamed(online, 'lanpost_send_message'), { target: 'user', protocol_id: 'p1', content: 'hi' }],
    ['send 未连接', toolNamed(offline, 'lanpost_send_message'), { target: 'user', protocol_id: 'p1', content: 'hi' }],
    ['list 成功（有 total）', toolNamed(listed, 'lanpost_list_contacts'), { keyword: 'u' }],
    ['list 成功（无 total）', toolNamed(online, 'lanpost_list_contacts'), {}],
    ['list 参数错误', toolNamed(online, 'lanpost_list_contacts'), { page: 0 }],
    ['list 未连接', toolNamed(offline, 'lanpost_list_contacts'), { keyword: 'u' }],
    ['status 未连接', toolNamed(offline, 'lanpost_bridge_status'), {}],
  ]

  for (const [label, tool, args] of cases) {
    const value = await tool.execute(args, {})
    assertDeclaredKeys(tool.output.schema, value, label)
  }
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

test('list_contacts 调 users.list（默认 page_size 50/10s 超时）并投影整页', async () => {
  const { gateway, calls } = makeGateway({ call: async () => usersPayload() })
  const list = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const args = { keyword: 'u' }

  const value = (await list.execute(args, {})) as ListSuccess

  assert.equal(value.ok, true)
  assert.equal(value.contacts.length, 30)
  assert.equal(value.page, 1)
  assert.equal(value.page_size, 50)
  assert.equal(value.total, null)
  assert.equal(value.truncated, false)
  assert.deepEqual(calls.call, [
    {
      method: 'users.list',
      params: { keyword: 'u', page: 1, page_size: 50 },
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
  assert.deepEqual(value.contacts[29], {
    protocol_id: 'p29',
    username: 'u29',
    display_name: 'U29',
    online: false,
    last_seen_at: '2026-01-01T00:00:29Z',
  })
  assert.equal('hostname' in asRecord(value.contacts[0]), false)

  const text = firstText(list, args, value)
  assert.match(text, /U0/)
  assert.match(text, /u0/)
  assert.match(text, /p0/)
  assert.match(text, /本页 30 个/)
})

test('list_contacts 省略或空白 keyword 表示不过滤，page/page_size 原样透传', async () => {
  const { gateway, calls } = makeGateway({ call: async () => ({ users: [], total: 0 }) })
  const list = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')

  await list.execute({}, {})
  assert.deepEqual(calls.call[0].params, { page: 1, page_size: 50 })

  await list.execute({ keyword: '  ', page: 2, page_size: 200 }, {})
  assert.deepEqual(calls.call[1].params, { page: 2, page_size: 200 })
})

test('list_contacts 的 online_only=true 会带给网关，false/缺省不带', async () => {
  const withOnline = makeGateway({ call: async () => ({ users: [] }) })
  const findWithOnline = toolNamed(
    allTools({ gateway: () => withOnline.gateway }),
    'lanpost_list_contacts',
  )
  await findWithOnline.execute({ keyword: '张', online_only: true }, {})
  assert.deepEqual(withOnline.calls.call[0].params, {
    keyword: '张',
    page: 1,
    page_size: 50,
    online: true,
  })

  const withoutOnline = makeGateway({ call: async () => ({ users: [] }) })
  const findWithoutOnline = toolNamed(
    allTools({ gateway: () => withoutOnline.gateway }),
    'lanpost_list_contacts',
  )
  await findWithoutOnline.execute({ keyword: '张', online_only: false }, {})
  assert.deepEqual(withoutOnline.calls.call[0].params, {
    keyword: '张',
    page: 1,
    page_size: 50,
  })
})

test('list_contacts 空结果返回空数组与 truncated=false，render 可读', async () => {
  const { gateway } = makeGateway({ call: async () => ({ users: [] }) })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const args = { keyword: 'nobody' }

  const value = (await find.execute(args, {})) as ListSuccess

  assert.deepEqual(value, {
    ok: true,
    contacts: [],
    total: null,
    page: 1,
    page_size: 50,
    truncated: false,
  })
  assert.match(firstText(find, args, value), /没有找到/)
})

test('list_contacts 参数校验失败返回 ok=false 且不调用网关', async () => {
  const { gateway, calls } = makeGateway({ call: async () => usersPayload() })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['keyword 非字符串', { keyword: 7 }, /keyword/],
    ['online_only 非布尔', { keyword: 'u', online_only: 'yes' }, /online_only/],
    ['page 非整数', { page: 1.5 }, /page/],
    ['page 小于 1', { page: 0 }, /page/],
    ['page_size 超上限', { page_size: 201 }, /page_size/],
    ['page_size 非整数', { page_size: '50' }, /page_size/],
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

test('list_contacts 的 GatewayError 也映射成 ok=false', async () => {
  const { gateway } = makeGateway({
    call: async () => {
      throw new GatewayError(-32001, '令牌无效')
    },
  })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const args = { keyword: 'u' }

  const value = (await find.execute(args, {})) as Failure

  assert.deepEqual(value, { ok: false, error: '令牌无效', code: -32001 })
  assert.match(firstText(find, args, value), /令牌无效/)
})

test('list_contacts 对异常响应（缺 users 数组）明确报错而非静默空结果', async () => {
  const { gateway } = makeGateway({ call: async () => ({ unexpected: true }) })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')

  const value = (await find.execute({ keyword: 'u' }, {})) as Failure

  assert.equal(value.ok, false)
  assert.equal(value.code, 'bad_response')
  assert.match(value.error, /users/)
})

test('bridge_status 汇总连接/游标/映射数量，绝不返回令牌原文', async () => {
  const state = makeState({
    enabled: true,
    gatewayAddress: '127.0.0.1:8443',
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
      state: () => summaryOf(state),
    }),
    'lanpost_bridge_status',
  )

  const value = (await status.execute({}, {})) as StatusValue

  assert.deepEqual(value, {
    enabled: true,
    gatewayAddress: '127.0.0.1:8443',
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
    allTools({ gateway: () => undefined, settings: () => publicSettings(state), state: () => summaryOf(state) }),
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
      state: () => summaryOf(state),
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

test('网关未返回投递状态时 deliveryStatus=null，render 明确说明而不伪装成状态值', async () => {
  const { gateway } = makeGateway({
    sendUser: async () => ({ message_id: 'im:3', delivery_status: '' }),
  })
  const send = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_message')
  const args = { target: 'user', protocol_id: 'p1', content: 'hi' }

  const value = (await send.execute(args, {})) as SendSuccess

  assert.equal(value.deliveryStatus, null)
  const text = firstText(send, args, value)
  assert.match(text, /网关未返回投递状态/)
  assert.equal(text.includes('unknown'), false)
})

test('本地错误不被标成网关错误码，bad_response 也单独命名', async () => {
  const send = toolNamed(allTools(), 'lanpost_send_message')
  const sendArgs = { target: 'user', protocol_id: 'p1', content: 'hi' }
  const notConnected = (await send.execute(sendArgs, {})) as Failure
  const notConnectedText = firstText(send, sendArgs, notConnected)
  assert.match(notConnectedText, /本地/)
  assert.equal(notConnectedText.includes('网关错误码'), false)

  const list = toolNamed(allTools(), 'lanpost_list_contacts')
  const listArgs = { page: 0 }
  const invalid = (await list.execute(listArgs, {})) as Failure
  const invalidText = firstText(list, listArgs, invalid)
  assert.match(invalidText, /参数错误（本地）/)
  assert.equal(invalidText.includes('网关错误码'), false)

  const bad = makeGateway({ call: async () => ({ unexpected: true }) })
  const badFind = toolNamed(allTools({ gateway: () => bad.gateway }), 'lanpost_list_contacts')
  const badArgs = { keyword: 'u' }
  const badValue = (await badFind.execute(badArgs, {})) as Failure
  const badText = firstText(badFind, badArgs, badValue)
  assert.match(badText, /响应格式异常（网关返回）/)
  assert.equal(badText.includes('网关错误码'), false)
})

test('list_contacts 用 total 判断下一页：刚好一页不标截断，total 更大才标', async () => {
  const users = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      protocol_id: `p${index}`,
      username: `u${index}`,
      display_name: `U${index}`,
      online: false,
      last_seen_at: null,
    }))

  const exact = makeGateway({ call: async () => ({ total: 50, users: users(50) }) })
  const exactFind = toolNamed(allTools({ gateway: () => exact.gateway }), 'lanpost_list_contacts')
  const exactValue = (await exactFind.execute({ keyword: 'u' }, {})) as ListSuccess
  assert.equal(exactValue.contacts.length, 50)
  assert.equal(exactValue.truncated, false)

  const more = makeGateway({ call: async () => ({ total: 75, users: users(50) }) })
  const moreFind = toolNamed(allTools({ gateway: () => more.gateway }), 'lanpost_list_contacts')
  const moreValue = (await moreFind.execute({ keyword: 'u' }, {})) as ListSuccess
  assert.equal(moreValue.contacts.length, 50)
  assert.equal(moreValue.truncated, true)
})

// 网关不给 total / has_more 时只能保守判断：拿满一页就当「可能还有更多」。
test('list_contacts 取满一页且没有分页信号时保守标注可能还有更多', async () => {
  const users = Array.from({ length: 50 }, (_, index) => ({
    protocol_id: `p${index}`,
    username: `u${index}`,
    display_name: `U${index}`,
    online: false,
    last_seen_at: null,
  }))
  const { gateway } = makeGateway({ call: async () => ({ users }) })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const args = { keyword: 'u' }
  const value = (await find.execute(args, {})) as ListSuccess

  assert.equal(value.contacts.length, 50)
  assert.equal(value.truncated, true)
  assert.match(firstText(find, args, value), /可能还有更多/)
})

test('list_contacts 49 条未拿满一页时不标截断', async () => {
  const users = Array.from({ length: 49 }, (_, index) => ({
    protocol_id: `p${index}`,
    username: `u${index}`,
    display_name: `U${index}`,
    online: false,
    last_seen_at: null,
  }))
  const { gateway } = makeGateway({ call: async () => ({ users }) })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const args = { keyword: 'u' }
  const value = (await find.execute(args, {})) as ListSuccess

  assert.equal(value.contacts.length, 49)
  assert.equal(value.truncated, false)
  assert.equal(firstText(find, args, value).includes('可能还有更多'), false)
})

test('render 折叠网关文本里的换行与控制字符', async () => {
  const { gateway } = makeGateway({
    call: async () => ({
      users: [
        {
          protocol_id: 'p\u0000evil',
          username: 'u\nname',
          display_name: 'bad\u0000display\nname',
          online: false,
          last_seen_at: '2026-01-01\nT00:00:00Z',
        },
      ],
    }),
  })
  const find = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_contacts')
  const args = { keyword: 'bad' }
  const value = (await find.execute(args, {})) as ListSuccess
  const text = firstText(find, args, value)

  assert.equal(text.includes('\u0000'), false)
  assert.match(text, /bad display name/)
  assert.match(text, /u name/)
  assert.equal(text.split('\n').length, 2)
  for (const line of text.split('\n')) {
    assert.equal(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(line), false)
  }

  const sendGateway = makeGateway({
    sendUser: async () => ({ message_id: 'im:\n1', delivery_status: 'queued\nok' }),
  })
  const send = toolNamed(allTools({ gateway: () => sendGateway.gateway }), 'lanpost_send_message')
  const sendArgs = { target: 'user', protocol_id: 'p1', content: 'hi' }
  const sendValue = (await send.execute(sendArgs, {})) as SendSuccess
  const sendText = firstText(send, sendArgs, sendValue)
  assert.equal(sendText.split('\n').length, 1)
  assert.match(sendText, /im: 1/)

  // 非字符串/空 message_id 不能渲染成空的 "messageId: "。
  const blankIdGateway = makeGateway({
    sendUser: async () => ({ message_id: '' }),
  })
  const blankSend = toolNamed(allTools({ gateway: () => blankIdGateway.gateway }), 'lanpost_send_message')
  const blankValue = (await blankSend.execute(sendArgs, {})) as SendSuccess
  assert.match(firstText(blankSend, sendArgs, blankValue), /（网关未返回消息 id）/)
})

test('bridge_status render 用绝对时间，多次渲染结果一致', async () => {
  const gateway = makeGateway().gateway
  const status = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_bridge_status')
  const value = (await status.execute({}, {})) as StatusValue
  const first = firstText(status, {}, value)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = firstText(status, {}, value)

  assert.equal(first, second)
  assert.equal(first.includes('已持续'), false)
  assert.equal(first.includes('距上次变化'), false)
  assert.ok(first.includes(new Date(1_700_000_000_000).toISOString()))
})

// ── 群、成员、撤回、图片 ────────────────────────────────────────────────────

test('lanpost_list_groups：投影群信息并渲染 group_id', async () => {
  const { gateway, calls } = makeGateway({
    listGroups: async () => ({
      groups: [
        {
          group_id: 'g1',
          group_name: '项目群',
          master_id: 'p1',
          master_display_name: '张三',
          topic: '每天同步',
          member_count: 8,
          updated_at: '2026-11-27T01:00:00Z',
        },
      ],
    }),
  })
  const tool = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_groups')
  const value = (await tool.execute({}, {})) as any

  assert.equal(calls.listGroups, 1)
  assert.equal(value.ok, true)
  assert.equal(value.groups[0].group_id, 'g1')
  assert.equal(value.groups[0].name, '项目群')
  assert.equal(value.groups[0].master_name, '张三')
  assert.equal(value.groups[0].member_count, 8)
  const text = firstText(tool, {}, value)
  assert.match(text, /项目群/)
  assert.match(text, /g1/)
})

test('lanpost_list_groups：网关缺方法时返回 -32601 提示', async () => {
  const { gateway } = makeGateway({
    listGroups: async () => {
      throw new GatewayError(-32601, 'Method not found')
    },
  })
  const tool = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_groups')
  const value = (await tool.execute({}, {})) as any
  assert.equal(value.ok, false)
  assert.equal(value.code, -32601)
  assert.match(firstText(tool, {}, value), /-32601/)
})

test('lanpost_list_group_members：透传分页并列出成员', async () => {
  const { gateway, calls } = makeGateway({
    listGroupMembers: async () => ({
      group_id: 'g1',
      group_name: '项目群',
      total: 3,
      members: [
        { protocol_id: 'p1', display_name: '张三', online: true, is_master: true },
        { protocol_id: 'p2', username: 'lisi', online: false, is_master: false },
      ],
    }),
  })
  const tool = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_list_group_members')
  const args = { group_id: 'g1', online_only: true, page: 2, page_size: 2 }
  const value = (await tool.execute(args, {})) as any

  assert.deepEqual(calls.listGroupMembers, [{ groupId: 'g1', options: { onlineOnly: true, page: 2, pageSize: 2 } }])
  assert.equal(value.ok, true)
  assert.equal(value.group_id, 'g1')
  assert.equal(value.members[1].name, 'lisi')
  assert.equal(value.page, 2)
  const text = firstText(tool, args, value)
  assert.match(text, /张三/)
  assert.match(text, /lisi/)
})

test('lanpost_list_group_members：缺少 group_id 时本地报错', async () => {
  const tool = toolNamed(allTools({ gateway: () => makeGateway().gateway }), 'lanpost_list_group_members')
  const value = (await tool.execute({}, {})) as any
  assert.equal(value.ok, false)
  assert.equal(value.code, 'invalid_args')
})

test('lanpost_recall_message：成功与形状校验', async () => {
  const { gateway, calls } = makeGateway()
  const tool = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_recall_message')
  const value = (await tool.execute({ message_id: 'im:42' }, {})) as any

  assert.deepEqual(calls.recallMessage, [{ messageId: 'im:42' }])
  assert.equal(value.ok, true)
  assert.equal(value.recalled, true)
  assert.match(firstText(tool, { message_id: 'im:42' }, value), /im:42/)

  const bad = (await tool.execute({ message_id: 'oops' }, {})) as any
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'invalid_args')
})

test('lanpost_send_image：读取本地文件后交给网关，返回附件 id', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'lanpost-img-'))
  const file = join(dir, 'a.png')
  writeFileSync(file, Buffer.from([1, 2, 3]))

  const { gateway, calls } = makeGateway()
  const tool = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_image')
  const args = { target: 'user', protocol_id: 'p1', path: file }
  const value = (await tool.execute(args, {})) as any

  assert.equal(value.ok, true)
  assert.equal(value.attachmentId, 'att-1')
  assert.equal(calls.sendImage[0].name, 'a.png')
  const text = firstText(tool, args, value)
  assert.match(text, /im:3/)
})

test('lanpost_send_image：非法扩展名与不存在的文件都在本地拒绝', async () => {
  const { gateway } = makeGateway()
  const tool = toolNamed(allTools({ gateway: () => gateway }), 'lanpost_send_image')

  const badExt = (await tool.execute({ target: 'user', protocol_id: 'p1', path: 'x.txt' }, {})) as any
  assert.equal(badExt.ok, false)
  assert.equal(badExt.code, 'invalid_args')

  const missing = (await tool.execute({ target: 'user', protocol_id: 'p1', path: 'no-such-file.png' }, {})) as any
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'invalid_args')
})
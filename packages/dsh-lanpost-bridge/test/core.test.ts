import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GATEWAY_ADDRESS,
  dedupeAdd,
  formatDuration,
  gatewayWsUrl,
  parseGatewayAddress,
  promptTextFor,
  replyParts,
  splitUtf8,
  stripGroupTrigger,
  workspaceOptions,
} from '../src/core.ts'

test('群前缀：命中剥掉，不命中返回 null', () => {
  assert.equal(stripGroupTrigger('/dsh 今天天气如何？'), '今天天气如何？')
  assert.equal(stripGroupTrigger('/DSH 你好'), '你好')
  assert.equal(stripGroupTrigger('/dsh'), '')
  assert.equal(stripGroupTrigger('/dshfoo'), null)
  assert.equal(stripGroupTrigger('今天天气'), null)
})

test('群前缀边界：多空白、换行、仅空白正文、空串', () => {
  assert.equal(stripGroupTrigger('/dsh   你好'), '你好')
  assert.equal(stripGroupTrigger('/dsh\n你好'), '你好')
  assert.equal(stripGroupTrigger('/dsh '), '')
  assert.equal(stripGroupTrigger('/dsh\t\t'), '')
  assert.equal(stripGroupTrigger(''), null)
  assert.equal(stripGroupTrigger('   /dsh 你好'), null)
  assert.equal(stripGroupTrigger('/dshx'), null)
})

test('splitUtf8 不切坏多字节字符且不超预算', () => {
  const parts = splitUtf8('你好世界'.repeat(100), 7)
  assert.ok(parts.every((p) => Buffer.byteLength(p, 'utf8') <= 7))
  assert.equal(parts.join(''), '你好世界'.repeat(100))
  const emoji = splitUtf8('😀😀😀', 4)
  assert.deepEqual(emoji, ['😀', '😀', '😀'])
  assert.throws(() => splitUtf8('x', 0))
})

test('splitUtf8 边界：空串、恰好装满、单码点超预算、非法预算', () => {
  assert.deepEqual(splitUtf8('', 8), [])
  assert.deepEqual(splitUtf8('abc', 3), ['abc'])
  assert.deepEqual(splitUtf8('abcd', 3), ['abc', 'd'])
  assert.deepEqual(splitUtf8('你好', 3), ['你', '好'])
  // 单个码点自身超过 maxBytes 时单独成段，绝不切开
  assert.deepEqual(splitUtf8('😀a', 1), ['😀', 'a'])
  assert.throws(() => splitUtf8('x', -1))
})

test('replyParts 超过 4000 字节才切段且带角标', () => {
  assert.deepEqual(replyParts('短回复'), ['短回复'])
  const long = '啊'.repeat(3000) // 9000 字节
  const parts = replyParts(long)
  assert.equal(parts.length, 3)
  assert.ok(parts[0].startsWith('(1/3) '))
  assert.ok(parts.every((p) => Buffer.byteLength(p, 'utf8') <= 4000))
})

test('replyParts 边界：恰好 4000 字节不切，1 字节超出即切且每段含角标不超预算', () => {
  const exact = 'a'.repeat(4000)
  assert.deepEqual(replyParts(exact), [exact])

  const over = replyParts('a'.repeat(4001))
  assert.equal(over.length, 2)
  assert.ok(over[0].startsWith('(1/2) '))
  assert.ok(over[1].startsWith('(2/2) '))
  assert.ok(over.every((p) => Buffer.byteLength(p, 'utf8') <= 4000))
  assert.equal(
    over.map((p) => p.replace(/^\(\d+\/\d+\) /, '')).join(''),
    'a'.repeat(4001),
  )

  const emoji = replyParts('😀'.repeat(2000)) // 8000 字节
  assert.ok(emoji.length > 1)
  assert.ok(emoji.every((p) => Buffer.byteLength(p, 'utf8') <= 4000))
  // 不出现半个 UTF-16 代理对
  assert.equal(
    emoji.map((p) => p.replace(/^\(\d+\/\d+\) /, '')).join(''),
    '😀'.repeat(2000),
  )
  assert.ok(emoji.every((p) => !/[\uD800-\uDBFF]$/.test(p.replace(/^\(\d+\/\d+\) /, ''))))
})

test('promptTextFor 首行带来源', () => {
  assert.equal(
    promptTextFor({ kind: 'private', name: '张三', username: 'zhangsan' }, '你好'),
    '[lanpost 私聊 · 张三 (zhangsan)]\n\n你好',
  )
  assert.equal(
    promptTextFor({ kind: 'group', name: '李四', username: 'lisi', groupId: '998877' }, '你好'),
    '[lanpost 群 998877 · 李四 (lisi)]\n\n你好',
  )
})

test('promptTextFor 降级：无 username、群无 groupId、多行正文', () => {
  assert.equal(
    promptTextFor({ kind: 'private', name: '张三' }, '你好'),
    '[lanpost 私聊 · 张三]\n\n你好',
  )
  assert.equal(
    promptTextFor({ kind: 'group', name: '李四' }, '第一行\n第二行'),
    '[lanpost 群 · 李四]\n\n第一行\n第二行',
  )
})

test('dedupeAdd 窗口上限与重复判定', () => {
  let list: string[] = []
  for (const id of ['a', 'b', 'c']) list = dedupeAdd(list, id, 2).list
  assert.deepEqual(list, ['c', 'b'])
  assert.equal(dedupeAdd(list, 'c', 2).added, false)
})

test('dedupeAdd 不修改入参且重复时原样返回', () => {
  const list = ['b', 'a']
  const duplicate = dedupeAdd(list, 'a', 5)
  assert.equal(duplicate.added, false)
  assert.deepEqual(duplicate.list, ['b', 'a'])
  assert.deepEqual(list, ['b', 'a'])
  const fresh = dedupeAdd(list, 'c', 5)
  assert.equal(fresh.added, true)
  assert.deepEqual(fresh.list, ['c', 'b', 'a'])
})

test('formatDuration', () => {
  assert.equal(formatDuration(12300), '12.3s')
  assert.equal(formatDuration(65000), '1m 5s')
})

test('formatDuration 边界', () => {
  assert.equal(formatDuration(0), '0.0s')
  assert.equal(formatDuration(59999), '60.0s')
  assert.equal(formatDuration(60000), '1m 0s')
  assert.equal(formatDuration(3600000), '60m 0s')
  // 59m59.999s 四舍五入到 60 秒时要进位成 60m，不能输出 `59m 60s`。
  assert.equal(formatDuration(3599999), '60m 0s')
  assert.equal(formatDuration(119999), '2m 0s')
})

test('parseGatewayAddress：只接受 host:port，接受带 scheme/path 的粘贴值', () => {
  assert.equal(DEFAULT_GATEWAY_ADDRESS, 'localhost:9015')
  assert.equal(parseGatewayAddress('localhost:9015'), 'localhost:9015')
  assert.equal(parseGatewayAddress('  192.168.2.8:9015  '), '192.168.2.8:9015')
  assert.equal(parseGatewayAddress('ws://192.168.2.8:9015/ws/dsh'), '192.168.2.8:9015')
  assert.equal(parseGatewayAddress('wss://example.local:8443'), 'example.local:8443')
  assert.equal(parseGatewayAddress('[::1]:9015'), '[::1]:9015')
  assert.equal(parseGatewayAddress('[::1]'), null)
  assert.equal(parseGatewayAddress('1.2.3.4'), null)
  assert.equal(parseGatewayAddress('1.2.3.4:99999'), null)
  assert.equal(parseGatewayAddress('1.2.3.4:0'), null)
  assert.equal(parseGatewayAddress(''), null)
  assert.equal(parseGatewayAddress('   '), null)
  assert.equal(parseGatewayAddress('http://1.2.3.4:9015'), '1.2.3.4:9015')
})

test('gatewayWsUrl：地址组装成明文 ws 地址', () => {
  assert.equal(gatewayWsUrl('localhost:9015'), 'ws://localhost:9015/ws/dsh')
  assert.equal(gatewayWsUrl('[::1]:9015'), 'ws://[::1]:9015/ws/dsh')
})
test('workspaceOptions：兼容 workspaceRegistry 的 {id, record:{path,title}} 与扁平形状', () => {
  assert.deepEqual(
    workspaceOptions([
      { id: 'w1', host: {}, record: { path: 'D:/demo', title: 'demo', sessionIds: [] } },
      { id: 'w2', title: 'plain', path: 'D:/plain' },
      { id: 'w3', record: { title: 'no-path' } },
      { id: '', path: 'D:/empty' },
      null,
      { id: 'w4', record: { path: 'C:/Users/xqkj' } },
    ]),
    [
      { id: 'w1', path: 'D:/demo', title: 'demo' },
      { id: 'w2', path: 'D:/plain', title: 'plain' },
      { id: 'w4', path: 'C:/Users/xqkj' },
    ],
  )
})
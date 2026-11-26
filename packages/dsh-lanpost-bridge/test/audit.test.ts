import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit, auditLine, auditPath } from '../src/audit.ts'

const home = () => mkdtempSync(join(tmpdir(), 'lanpost-audit-'))

test('audit 行格式：ISO 制表 kind 制表 JSON', () => {
  const line = auditLine('inbound', { conversationId: 'direct:x' }, '2026-11-26T02:00:00.000Z')
  assert.equal(line, '2026-11-26T02:00:00.000Z\tinbound\t{"conversationId":"direct:x"}')
})

test('appendAudit 追加到 $DSH_HOME 文件', () => {
  const dir = home()
  appendAudit(dir, 'reply', { bytes: 12 })
  appendAudit(dir, 'reply', { bytes: 34 })
  const text = readFileSync(auditPath(dir), 'utf8')
  assert.equal(text.trim().split('\n').length, 2)
  assert.match(text, /\treply\t\{"bytes":34\}/)
})

test('audit 行内 JSON 单行：detail 里的换行被转义', () => {
  const line = auditLine('inbound', { text: '第一行\n第二行' }, '2026-11-26T02:00:00.000Z')
  assert.equal(line, '2026-11-26T02:00:00.000Z\tinbound\t{"text":"第一行\\n第二行"}')
  assert.equal(line.includes('\n'), false)
})

test('audit 行：kind 含空格仍占一个字段，JSON 键序稳定', () => {
  const line = auditLine('inbound queue', { bytes: 3, target: 'user:u1' }, '2026-11-26T02:00:00.000Z')
  assert.equal(line, '2026-11-26T02:00:00.000Z\tinbound queue\t{"bytes":3,"target":"user:u1"}')
  assert.equal(line.split('\t').length, 3)
})

test('appendAudit 追加不覆盖已有内容', () => {
  const dir = home()
  const path = auditPath(dir)
  writeFileSync(path, '2026-11-26T01:00:00.000Z\tboot\t{}\n')
  appendAudit(dir, 'reply', { bytes: 7 })
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /\tboot\t\{\}$/)
  assert.match(lines[1], /\treply\t\{"bytes":7\}$/)
})

test('appendAudit 时间戳为 ISO 且文件权限 0600', () => {
  const dir = home()
  appendAudit(dir, 'reply', { bytes: 1 })
  const path = auditPath(dir)
  const first = readFileSync(path, 'utf8').split('\t')[0]
  assert.match(first, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

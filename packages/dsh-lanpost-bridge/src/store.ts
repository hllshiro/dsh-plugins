// lanpost-bridge 唯一持久化模块：状态文件读写、默认值、令牌脱敏、设置白名单合并。
// 状态落盘在 `$DSH_HOME/dsh-lanpost-bridge.json`，权限 0600，先写 `.tmp` 再 rename 原子替换。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 用户可在设置页调整的字段。 */
export interface BridgeSettings {
  enabled: boolean
  gatewayUrl: string
  token: string
  workspaceId: string | null
  workspacePath: string | null
  sessionMode: 'continue' | 'new'
  showProcess: boolean
  selfProtocolId: string | null
}

/** lanpost 会话键 → DSH 会话。 */
export interface SessionMapEntry {
  sessionId: string
  updatedAt: string
}

/** 落盘的完整状态：公开设置 + 事件游标、去重窗口与会话映射。 */
export interface BridgeState extends BridgeSettings {
  version: 1
  lastSequence: number
  seenEventIds: string[]
  sessions: Record<string, SessionMapEntry>
}

const STATE_FILE = 'dsh-lanpost-bridge.json'

/** 从 JSON 载入 `sessions` 时拒绝的键：避免原型链注入（值由用户可编辑的文件提供）。 */
const UNSAFE_SESSION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 未配置时的状态初值（新对象，调用方可以安全修改）。 */
export const DEFAULTS: BridgeState = {
  enabled: false,
  gatewayUrl: 'wss://127.0.0.1:8443/ws/dsh',
  token: '',
  workspaceId: null,
  workspacePath: null,
  sessionMode: 'continue',
  showProcess: false,
  selfProtocolId: null,
  version: 1,
  lastSequence: 0,
  seenEventIds: [],
  sessions: {},
}

/** 状态文件的绝对路径；`home` 显式优先，否则 `$DSH_HOME`，最后 `~/.dsh`。 */
export function statePath(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(home, STATE_FILE)
}

/** 每次调用都产出新的 `sessions` / `seenEventIds`，调用方可以随意改而不串到别处。 */
function freshDefaults(): BridgeState {
  return { ...DEFAULTS, seenEventIds: [], sessions: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 状态文件是用户可编辑的，逐字段校验类型；不符或未知字段一律丢弃/回退默认值。 */
function normalizeState(parsed: Record<string, unknown>): BridgeState {
  const state = freshDefaults()

  if (typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled
  // 与写入侧（mergeSettings）保持一致：载入时也 trim，避免状态页显示带空白的地址。
  if (typeof parsed.gatewayUrl === 'string') state.gatewayUrl = parsed.gatewayUrl.trim()
  if (typeof parsed.token === 'string') state.token = parsed.token
  if (typeof parsed.workspaceId === 'string' || parsed.workspaceId === null) {
    state.workspaceId = parsed.workspaceId
  }
  if (typeof parsed.workspacePath === 'string' || parsed.workspacePath === null) {
    state.workspacePath = parsed.workspacePath
  }
  if (parsed.sessionMode === 'continue' || parsed.sessionMode === 'new') {
    state.sessionMode = parsed.sessionMode
  }
  if (typeof parsed.showProcess === 'boolean') state.showProcess = parsed.showProcess
  if (typeof parsed.selfProtocolId === 'string' || parsed.selfProtocolId === null) {
    state.selfProtocolId = parsed.selfProtocolId
  }

  if (parsed.version === 1) state.version = 1
  if (
    typeof parsed.lastSequence === 'number' &&
    Number.isInteger(parsed.lastSequence) &&
    parsed.lastSequence >= 0
  ) {
    state.lastSequence = parsed.lastSequence
  }
  if (Array.isArray(parsed.seenEventIds)) {
    state.seenEventIds = parsed.seenEventIds.filter((id): id is string => typeof id === 'string')
  }
  if (isRecord(parsed.sessions)) {
    for (const [key, value] of Object.entries(parsed.sessions)) {
      if (UNSAFE_SESSION_KEYS.has(key)) continue
      if (
        isRecord(value) &&
        typeof value.sessionId === 'string' &&
        typeof value.updatedAt === 'string'
      ) {
        state.sessions[key] = { sessionId: value.sessionId, updatedAt: value.updatedAt }
      }
    }
  }

  return state
}

/** 读状态：文件缺失 / JSON 损坏 / 顶层不是对象时返回全新默认值；任何情况下都不写盘。 */
export function loadState(home?: string): BridgeState {
  let text: string
  try {
    text = readFileSync(statePath(home), 'utf8')
  } catch (error) {
    // 只把「文件不存在」当空状态；权限/目录等真实故障照旧抛出，不静默吞掉。
    if ((error as { code?: unknown }).code === 'ENOENT') return freshDefaults()
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return freshDefaults()
  }
  if (!isRecord(parsed)) return freshDefaults()
  return normalizeState(parsed)
}

/** 写状态：建目录 → 写 `.tmp`（0600）→ rename 原子替换；失败时清掉残留的 `.tmp`。 */
export function saveState(state: BridgeState, home?: string): void {
  const file = statePath(home)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    // 清理是尽力而为：即使清理也失败，也要抛出最初的写入/rename 错误。
    try {
      rmSync(tmp, { force: true, recursive: true })
    } catch {
      // 原始错误更有诊断价值，清理失败不覆盖它。
    }
    throw error
  }
}

/** 可回给浏览器的设置：去掉令牌原文，只暴露「是否已配置」。 */
export interface PublicSettings extends Omit<BridgeSettings, 'token'> {
  tokenSet: boolean
}

/** 可回给浏览器的设置投影：去掉令牌原文，只保留「是否已配置」。 */
export function publicSettings(state: BridgeState): PublicSettings {
  return {
    enabled: state.enabled,
    gatewayUrl: state.gatewayUrl,
    workspaceId: state.workspaceId,
    workspacePath: state.workspacePath,
    sessionMode: state.sessionMode,
    showProcess: state.showProcess,
    selfProtocolId: state.selfProtocolId,
    tokenSet: state.token !== '',
  }
}

/**
 * 合并设置补丁：只接受白名单键，类型不符的值忽略；`token` 为空串或非字符串表示「不改令牌」。
 * `gatewayUrl` 统一 trim，空串表示清空地址。返回新对象，不修改 `state`。
 */
export function mergeSettings(state: BridgeState, patch: Record<string, unknown>): BridgeState {
  const next: BridgeState = { ...state }
  if (!isRecord(patch)) return next

  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (typeof patch.gatewayUrl === 'string') next.gatewayUrl = patch.gatewayUrl.trim()
  if (typeof patch.token === 'string' && patch.token !== '') next.token = patch.token
  if (typeof patch.workspaceId === 'string' || patch.workspaceId === null) {
    next.workspaceId = patch.workspaceId
  }
  if (typeof patch.workspacePath === 'string' || patch.workspacePath === null) {
    next.workspacePath = patch.workspacePath
  }
  if (patch.sessionMode === 'continue' || patch.sessionMode === 'new') {
    next.sessionMode = patch.sessionMode
  }
  if (typeof patch.showProcess === 'boolean') next.showProcess = patch.showProcess
  if (typeof patch.selfProtocolId === 'string' || patch.selfProtocolId === null) {
    next.selfProtocolId = patch.selfProtocolId
  }

  return next
}

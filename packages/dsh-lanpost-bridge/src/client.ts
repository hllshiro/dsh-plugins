// 设置页浏览器半：在 DSH 设置面板的 settings.section 槽里渲染 lanpost 网关配置。
// 所有读写都走宿主暴露的 loopback 路由 `/api/lanpost-bridge/*`；令牌只写不读。
// 本文件是构建预设包装（window.__ModuleLoader__）factory 内的普通 ESM 源码：
// 运行时只能 import react 与模块表内的包，这里只依赖 react，界面全部用 createElement 写。
import * as React from 'react'

/** 宿主路由前缀；与 src/routes.ts 的 BASE 保持一致。 */
export const API_BASE = '/api/lanpost-bridge'

/** 新建会话的策略：继续复用映射会话，或每条消息单开一条。 */
export type SessionMode = 'continue' | 'new'

/** 网关连接状态，与宿主 GatewayStatus.state 同域。 */
export type BridgeStateName = 'idle' | 'connecting' | 'connected' | 'error'

/** 设置页拿到的公开设置：绝不含令牌原文，只带 tokenSet 标记。 */
export interface PublicSettings {
  enabled: boolean
  gatewayUrl: string
  tokenSet: boolean
  workspaceId: string | null
  workspacePath: string | null
  sessionMode: SessionMode
  showProcess: boolean
  selfProtocolId: string | null
}

/** 工作区下拉的一项。 */
export interface WorkspaceEntry {
  id: string
  title?: string
  path: string
}

/** 来源键 → DSH 会话的映射项。 */
export interface SessionEntry {
  sessionId: string
  updatedAt: string
}

/** GET /status 归一化后的形状：连接状态 + 游标 + 会话映射。 */
export interface BridgeStatus {
  state: BridgeStateName
  /**
   * 会话映射；`null` 表示「未知」（如刚重连、还没拉过 /status），缺省表示响应未携带。
   * 二者都不能当成空表渲染。
   */
  sessions?: Record<string, SessionEntry> | null
  since?: number
  error?: string
  /** 需要告知上层但不算失败的提示（如令牌已轮换、连接数超限、游标重置）。 */
  notice?: string
  lastSequence?: number
  settings?: PublicSettings
}

/** POST /reconnect 的返回。 */
export interface ReconnectResult {
  ok: boolean
  status: BridgeStatus
}

/** 宿主路由返回非 2xx 时抛的错，带 HTTP 状态码。 */
export class BridgeHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'BridgeHttpError'
    this.status = status
  }
}

/** 宿主路由在时限内没有响应；文案直接面向设置页，避免只抛一个 AbortError。 */
export class BridgeTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`请求超时：宿主在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`)
    this.name = 'BridgeTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStateName(value: unknown): BridgeStateName | undefined {
  return value === 'idle' || value === 'connecting' || value === 'connected' || value === 'error'
    ? value
    : undefined
}

function normalizeSessions(raw: unknown): Record<string, SessionEntry> {
  if (!isRecord(raw)) return {}
  const sessions: Record<string, SessionEntry> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    if (typeof value.sessionId !== 'string' || value.sessionId === '') continue
    sessions[key] = {
      sessionId: value.sessionId,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    }
  }
  return sessions
}

/**
 * 公开设置归一化：为字段缺失补默认值，避免设置页因半截响应崩溃。
 * 同时接受 `{ settings: ... }` 与裸对象（防御性：GET /status 里已解包的就是裸 settings）。
 */
export function normalizeSettings(raw: unknown): PublicSettings {
  const outer = isRecord(raw) ? raw : {}
  const source = isRecord(outer.settings) ? outer.settings : outer
  return {
    enabled: source.enabled === true,
    gatewayUrl: typeof source.gatewayUrl === 'string' ? source.gatewayUrl : '',
    tokenSet: source.tokenSet === true,
    workspaceId: typeof source.workspaceId === 'string' && source.workspaceId !== '' ? source.workspaceId : null,
    workspacePath:
      typeof source.workspacePath === 'string' && source.workspacePath !== '' ? source.workspacePath : null,
    sessionMode: source.sessionMode === 'new' ? 'new' : 'continue',
    showProcess: source.showProcess === true,
    selfProtocolId:
      typeof source.selfProtocolId === 'string' && source.selfProtocolId !== '' ? source.selfProtocolId : null,
  }
}

/**
 * 状态归一化：只接受 GET /status 的裸对象。会话映射里形状不对的项直接丢弃而不是让整页报错；
 * 可选字段缺省时保持缺省——POST /reconnect 只回引擎状态，靠 mergeEngineStatus 保住映射表。
 */
export function normalizeStatus(raw: unknown): BridgeStatus {
  const source = isRecord(raw) ? raw : {}
  const status: BridgeStatus = { state: asStateName(source.state) ?? 'idle' }
  if (source.sessions !== undefined) status.sessions = normalizeSessions(source.sessions)
  if (typeof source.since === 'number') status.since = source.since
  if (typeof source.error === 'string' && source.error !== '') status.error = source.error
  if (typeof source.notice === 'string' && source.notice !== '') status.notice = source.notice
  if (typeof source.lastSequence === 'number') status.lastSequence = source.lastSequence
  if (isRecord(source.settings)) status.settings = normalizeSettings(source.settings)
  return status
}

/**
 * 把只有引擎字段的响应（POST /reconnect）合并到现有状态：会话映射与公开设置不属于引擎状态，
 * 必须从旧状态保留，否则重连一次映射表就被清空。引擎缺省的 error/notice 视为已清除。
 * 没有旧状态可合并、或两边都没有映射表时，把 `sessions` 标成 `null`（未知）而不是留空，
 * 否则 UI 会把「还没拉过映射表」误当成「确实没有映射」。
 */
export function mergeEngineStatus(previous: BridgeStatus | null, engine: BridgeStatus): BridgeStatus {
  if (previous === null) {
    return engine.sessions === undefined ? { ...engine, sessions: null } : engine
  }
  const next: BridgeStatus = { state: engine.state }
  if (engine.since !== undefined) next.since = engine.since
  if (engine.error !== undefined) next.error = engine.error
  if (engine.notice !== undefined) next.notice = engine.notice
  if (engine.lastSequence !== undefined) next.lastSequence = engine.lastSequence
  if (engine.sessions !== undefined) next.sessions = engine.sessions
  else if (previous.sessions !== undefined) next.sessions = previous.sessions
  else next.sessions = null
  if (engine.settings !== undefined) next.settings = engine.settings
  else if (previous.settings !== undefined) next.settings = previous.settings
  return next
}

/** 工作区列表归一化：只接受 `{ workspaces: [...] }`，丢弃缺 id/path 的项。 */
export function normalizeWorkspaces(raw: unknown): WorkspaceEntry[] {
  const outer = isRecord(raw) ? raw : {}
  const list = Array.isArray(outer.workspaces) ? outer.workspaces : []
  const entries: WorkspaceEntry[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || item.id === '') continue
    if (typeof item.path !== 'string' || item.path === '') continue
    entries.push(
      typeof item.title === 'string'
        ? { id: item.id, title: item.title, path: item.path }
        : { id: item.id, path: item.path },
    )
  }
  return entries
}

/** 单个 loopback 请求的时限；超时后中断 fetch，避免 busy 状态永远解不开。 */
const REQUEST_TIMEOUT_MS = 15_000

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
      throw new BridgeHttpError(response.status, message)
    }
    return payload
  } catch (error) {
    // 只有本函数自己的超时中断才改写成可读错误；其余网络异常原样上抛。
    if (controller.signal.aborted) throw new BridgeTimeoutError(REQUEST_TIMEOUT_MS)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 读取公开设置（令牌不会出现在响应里）。 */
export async function fetchSettings(): Promise<PublicSettings> {
  return normalizeSettings(await requestJson('/settings'))
}

/** 提交设置补丁；宿主按白名单合并，空令牌表示不改。 */
export async function patchSettings(patch: Partial<SettingsPatch>): Promise<PublicSettings> {
  return normalizeSettings(
    await requestJson('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

/** 请求宿主重连网关；未配置时宿主回 409 not-configured。 */
export async function reconnect(): Promise<ReconnectResult> {
  const raw = await requestJson('/reconnect', { method: 'POST' })
  const record = isRecord(raw) ? raw : {}
  return {
    ok: record.ok === true,
    status: normalizeStatus(record.status),
  }
}

/** 读取连接状态与会话映射。 */
export async function fetchStatus(): Promise<BridgeStatus> {
  return normalizeStatus(await requestJson('/status'))
}

/** 读取可绑定的工作区列表。 */
export async function fetchWorkspaces(): Promise<WorkspaceEntry[]> {
  return normalizeWorkspaces(await requestJson('/workspaces'))
}

/** 解除某个来源键的会话映射（DELETE /sessions/:key）；返回宿主是否真的删掉了映射。 */
export async function deleteSession(key: string): Promise<{ removed: boolean }> {
  const raw = await requestJson(`/sessions/${encodeURIComponent(key)}`, { method: 'DELETE' })
  return { removed: isRecord(raw) && raw.removed === true }
}

/** 设置页表单状态：令牌单独一栏，空串表示不修改。 */
export interface SettingsForm {
  enabled: boolean
  gatewayUrl: string
  token: string
  workspaceId: string
  workspacePath: string
  sessionMode: SessionMode
  showProcess: boolean
  selfProtocolId: string
}

/** 提交给宿主 PATCH 的补丁；空令牌时省略 token 键。 */
export interface SettingsPatch {
  enabled: boolean
  gatewayUrl: string
  workspaceId: string | null
  workspacePath: string | null
  sessionMode: SessionMode
  showProcess: boolean
  selfProtocolId: string | null
  token?: string
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 公开设置 → 表单。令牌永远留空，避免把已存令牌回显到页面。 */
export function toForm(settings: PublicSettings): SettingsForm {
  return {
    enabled: settings.enabled,
    gatewayUrl: settings.gatewayUrl,
    token: '',
    workspaceId: settings.workspaceId ?? '',
    workspacePath: settings.workspacePath ?? '',
    sessionMode: settings.sessionMode,
    showProcess: settings.showProcess,
    selfProtocolId: settings.selfProtocolId ?? '',
  }
}

/** 表单 → PATCH 补丁：空令牌不提交，空的工作区/路径/身份转 null。 */
export function toPatch(form: SettingsForm): SettingsPatch {
  const patch: SettingsPatch = {
    enabled: form.enabled,
    gatewayUrl: form.gatewayUrl.trim(),
    workspaceId: blankToNull(form.workspaceId),
    workspacePath: blankToNull(form.workspacePath),
    sessionMode: form.sessionMode,
    showProcess: form.showProcess,
    selfProtocolId: blankToNull(form.selfProtocolId),
  }
  const token = form.token.trim()
  if (token !== '') patch.token = token
  return patch
}

/**
 * 保存成功文案：宿主只在 enabled / gatewayUrl / token 变化时重建网关（src/index.ts），
 * 其余设置保存即生效。文案必须与宿主行为一致，不能一律说「已重连」。
 * 客户端拿不到已存令牌（只有 tokenSet），所以只能按「输入了新令牌」给出弱化提示，
 * 不能断言宿主一定会重连（重输相同令牌时宿主按值比较不会重启）。
 */
export function saveSuccessText(previous: SettingsForm, next: SettingsForm): string {
  const restarts =
    previous.enabled !== next.enabled ||
    previous.gatewayUrl.trim() !== next.gatewayUrl.trim()
  if (restarts) return '已保存，网关已按新配置重连。'
  if (next.token.trim() !== '') return '已保存（令牌有变更时会重新连接）。'
  return '已保存。'
}

const STATUS_TEXT: Record<BridgeStateName, string> = {
  idle: '已断开',
  connecting: '连接中',
  connected: '已连接',
  error: '连接错误',
}

/** 连接状态 → 中文文案；未知状态保留原值便于排查。 */
export function formatStatus(status: { state?: string } | null | undefined): string {
  const state = status?.state
  if (state === undefined || state === '') return '未知'
  if (state === 'idle' || state === 'connecting' || state === 'connected' || state === 'error') {
    return STATUS_TEXT[state]
  }
  return `未知（${state}）`
}

export type StatusTone = 'success' | 'warn' | 'danger' | 'neutral'

/** 连接状态 → 徽标色调。 */
export function statusTone(state: string | null | undefined): StatusTone {
  if (state === 'connected') return 'success'
  if (state === 'connecting') return 'warn'
  if (state === 'error') return 'danger'
  return 'neutral'
}

const ERROR_TEXT: Record<string, string> = {
  'not-configured': '尚未配置：请先填写网关地址与令牌并启用',
  forbidden: '仅允许本机访问',
  internal: '宿主内部错误，请查看 DSH 日志',
  'invalid-json': '请求体格式错误',
  'payload-too-large': '请求体过大',
  'missing-key': '缺少会话键',
  'invalid-key': '会话键非法',
  'method-not-allowed': '方法不被允许',
}

/** 任意异常 → 页面可读的错误文案。 */
export function formatError(error: unknown): string {
  if (error instanceof BridgeTimeoutError) return error.message
  if (error instanceof BridgeHttpError) {
    return ERROR_TEXT[error.message] ?? `请求失败（${error.status}）：${error.message}`
  }
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}

// ---------------------------------------------------------------------------
// 样式：只用宿主主题 token，缺值时回落到内置色。不写全局 CSS、不碰 document。
// ---------------------------------------------------------------------------

const C = {
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  muted: 'var(--dsw-alias-label-secondary, #5f6673)',
  border: 'var(--dsw-alias-border-l2, #e5e7eb)',
  bg: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  bgSoft: 'var(--dsw-alias-bg-layer-3, #f6f7f9)',
  brand: 'var(--dsw-alias-brand-primary, #4c6ef5)',
  // 状态色只用宿主真实存在的 state-* token；底色统一用层色，避免深色主题下浅色块。
  danger: 'var(--dsw-alias-state-error-primary, #b42318)',
  dangerBg: 'var(--dsw-alias-bg-layer-3, #fef3f2)',
  dangerBorder: 'var(--dsw-alias-state-error-primary, #fecdca)',
  success: 'var(--dsw-alias-state-success-primary, #1d7a4a)',
  successBg: 'var(--dsw-alias-bg-layer-3, #ecfdf3)',
  successBorder: 'var(--dsw-alias-state-success-primary, #abefc6)',
  warn: 'var(--dsw-alias-state-warn-primary, #b54708)',
  warnBg: 'var(--dsw-alias-bg-layer-3, #fffaeb)',
  warnBorder: 'var(--dsw-alias-state-warn-primary, #fedf89)',
} as const

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '4px 2px 24px',
    color: C.text,
    fontSize: 14,
    lineHeight: 1.5,
  },
  title: { margin: 0, fontSize: 18, fontWeight: 600, color: C.text },
  subtitle: { margin: 0, color: C.muted },
  warning: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: `1px solid ${C.warnBorder}`,
    background: C.warnBg,
    color: C.warn,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
  },
  errorBox: {
    border: `1px solid ${C.dangerBorder}`,
    background: C.dangerBg,
    color: C.danger,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
  noticeBox: {
    border: `1px solid ${C.successBorder}`,
    background: C.successBg,
    color: C.success,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
  // 操作部分成功（如保存成功但状态刷新失败）：既不能说成功（绿），也不该报成失败（红）。
  warnBox: {
    border: `1px solid ${C.warnBorder}`,
    background: C.warnBg,
    color: C.warn,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
  statusError: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: `1px solid ${C.dangerBorder}`,
    background: C.dangerBg,
    color: C.danger,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
  statusNotice: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: `1px solid ${C.warnBorder}`,
    background: C.warnBg,
    color: C.warn,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 13,
    overflowWrap: 'anywhere',
  },
  statusNoticeLabel: { fontWeight: 600, fontSize: 12 },
  loadBox: { display: 'flex', flexDirection: 'column', gap: 10 },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: '14px 16px',
    background: C.bg,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontWeight: 600, color: C.text },
  hint: { color: C.muted, fontSize: 12, margin: 0 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.text,
    font: 'inherit',
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  fieldset: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    margin: 0,
    padding: 0,
    border: 'none',
  },
  radioRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '8px 10px',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    background: C.bgSoft,
    cursor: 'pointer',
  },
  radioText: { display: 'flex', flexDirection: 'column', gap: 2 },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  dirty: { color: C.warn, fontSize: 12 },
  button: {
    padding: '6px 12px',
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.text,
    font: 'inherit',
    cursor: 'pointer',
  },
  buttonPrimary: {
    background: C.brand,
    borderColor: C.brand,
    color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  },
  buttonDanger: { background: C.dangerBg, borderColor: C.dangerBorder, color: C.danger },
  buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
  statusBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: '14px 16px',
    background: C.bg,
  },
  statusHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  statusTitle: { fontWeight: 600 },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 12,
    border: '1px solid transparent',
  },
  pillSuccess: { background: C.successBg, borderColor: C.successBorder, color: C.success },
  pillWarn: { background: C.warnBg, borderColor: C.warnBorder, color: C.warn },
  pillDanger: { background: C.dangerBg, borderColor: C.dangerBorder, color: C.danger },
  pillNeutral: { background: C.bgSoft, borderColor: C.border, color: C.muted },
  statusGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
  statusLine: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  statusLabel: { color: C.muted, fontSize: 12 },
  statusValue: { color: C.text, overflowWrap: 'anywhere' },
  sessionsBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: '14px 16px',
    background: C.bg,
  },
  table: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border}`, borderRadius: 8 },
  tableHead: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 1.4fr) minmax(120px, 1.4fr) minmax(140px, 1fr) auto',
    gap: 8,
    padding: '8px 10px',
    background: C.bgSoft,
    color: C.muted,
    fontSize: 12,
  },
  tableRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 1.4fr) minmax(120px, 1.4fr) minmax(140px, 1fr) auto',
    gap: 8,
    alignItems: 'center',
    padding: '8px 10px',
    borderTop: `1px solid ${C.border}`,
  },
  cell: { minWidth: 0, overflowWrap: 'anywhere' },
}

function buttonStyle(tone: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  if (tone === 'primary') return styles.buttonPrimary
  if (tone === 'danger') return styles.buttonDanger
  return {}
}

function pillStyle(tone: StatusTone): React.CSSProperties {
  if (tone === 'success') return styles.pillSuccess
  if (tone === 'warn') return styles.pillWarn
  if (tone === 'danger') return styles.pillDanger
  return styles.pillNeutral
}

const h = React.createElement

interface FieldProps {
  label: string
  hint?: string
  children?: React.ReactNode
}

function Field(props: FieldProps): React.ReactElement {
  return h(
    'label',
    { style: styles.field },
    h('span', { style: styles.label }, props.label),
    props.children,
    props.hint === undefined ? null : h('span', { style: styles.hint }, props.hint),
  )
}

interface ButtonProps {
  children?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'primary' | 'secondary' | 'danger'
}

function Button(props: ButtonProps): React.ReactElement {
  const tone = props.tone ?? 'secondary'
  return h(
    'button',
    {
      type: 'button',
      style: props.disabled === true ? { ...styles.button, ...buttonStyle(tone), ...styles.buttonDisabled } : { ...styles.button, ...buttonStyle(tone) },
      disabled: props.disabled === true,
      onClick: props.onClick,
    },
    props.children,
  )
}

function Pill(props: { text: string; tone: StatusTone }): React.ReactElement {
  return h('span', { style: { ...styles.pill, ...pillStyle(props.tone) } }, props.text)
}

function StatusLine(props: { label: string; value: string }): React.ReactElement {
  return h(
    'div',
    { style: styles.statusLine },
    h('span', { style: styles.statusLabel }, props.label),
    h('span', { style: styles.statusValue }, props.value),
  )
}

/** 状态区显著横幅：error 用 danger 色，notice 用 warn 色，两者可以同时出现。 */
function StatusBanner(props: {
  label: string
  text: string
  tone: 'danger' | 'warn'
}): React.ReactElement {
  return h(
    'div',
    { style: props.tone === 'danger' ? styles.statusError : styles.statusNotice },
    h('span', { style: styles.statusNoticeLabel }, props.label),
    h('span', null, props.text),
  )
}

function formsEqual(a: SettingsForm, b: SettingsForm): boolean {
  return (
    a.enabled === b.enabled &&
    a.gatewayUrl === b.gatewayUrl &&
    a.token === b.token &&
    a.workspaceId === b.workspaceId &&
    a.workspacePath === b.workspacePath &&
    a.sessionMode === b.sessionMode &&
    a.showProcess === b.showProcess &&
    a.selfProtocolId === b.selfProtocolId
  )
}

/** settings.section 的页面组件；副作用只发生在挂载后的 effect 与按钮回调里。 */
function Section(): React.ReactElement {
  const [form, setForm] = React.useState<SettingsForm | null>(null)
  const [saved, setSaved] = React.useState<SettingsForm | null>(null)
  const [tokenSet, setTokenSet] = React.useState(false)
  const [status, setStatus] = React.useState<BridgeStatus | null>(null)
  const [workspaces, setWorkspaces] = React.useState<WorkspaceEntry[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [warning, setWarning] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(null)
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  // 三份数据相互独立：只有 settings 失败才阻断表单，工作区/状态各自降级并单独提示。
  React.useEffect(() => {
    let cancelled = false
    setBusy('load')
    setLoadError(null)
    setWorkspaceError(null)
    setStatusError(null)
    Promise.allSettled([fetchSettings(), fetchWorkspaces(), fetchStatus()]).then((results) => {
      if (cancelled) return
      const [settingsResult, workspacesResult, statusResult] = results
      if (settingsResult.status === 'fulfilled') {
        const nextForm = toForm(settingsResult.value)
        setForm(nextForm)
        setSaved(nextForm)
        setTokenSet(settingsResult.value.tokenSet)
      } else {
        setLoadError(formatError(settingsResult.reason))
      }
      if (workspacesResult.status === 'fulfilled') {
        setWorkspaces(workspacesResult.value)
      } else {
        setWorkspaces([])
        setWorkspaceError('工作区列表读取失败，可直接填路径。')
      }
      if (statusResult.status === 'fulfilled') {
        setStatus(statusResult.value)
      } else {
        setStatusError(formatError(statusResult.reason))
      }
      setBusy(null)
    })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const update = (patch: Partial<SettingsForm>): void => {
    setForm((current) => (current === null ? null : { ...current, ...patch }))
  }

  const save = async (): Promise<void> => {
    if (form === null || saved === null) return
    const previous = saved
    const nextFormToSend = form
    setBusy('save')
    setError(null)
    setNotice(null)
    setWarning(null)
    try {
      const next = await patchSettings(toPatch(nextFormToSend))
      const nextForm = toForm(next)
      setForm(nextForm)
      setSaved(nextForm)
      setTokenSet(next.tokenSet)
      setNotice(saveSuccessText(previous, nextFormToSend))
      // PATCH 已经成功；状态刷新失败只单独提示，不能翻回「保存失败」。
      try {
        setStatus(await fetchStatus())
        setStatusError(null)
      } catch (reason) {
        // 旧的 statusError 属于上一次刷新，清掉以免和本次提示重复；本次失败用 warn 色框说明。
        setStatusError(null)
        setWarning(`已保存，但状态刷新失败：${formatError(reason)}`)
      }
    } catch (reason) {
      setError(formatError(reason))
    } finally {
      setBusy(null)
    }
  }

  const refreshStatus = async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    setNotice(null)
    setWarning(null)
    try {
      setStatus(await fetchStatus())
      setStatusError(null)
    } catch (reason) {
      setStatusError(formatError(reason))
    } finally {
      setBusy(null)
    }
  }

  const reconnectNow = async (): Promise<void> => {
    setBusy('reconnect')
    setError(null)
    setNotice(null)
    setWarning(null)
    try {
      const result = await reconnect()
      // 重连响应只有引擎状态：合并而不是整包覆盖，否则会话映射表会被清空。
      setStatus((previous) => mergeEngineStatus(previous, result.status))
      setStatusError(null)
      setNotice(result.ok ? '已请求重新连接。' : '重新连接未成功。')
    } catch (reason) {
      setError(formatError(reason))
    } finally {
      setBusy(null)
    }
  }

  const removeSession = async (key: string): Promise<void> => {
    setBusy(`session:${key}`)
    setError(null)
    setNotice(null)
    setWarning(null)
    try {
      const result = await deleteSession(key)
      if (result.removed) {
        setStatus((previous) => {
          if (previous === null || previous.sessions === undefined || previous.sessions === null) {
            return previous
          }
          const sessions = { ...previous.sessions }
          delete sessions[key]
          return { ...previous, sessions }
        })
      }
      setNotice(result.removed ? `已解除映射：${key}` : `这条映射已不存在：${key}`)
    } catch (reason) {
      setError(formatError(reason))
    } finally {
      setBusy(null)
    }
  }

  const dirty = form !== null && saved !== null && !formsEqual(form, saved)
  // sessions 为 null/缺省表示「映射表未知」（如刚重连、还没拉过状态），不能渲染成「暂无映射」。
  const sessions = status?.sessions ?? null
  const sessionsUnknown = sessions === null
  const sessionEntries: Array<[string, SessionEntry]> = sessions === null ? [] : Object.entries(sessions)
  const disabled = busy !== null
  const savedEnabled = saved?.enabled ?? status?.settings?.enabled
  const enabledPending = dirty && form !== null && saved !== null && form.enabled !== saved.enabled
  const enabledText =
    savedEnabled === undefined ? '—' : savedEnabled ? '已启用' : '已停用'
  const workspaceKnown =
    form === null || form.workspaceId === '' || workspaces.some((workspace) => workspace.id === form.workspaceId)

  return h(
    'div',
    { style: styles.section },
    h('h2', { style: styles.title }, 'Lanpost IM 连接'),
    h('p', { style: styles.subtitle }, '通过 lanpost 网关让私聊消息驱动本机 DSH 会话，并把结果回发到原会话。'),
    h(
      'div',
      { style: styles.warning },
      h('strong', null, '安全提示'),
      h('span', null, '私聊对所有联系人放行：任何能私聊到本机的人都可以驱动本机 agent。'),
    ),
    error === null ? null : h('div', { style: styles.errorBox }, error),
    warning === null ? null : h('div', { style: styles.warnBox }, warning),
    notice === null ? null : h('div', { style: styles.noticeBox }, notice),
    form === null
      ? h(
          'div',
          { style: styles.loadBox },
          loadError === null
            ? h('p', { style: styles.hint }, '正在读取配置…')
            : h('div', { style: styles.errorBox }, `读取设置失败：${loadError}`),
          loadError === null
            ? null
            : h(
                'div',
                { style: styles.actions },
                h(
                  Button,
                  { disabled, onClick: () => setReloadToken((token) => token + 1) },
                  busy === 'load' ? '重试中…' : '重试',
                ),
              ),
        )
      : h(
          'div',
          { style: styles.form },
          h(
            'label',
            { style: styles.checkRow },
            h('input', {
              type: 'checkbox',
              checked: form.enabled,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => update({ enabled: event.target.checked }),
            }),
            h('span', { style: styles.label }, '启用 lanpost 网关'),
          ),
          h('p', { style: styles.hint }, '启用后按下面的配置连接 lanpost；停用只会断开网关，不会删除配置。'),
          h(
            Field,
            { label: '网关地址', hint: 'lanpost 网关的 WebSocket 地址。' },
            h('input', {
              type: 'text',
              value: form.gatewayUrl,
              placeholder: 'wss://127.0.0.1:8443/ws/dsh',
              spellCheck: false,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => update({ gatewayUrl: event.target.value }),
              style: styles.input,
            }),
          ),
          h(
            Field,
            {
              label: '网关令牌',
              hint: tokenSet ? '已设置。留空表示不修改已存令牌。' : '尚未设置。',
            },
            h('input', {
              type: 'password',
              value: form.token,
              placeholder: tokenSet ? '已设置（留空不修改）' : '未设置',
              autoComplete: 'new-password',
              spellCheck: false,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => update({ token: event.target.value }),
              style: styles.input,
            }),
          ),
          h(
            Field,
            {
              label: '工作区',
              hint:
                workspaceError === null
                  ? '留空表示不绑定，新建会话使用 DSH 的默认工作区。'
                  : `${workspaceError}留空表示不绑定。`,
            },
            h(
              'select',
              {
                value: form.workspaceId,
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                  update({ workspaceId: event.target.value }),
                style: styles.input,
              },
              h('option', { value: '' }, '不绑定（使用默认工作区）'),
              workspaceKnown
                ? null
                : h(
                    'option',
                    { key: form.workspaceId, value: form.workspaceId },
                    `${form.workspaceId}（当前值，不在工作区列表中）`,
                  ),
              ...workspaces.map((workspace) =>
                h(
                  'option',
                  { key: workspace.id, value: workspace.id },
                  workspace.title === undefined ? workspace.path : `${workspace.title}（${workspace.path}）`,
                ),
              ),
            ),
          ),
          h(
            Field,
            { label: '自定义工作区路径（可选）', hint: '直接填写工作区目录；与下拉选择同时填写时以宿主实现为准。' },
            h('input', {
              type: 'text',
              value: form.workspacePath,
              placeholder: 'D:\\work\\project（可留空）',
              spellCheck: false,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => update({ workspacePath: event.target.value }),
              style: styles.input,
            }),
          ),
          h(
            'fieldset',
            { style: styles.fieldset },
            h('legend', { style: styles.label }, '会话模式'),
            h(
              'label',
              { style: styles.radioRow },
              h('input', {
                type: 'radio',
                name: 'lanpost-session-mode',
                checked: form.sessionMode === 'continue',
                onChange: () => update({ sessionMode: 'continue' }),
              }),
              h(
                'span',
                { style: styles.radioText },
                h('span', null, '继续同一会话'),
                h('span', { style: styles.hint }, '每个来源复用一条映射会话，上下文连续。'),
              ),
            ),
            h(
              'label',
              { style: styles.radioRow },
              h('input', {
                type: 'radio',
                name: 'lanpost-session-mode',
                checked: form.sessionMode === 'new',
                onChange: () => update({ sessionMode: 'new' }),
              }),
              h(
                'span',
                { style: styles.radioText },
                h('span', null, '每条消息新建会话'),
                h('span', { style: styles.hint }, '每条消息单开一条会话，来源之间互不串上下文。'),
              ),
            ),
          ),
          h(
            'label',
            { style: styles.checkRow },
            h('input', {
              type: 'checkbox',
              checked: form.showProcess,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                update({ showProcess: event.target.checked }),
            }),
            h('span', { style: styles.label }, '回复中附上思考与工具摘要'),
          ),
          h(
            Field,
            { label: '自己的 protocol_id（可选）', hint: '用于识别本机发出的消息；留空由宿主自动判断。' },
            h('input', {
              type: 'text',
              value: form.selfProtocolId,
              placeholder: '可留空',
              spellCheck: false,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                update({ selfProtocolId: event.target.value }),
              style: styles.input,
            }),
          ),
          h(
            'div',
            { style: styles.actions },
            h(
              Button,
              { tone: 'primary', disabled: !dirty || disabled, onClick: () => void save() },
              busy === 'save' ? '保存中…' : '保存',
            ),
            dirty ? h('span', { style: styles.dirty }, '有未保存的修改') : null,
          ),
        ),
    h(
      'div',
      { style: styles.statusBox },
      h(
        'div',
        { style: styles.statusHeader },
        h('span', { style: styles.statusTitle }, '连接状态'),
        h(Pill, { text: formatStatus(status), tone: statusTone(status?.state) }),
      ),
      status === null || status.error === undefined
        ? null
        : h(StatusBanner, { label: '网关错误', text: status.error, tone: 'danger' }),
      status === null || status.notice === undefined
        ? null
        : h(StatusBanner, { label: '网关提示', text: status.notice, tone: 'warn' }),
      statusError === null ? null : h('p', { style: styles.hint }, `状态读取失败：${statusError}`),
      h(
        'div',
        { style: styles.statusGrid },
        h(StatusLine, { label: '最近错误', value: status?.error ?? '无' }),
        h(StatusLine, {
          label: '游标（lastSequence）',
          value: status?.lastSequence === undefined ? '—' : String(status.lastSequence),
        }),
        h(StatusLine, { label: '会话数', value: sessionsUnknown ? '—' : String(sessionEntries.length) }),
        h(StatusLine, {
          label: '启用状态',
          value: enabledPending ? `${enabledText}（有未保存的修改）` : enabledText,
        }),
      ),
      h(
        'div',
        { style: styles.actions },
        h(Button, { disabled, onClick: () => void refreshStatus() }, busy === 'refresh' ? '刷新中…' : '刷新状态'),
        h(Button, { disabled, onClick: () => void reconnectNow() }, busy === 'reconnect' ? '连接中…' : '重新连接'),
      ),
    ),
    h(
      'div',
      { style: styles.sessionsBox },
      h(
        'div',
        { style: styles.statusHeader },
        h('span', { style: styles.statusTitle }, `会话映射（${sessionsUnknown ? '未知' : sessionEntries.length}）`),
      ),
      sessionEntries.length === 0
        ? h(
            'p',
            { style: styles.hint },
            sessionsUnknown ? '映射表未知，请刷新状态。' : '暂无映射。收到并处理消息后会自动建立。',
          )
        : h(
            'div',
            { style: styles.table },
            h(
              'div',
              { style: styles.tableHead },
              h('span', null, '来源键'),
              h('span', null, 'sessionId'),
              h('span', null, '更新时间'),
              h('span', null, '操作'),
            ),
            ...sessionEntries.map(([key, entry]) =>
              h(
                'div',
                { key, style: styles.tableRow },
                h('span', { style: styles.cell, title: key }, key),
                h('span', { style: styles.cell, title: entry.sessionId }, entry.sessionId),
                h('span', { style: styles.cell }, entry.updatedAt === '' ? '—' : entry.updatedAt),
                h(
                  'span',
                  null,
                  h(
                    Button,
                    {
                      tone: 'danger',
                      disabled,
                      onClick: () => void removeSession(key),
                    },
                    busy === `session:${key}` ? '解除中…' : '解除',
                  ),
                ),
              ),
            ),
          ),
    ),
  )
}

interface SectionSlotOptions {
  name: 'settings.section'
  id: string
  order: number
  label: () => string
}

interface SlotsService {
  inject(name: 'settings.section', contribute: () => () => void): () => void
  register(options: SectionSlotOptions, component: React.ComponentType): () => void
}

/** 客户端插件可用的最小 ctx 面；其余能力由本文件的 API 层直接走 loopback 路由。 */
interface ClientContext {
  slots: SlotsService
}

/** 等待 slot 服务就绪后再注册；slot 注册自身由宿主 fiber 记账。 */
export const inject = ['slots']

/**
 * 注册设置页分区。`ctx.slots.inject()` 直接交给 slot 服务记账（与 dsh-n8n-plugin 一致），
 * 页面卸载时由 slot 回卷本分区，无需再套一层 ctx.effect。
 */
export const apply = (ctx: unknown): void => {
  const client = ctx as ClientContext
  client.slots.inject('settings.section', () =>
    client.slots.register(
      { name: 'settings.section', id: 'lanpost-bridge', order: 120, label: () => 'lanpost 连接' },
      Section,
    ),
  )
}

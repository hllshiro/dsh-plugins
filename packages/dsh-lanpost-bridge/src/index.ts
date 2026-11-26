// DSH ↔ lanpost-im 适配插件的宿主半：装配 ws 网关、入站编排、三个 agent 工具与五条 loopback 路由。
// 浏览器半（./client.ts）只渲染设置页，两端通过 routes.ts 约定的 HTTP 形状通信。
// 本文件不碰协议细节、不写持久化逻辑，只负责「谁在什么时候被创建 / 注册 / 回卷」。
import type { Context } from '@deepseek-ai/cordis'
import { dirname } from 'node:path'
import { InboundBridge } from './bridge.ts'
import type { ReplyTarget } from './bridge.ts'
import { LanpostGateway } from './gateway.ts'
import {
  loggerOf,
  onSessionEvent,
  sessionControllerOf,
  systemPromptOf,
  toolsOf,
  webServerOf,
  workspaceRegistryOf,
  writeAudit,
} from './harness.ts'
import { createRoutes } from './routes.ts'
import type { RouteDeps } from './routes.ts'
import { loadState, mergeSettings, publicSettings, saveState, statePath } from './store.ts'
import type { BridgeState } from './store.ts'
import { createTools } from './tools.ts'

export const name = 'our-dsh-lanpost-bridge'

/** 宿主服务缺一个，插件就停在 inactive；这里把装配用到的全部列清。 */
export const inject = [
  'tools',
  'webServer',
  'sessionController',
  'workspaceRegistry',
  'systemPrompt',
]

/**
 * 模型可见的提示段：只讲「什么时候用哪个工具」。
 * 静态常量，不拼运行时状态，避免每轮提示词变化导致 KV Cache 失效。
 */
const LANPOST_PROMPT = `当用户要求通过 lanpost（局域网 IM）发消息、找联系人或查看桥接状态时，先调用 lanpost_find_contact 拿到对方的 protocol_id，再用 lanpost_send_message 发送；要确认桥接是否启用、网关连接状态或会话映射时调用 lanpost_bridge_status。消息会原样投递到对端聊天，发送前确认正文完整。工具返回 ok=false 时，把 error 告知用户并按 code 排查，不要重复重试。`

/**
 * 装配插件。所有注册都经 `ctx.effect()` 记账，卸载时按 LIFO 回卷；
 * 网关的启停只由 `enabled` / `gatewayUrl` / `token` 决定，其余设置只更新内存状态。
 */
export function apply(ctx: Context): void {
  const log = loggerOf(ctx)
  // 状态与审计共用同一个 `$DSH_HOME`：从状态文件路径反推，避免两套环境变量解析。
  const home = dirname(statePath())
  let state: BridgeState = loadState(home)
  const update = (mutate: (state: BridgeState) => void): void => {
    mutate(state)
    saveState(state, home)
  }
  const audit = (kind: string, detail: Record<string, unknown>): void => {
    writeAudit(home, kind, detail)
  }

  let gateway: LanpostGateway | undefined
  /** 网关未运行时 `status().since` 的基准；有网关时以网关自己的时间为准。 */
  let idleSince = Date.now()

  /** 回发一条消息；网关不在（未启用/已停用）时抛错，由 bridge 的错误分支回复。 */
  const send = async (
    target: ReplyTarget,
    text: string,
  ): Promise<{ message_id: string; delivery_status: string }> => {
    const current = gateway
    if (!current) throw new Error('lanpost 网关未连接')
    const result =
      target.kind === 'user'
        ? await current.sendUser(target.protocolId, text)
        : await current.sendGroup(target.groupId, text)
    return { message_id: result.message_id, delivery_status: result.delivery_status ?? '' }
  }

  const bridge = new InboundBridge({
    state: () => state,
    update,
    sessions: {
      create: (request) => sessionControllerOf(ctx).create(request),
      prompt: (request, signal) => sessionControllerOf(ctx).prompt(request, signal),
      rename: (request) => sessionControllerOf(ctx).rename(request),
    },
    send,
    onSessionEvent: (handler) =>
      onSessionEvent(ctx, (session, event) => handler(session.id, event)),
    log: (message) => log.info(message),
    audit,
  })

  function stopGateway(): void {
    const current = gateway
    if (!current) return
    current.stop()
    gateway = undefined
    idleSince = Date.now()
    log.info('lanpost-bridge: gateway stopped')
  }

  /** 先停后启：设置变化时重建客户端，游标沿用已持久化的 `lastSequence`。 */
  function startGateway(): void {
    stopGateway()
    if (!state.enabled || state.token === '' || state.gatewayUrl.trim() === '') {
      // 未启用/未配置不是错误：保持 idle，等设置页保存或重连接口再启动。
      log.info('lanpost-bridge: gateway skipped (disabled or unconfigured)')
      return
    }
    const next = new LanpostGateway({
      url: state.gatewayUrl,
      token: state.token,
      lastSequence: state.lastSequence,
      events: {
        // `handleMessage` 在去重/映射/`prompt` 被接受后即返回，ACK 不等整轮结束。
        onMessage: (message) => bridge.handleMessage(message),
        onDelivery: (status) => bridge.handleDelivery(status),
        onAck: (sequence) => {
          update((current) => {
            current.lastSequence = sequence
          })
        },
      },
      // 网关日志可能带事件细节；令牌绝不进日志，也不进审计。
      log: (message) => log.info(`lanpost-bridge: ${message}`),
    })
    gateway = next
    log.info(`lanpost-bridge: gateway started (${state.gatewayUrl})`)
    next.start()
  }

  const status = (): {
    state: string
    since: number
    error?: string
    notice?: string
    lastSequence: number
  } => {
    const current = gateway
    const base = current ? current.status() : { state: 'idle', since: idleSince }
    return { ...base, lastSequence: state.lastSequence }
  }

  const routes: RouteDeps = {
    state: () => state,
    patch: (patch) => {
      const next = mergeSettings(state, patch)
      // 只有影响连接本身的字段才重建网关；其余设置保存即生效，不打断现有连接。
      const restart =
        next.enabled !== state.enabled ||
        next.gatewayUrl !== state.gatewayUrl ||
        next.token !== state.token
      state = next
      saveState(state, home)
      if (restart) startGateway()
    },
    reconnect: () => {
      startGateway()
    },
    status,
    workspaces: () => workspaceRegistryOf(ctx).list(),
    clearSession: (key) => {
      update((current) => {
        const sessions = { ...current.sessions }
        delete sessions[key]
        current.sessions = sessions
      })
    },
    audit,
    log: (message) => log.warn(message),
  }

  ctx.effect(() => {
    startGateway()
    return () => {
      stopGateway()
      bridge.dispose()
    }
  })

  for (const tool of createTools({
    gateway: () => gateway,
    settings: () => publicSettings(state),
    state: () => state,
  })) {
    ctx.effect(() => toolsOf(ctx).register(tool))
  }

  // 五条路由一次注册；DSH 对重复的 (kind, path) 会抛错，routes.ts 已保证唯一。
  ctx.effect(() => createRoutes(routes).map((route) => webServerOf(ctx).register(route)))

  // `section()` 自己把注册挂在调用方 context 上，返回值就是 Cordis effect disposer。
  systemPromptOf(ctx).section({ name: 'lanpost-bridge', order: 900, text: LANPOST_PROMPT })

  log.info('lanpost-bridge activated')
}

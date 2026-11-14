/**
 * dsh-wechat-clawbot 插件入口。
 *
 * 这是一行纯 host 插件（没有 Web 客户端部分）：拿到 ctx.agents / ctx.sessions，
 * 把微信 ClawBot 的消息喂给 agent，再把回答发回微信。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentBridge } from './bridge.js'
import { WeChatClawbot } from './clawbot.js'
import { DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, DEFAULT_CHANNEL_VERSION, DEFAULT_SK_ROUTE_TAG } from './ilink.js'
import { createLogger } from './log.js'

export const name = 'wechat-clawbot'

/** 需要 DSH 核心服务：agent 注册表和会话存储。 */
export const inject = ['agents', 'sessions']

const VERSION = '0.1.0'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function normalizeConfig(config = {}) {
  const stateDir = config.stateDir || join(dshHome(), 'storages', 'wechat-clawbot')
  const number = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    // 开关与登录
    enabled: config.enabled !== false,
    autoLogin: config.autoLogin !== false,
    botToken: typeof config.botToken === 'string' ? config.botToken.trim() : '',
    uiPort: number(config.uiPort, 0),

    // 协议参数
    baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    botType: String(config.botType ?? DEFAULT_BOT_TYPE),
    channelVersion: config.channelVersion || DEFAULT_CHANNEL_VERSION,
    skRouteTag: config.skRouteTag ?? DEFAULT_SK_ROUTE_TAG,
    botAgent: config.botAgent || `DSH-WeChat-Clawbot/${VERSION}`,
    pollTimeoutMs: number(config.pollTimeoutMs, 35000),

    // 落盘
    stateDir,
    stateFile: join(stateDir, 'state.json'),

    // 会话
    sessionPrefix: config.sessionPrefix || 'wechat',
    agentPreset: config.agentPreset || '',
    approvalPolicy: config.approvalPolicy === 'ask' ? 'ask' : 'never',
    autoApprove: config.autoApprove !== false,
    permissionPreset: config.permissionPreset || 'danger-full-access',
    turnTimeoutMs: number(config.turnTimeoutMs, 180_000),
    cwd: config.cwd || '',
    provider: config.provider || '',
    model: config.model || '',
    reasoningEffort: config.reasoningEffort || '',

    // 出站
    maxReplyChars: number(config.maxReplyChars, 1800),
    replyLimit: number(config.replyLimit, 6),
    typing: config.typing !== false,
    allowUsers: Array.isArray(config.allowUsers) ? config.allowUsers.map(String) : [],

    logLevel: config.logLevel || 'info',
  }
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const log = createLogger(cfg.logLevel)

  if (!cfg.enabled) {
    log.info('wechat-clawbot 已禁用（config.enabled = false）')
    return
  }

  const resolveModel = () => {
    if (cfg.provider && cfg.model) {
      const selection = { provider: cfg.provider, model: cfg.model }
      if (cfg.reasoningEffort) selection.reasoningEffort = cfg.reasoningEffort
      return selection
    }
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const current = service?.currentSelection?.()
    if (current?.provider && current?.model) return current
    return undefined
  }

  const resolveMeta = () => {
    let cwd = cfg.cwd
    if (!cwd) {
      try {
        cwd = ctx.get?.('fs')?.processPath?.() ?? process.cwd()
      } catch {
        cwd = process.cwd()
      }
    }
    return cwd ? { cwd } : undefined
  }

  let bot
  const bridge = new AgentBridge({
    agents: ctx.agents,
    sessions: ctx.sessions,
    sessionIdFor: (peerId) => bot.sessionIdFor(peerId),
    rotateSessionId: (peerId) => bot.rotateSessionId(peerId),
    subagents: () => (typeof ctx.get === 'function' ? ctx.get('subagents') : undefined),
    agentPresets: () => (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined),
    presetId: cfg.agentPreset || undefined,
    userApproval: () => (typeof ctx.get === 'function' ? ctx.get('userApproval') : undefined),
    permissionPresets: () => (typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined),
    permissionPreset: cfg.permissionPreset,
    turnTimeoutMs: cfg.turnTimeoutMs,
    approvalPolicy: cfg.approvalPolicy,
    autoApprove: cfg.autoApprove,
    resolveModel,
    resolveMeta,
    log,
  })

  bot = new WeChatClawbot({ ctx, config: cfg, log, bridge })

  ctx.effect(
    () => {
      bot.start().catch((error) => log.error('启动失败：', error))
      return () => {
        bot.stop().catch((error) => log.warn('停止失败：', error?.message ?? error))
      }
    },
    'wechat-clawbot: 微信 ClawBot 通道',
  )

  log.info(`已装载（base=${cfg.baseUrl}，状态文件=${cfg.stateFile}）`)
}

/**
 * 微信会话 ↔ DSH Agent 的桥。
 *
 * 每个微信用户对应一个 DSH 会话（session id 由 peer id 派生，可持久化后复用）。
 * 一轮对话 = followup 一条带 id 的 user 消息 → 等 agent 空闲 → 取本轮新增的
 * 最后一条 assistant 文本。不直接操作模型请求，全部交给 dsh-agent / dsh-agent-loop。
 */

import { createHash, randomUUID } from 'node:crypto'

/** 由微信 peer id 派生一个稳定、可读的 session id。 */
export function sessionIdFor(peerId, prefix = 'wechat') {
  const digest = createHash('sha1').update(String(peerId)).digest('hex').slice(0, 12)
  return `${prefix}-${digest}`
}

/** assistant 消息里的文本块拼起来。 */
export function assistantTextOf(message) {
  if (!message || message.role !== 'assistant') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 从后往前找最后一条有文本的 assistant 消息。 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = assistantTextOf(messages[i])
    if (text) return text
  }
  return ''
}

function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

/** 存档不存在（可以放心新建）vs 存档存在但读不出来（要换 id）。 */
function looksLikeMissingSession(message) {
  return /not found|no such|ENOENT|不存在/i.test(message)
}

export class AgentBridge {
  /**
   * @param {object} options
   * @param {object} options.agents   ctx.agents
   * @param {object} options.sessions ctx.sessions
   * @param {(peerId:string)=>string} options.sessionIdFor
   * @param {()=>object|undefined} [options.resolveModel] 返回 { provider, model, reasoningEffort? }
   * @param {()=>object|undefined} [options.resolveMeta]  返回 session meta（如 { cwd }）
   * @param {(peerId:string)=>string} [options.rotateSessionId] 存档不可用时换一个新会话 id
   * @param {object} options.log
   */
  constructor({ agents, sessions, sessionIdFor: idFor, resolveModel, resolveMeta, rotateSessionId, subagents, agentPresets, presetId, userApproval, permissionPresets, permissionPreset, approvalPolicy, autoApprove = true, turnTimeoutMs = 180_000, log }) {
    this.agents = agents
    this.sessions = sessions
    this.idFor = idFor
    this.resolveModel = resolveModel ?? (() => undefined)
    this.resolveMeta = resolveMeta ?? (() => undefined)
    this.rotateSessionId = rotateSessionId
    this.subagents = subagents ?? (() => undefined)
    this.agentPresets = agentPresets ?? (() => undefined)
    this.presetId = presetId
    this.userApproval = userApproval ?? (() => undefined)
    this.permissionPresets = permissionPresets ?? (() => undefined)
    this.permissionPreset = permissionPreset ?? 'danger-full-access'
    this.approvalPolicy = approvalPolicy
    this.autoApprove = autoApprove !== false
    this.turnTimeoutMs = turnTimeoutMs
    this.log = log ?? { info() {}, warn() {}, error() {}, debug() {} }
    /** peerId → AgentHandle（disposer 只属于创建它的调用方） */
    this.handles = new Map()
    /** sessionId → 正在创建中的 Promise，避免并发首条消息各建一个 agent */
    this.pending = new Map()
  }

  /**
   * 微信里没人能点“允许”。三层保险：
   *  1. 有 permissionPresets 时，直接把会话的权限档位切到配置的 preset
   *     （默认 danger-full-access：能写工作区外的文件，也不会去申请沙箱授权）。
   *  2. 给这个 agent 注册 approval/request 应答器，直接 allowed-once。
   *  3. 都没有时退回 never（fail closed，不会挂住）。
   */
  #applyApprovalPolicy(agent) {
    const session = agent.session
    const presets = this.permissionPresets?.()
    if (this.autoApprove && typeof presets?.set === 'function' && session) {
      try {
        presets.set(session, this.permissionPreset)
        this.log.info(`权限档位设为 ${this.permissionPreset}`)
        return
      } catch (error) {
        this.log.warn(`切换权限档位失败（${errorMessage(error)}），退回自动审批`)
      }
    }

    if (this.autoApprove) {
      try {
        agent.ctx?.on?.('approval/request', (request) => {
          this.log.info(`自动放行一次审批：${request?.toolName ?? request?.tool ?? '未知工具'}`)
          return 'allowed-once'
        })
        this.log.debug('已注册自动审批应答器')
      } catch (error) {
        this.log.warn(`注册自动审批失败：${errorMessage(error)}`)
      }
      return
    }

    const approval = this.userApproval?.()
    if (typeof approval?.setPolicy !== 'function') return
    try {
      approval.setPolicy(agent, this.approvalPolicy ?? 'never')
      this.log.debug(`审批策略设为 ${this.approvalPolicy ?? 'never'}`)
    } catch (error) {
      this.log.debug(`设置审批策略失败：${errorMessage(error)}`)
    }
  }

  /**
   * 解析 agent preset（工具/提示词/skill 的组合）——
   * 不挂 preset 的 agent 只有零星几个工具，等于不能用。
   * 与 dsh-api-session-controller 的 composeAgent 保持同一套调用。
   */
  async #composition() {
    const presets = this.agentPresets?.()
    if (typeof presets?.resolve !== 'function' || typeof presets?.mount !== 'function') return {}
    try {
      const resolved = await presets.resolve(this.presetId)
      if (!resolved?.id) return {}
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolved.id)
        },
      }
    } catch (error) {
      this.log.warn(`agent preset 解析失败（${errorMessage(error)}），按默认工具集启动`)
      return {}
    }
  }

  /** 复用内存里活着的 agent，否则 resume 持久化会话，最后才新建。 */
  async ensure(peerId) {
    const wanted = this.idFor(peerId)
    const liveWanted = this.agents.get(wanted)
    if (liveWanted) return { agent: liveWanted, sessionId: wanted }
    if (this.handles.has(peerId)) {
      const handle = this.handles.get(peerId)
      return { agent: handle.agent, sessionId: handle.agent?.session?.id ?? wanted }
    }
    const inflight = this.pending.get(wanted)
    if (inflight) return inflight

    const task = (async () => {
      const agentOptions = this.resolveModel()
      const meta = this.resolveMeta()
      const composition = await this.#composition()
      let sessionId = wanted
      let handle

      try {
        // 注意：resume 的入参名是 resumeSessionId（agent-loop 的约定），不是 sessionId。
        handle = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          ...(composition.setup ? { setup: composition.setup } : {}),
        })
        this.log.info(`已恢复微信会话 ${sessionId}`)
      } catch (resumeError) {
        const message = errorMessage(resumeError)
        this.log.debug(`resume ${sessionId} 失败（${message}）`)

        // resume 可能在报错前已经把会话载入 store，这时不能再 create（会撞 already exists）。
        const live = this.agents.get(sessionId)
        if (live) {
          this.log.info(`复用已载入的微信会话 ${sessionId}`)
          return { agent: live, sessionId }
        }

        // 存档存在但读不出来（格式/校验问题）：换一个会话 id，别让这个用户永远卡住。
        if (!looksLikeMissingSession(message) && this.rotateSessionId) {
          const rotated = this.rotateSessionId(peerId)
          if (rotated && rotated !== sessionId) {
            this.log.warn(`旧会话存档无法恢复（${message}），改用新会话 ${rotated}`)
            sessionId = rotated
          }
        }

        handle = await this.agents.create({
          sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          ...(meta || composition.agentPreset
            ? {
                meta: {
                  ...(meta ?? {}),
                  ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
                },
              }
            : {}),
          ...(composition.setup ? { setup: composition.setup } : {}),
        })
        this.log.info(`已为微信用户新建会话 ${sessionId}`)
      }

      if (handle) this.handles.set(peerId, handle)
      if (handle) this.#applyApprovalPolicy(handle.agent)
      return { agent: handle.agent, sessionId }
    })()

    this.pending.set(wanted, task)
    try {
      return await task
    } finally {
      this.pending.delete(wanted)
    }
  }

  /**
   * 跑一轮对话。
   * @returns {Promise<string>} assistant 的最终文本（可能为空串）
   */
  async runTurn(peerId, text) {
    const { agent, sessionId } = await this.ensure(peerId)
    const session = agent?.session ?? this.sessions.get(sessionId)
    const before = session ? session.deriveMessages().length : 0

    // agent-loop 把回合内的异常吞进 agent/error（驱动边界只负责回到 idle），
    // 这里收一下，避免“没有输出”时丢掉真正的原因。
    const failures = []
    const unsubscribe = agent.ctx?.on?.('agent/error', (payload) => {
      if (payload?.agent && payload.agent !== agent) return
      failures.push(payload?.error ?? payload)
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.log.warn(`会话 ${sessionId}：本轮超过 ${Math.round(this.turnTimeoutMs / 1000)} 秒，打断`)
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        /* ignore */
      }
    }, this.turnTimeoutMs)

    try {
      agent.followup({
        // 必须带 id：持久化回放会校验 user/message 是否有稳定身份。
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      await this.#settle(agent)
    } finally {
      clearTimeout(timer)
      try {
        unsubscribe?.()
      } catch {
        /* ignore */
      }
    }

    if (timedOut) {
      throw new Error(`本轮超过 ${Math.round(this.turnTimeoutMs / 1000)} 秒还没跑完（大概率卡在等审批或工具执行），已经打断`)
    }

    if (!session) return ''
    const messages = session.deriveMessages().slice(before)
    const reply = lastAssistantText(messages)
    this.log.debug(
      `会话 ${sessionId}：新增消息 ${messages.length} 条` +
        `（${messages.map((m) => m?.role ?? '?').join(',') || '无'}），失败 ${failures.length} 次`,
    )

    try {
      await this.sessions.flush?.(session)
    } catch {
      /* 持久化失败不影响这一轮回复 */
    }

    if (!reply && failures.length > 0) throw failures[failures.length - 1]
    return reply
  }

  /** 等 agent 真正安静：子 agent 结算可能再触发一轮父级回合（与 headless 一致）。 */
  async #settle(agent) {
    const subagents = this.subagents?.()
    if (typeof subagents?.waitForChildren !== 'function') {
      await agent.whenIdle()
      return
    }
    for (let guard = 0; guard < 200; guard += 1) {
      await agent.whenIdle()
      const idleSeq = agent.session?.seq
      const childrenBusy = await subagents.waitForChildren(agent)
      if (!childrenBusy && agent.status === 'idle' && agent.session?.seq === idleSeq) return
    }
  }

  /** 中断当前回合。 */
  async stop(peerId) {
    const handle = this.handles.get(peerId)
    const agent = handle?.agent ?? this.agents.get(this.idFor(peerId))
    if (!agent) return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /** 结束并丢弃某个用户的会话（下一轮会重新建）。 */
  async reset(peerId) {
    const handle = this.handles.get(peerId)
    this.handles.delete(peerId)
    if (!handle) return false
    try {
      await handle.dispose()
    } catch (error) {
      this.log.warn(`释放会话失败：${errorMessage(error)}`)
    }
    return true
  }

  /** 插件卸载时释放全部会话。 */
  async disposeAll() {
    const entries = [...this.handles.entries()]
    this.handles.clear()
    await Promise.all(
      entries.map(async ([peerId, handle]) => {
        try {
          await handle.dispose()
        } catch (error) {
          this.log.warn(`释放 ${peerId} 的会话失败：${errorMessage(error)}`)
        }
      }),
    )
  }
}

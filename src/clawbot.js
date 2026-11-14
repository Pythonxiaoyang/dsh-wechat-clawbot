/**
 * 微信 ClawBot 通道本体：
 *
 *   扫码登录 → 长轮询 getupdates → 每条用户消息交给 DSH agent → sendmessage 回帖
 *
 * 设计约束（来自协议实测）：
 *   - 一只 bot 每 5 分钟大约只能发 7 条消息，所以「正在处理」用 typing 状态表示，
 *     一轮对话只回一条文本，长回复直接截断而不是拆成多条。
 *   - context_token 来自最近一条入站消息，会过期；发送失败 -14 表示 bot_token
 *     失效，要重新扫码。
 */

import { randomBytes } from 'node:crypto'
import { appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises'
import path from 'node:path'

import { sessionIdFor } from './bridge.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_CHANNEL_VERSION,
  DEFAULT_SK_ROUTE_TAG,
  TYPING_STATUS,
  describeNonText,
  describeResponse,
  extractText,
  getBotQrcode,
  getConfig,
  getQrcodeStatus,
  getUpdates,
  isOk,
  isRateLimited,
  isSessionExpired,
  messageIdOf,
  notifyStart,
  notifyStop,
  sendText,
  sendTyping,
} from './ilink.js'
import { LoginUi } from './ui.js'
import { PluginState } from './state.js'

const HELP_TEXT = [
  '我是接在 DSH 里的助手，直接发消息就能用。',
  '可用指令：',
  '/new  开一个新会话（清掉当前上下文）',
  '/stop 打断正在跑的这轮',
  '/id   看当前微信用户和会话 id',
].join('\n')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 滑动窗口限流：保证不会撞上服务端“每 5 分钟 7 条”的墙。 */
class WindowLimiter {
  constructor({ limit = 6, windowMs = 300_000, maxWaitMs = 180_000 } = {}) {
    this.limit = limit
    this.windowMs = windowMs
    this.maxWaitMs = maxWaitMs
    this.stamps = []
  }

  prune(now) {
    while (this.stamps.length && now - this.stamps[0] > this.windowMs) this.stamps.shift()
  }

  /** 取一个发送额度；必要时等待。 */
  async take() {
    const started = Date.now()
    for (;;) {
      const now = Date.now()
      this.prune(now)
      if (this.stamps.length < this.limit) {
        this.stamps.push(now)
        return
      }
      const wait = this.stamps[0] + this.windowMs - now + 100
      if (Date.now() - started + wait > this.maxWaitMs) return // 等太久了，硬发，让服务端判
      await sleep(Math.min(wait, 15_000))
    }
  }
}

export class WeChatClawbot {
  /**
   * @param {object} options
   * @param {object} options.ctx     cordis 上下文
   * @param {object} options.config  已归一化的配置
   * @param {object} options.log     logger
   * @param {object} options.bridge  AgentBridge（可注入，便于测试）
   */
  constructor({ ctx, config, log, bridge }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.bridge = bridge
    this.state = new PluginState(config.stateFile)
    this.ui = null
    this.stopped = false
    this.pollAbort = null
    this.loginPromise = null
    this.queues = new Map()
    this.typing = new Map()
    this.limiter = new WindowLimiter({ limit: config.replyLimit ?? 6, windowMs: 300_000 })
    this.startedAt = 0
  }

  // -- 生命周期 ------------------------------------------------------------

  /** 追加一行运行记录，方便在 GUI 里看不到 stderr 时排查（stateDir/activity.log）。 */
  activity(line) {
    try {
      this._activityBuffer = this._activityBuffer ?? ''
      this._activityBuffer += `[${new Date().toISOString()}] ${line}\n`
      if (this._activityBuffer.length > 2000) {
        const text = this._activityBuffer
        this._activityBuffer = ''
        mkdirAsync(this.config.stateDir, { recursive: true })
          .then(() => appendFileAsync(path.join(this.config.stateDir, 'activity.log'), text, 'utf8'))
          .catch(() => {})
      }
    } catch {
      /* 日志写不了也不能影响主流程 */
    }
  }

  async flushActivity() {
    const text = this._activityBuffer
    this._activityBuffer = ''
    if (!text) return
    try {
      await mkdirAsync(this.config.stateDir, { recursive: true })
      await appendFileAsync(path.join(this.config.stateDir, 'activity.log'), text, 'utf8')
    } catch {
      /* ignore */
    }
  }

  async start() {
    this.startedAt = Date.now()
    await this.state.load()
    // 配置里直接给了凭证时优先用它（方便无扫码环境）。
    if (!this.state.data.botToken && this.config.botToken) {
      this.state.data.botToken = this.config.botToken
      this.state.touch()
      await this.state.save()
    }
    const savedToken = this.state.data.botToken
    if (savedToken) {
      this.log.info(`使用已保存的 bot 凭证（${this.state.data.botId || '未知 bot'}）`)
    } else if (!this.config.autoLogin) {
      this.log.warn('还没有登录过微信 ClawBot，且 autoLogin=false，通道未启动')
      return
    } else {
      // 二维码会过期、可能扫到一半走开。登录失败不退出，隔一会儿重新出码。
      let attempt = 0
      for (;;) {
        if (this.stopped) return
        const ok = await this.login()
        if (this.stopped) return
        if (ok) break
        attempt += 1
        const wait = Math.min(20_000 * attempt, 180_000)
        this.log.warn(`登录没完成，${Math.round(wait / 1000)} 秒后重新出码（第 ${attempt} 次）`)
        this.ui?.setState('error', '二维码已失效，正在重新申请…（页面会自动刷新）')
        await sleep(wait)
      }
    }

    await this.notifyStart()
    this.log.info('开始监听微信消息')
    this.activity(`start bot=${this.state.data.botId || '?'} base=${this.apiOptions().baseUrl}`)
    void this.flushActivity()
    this.pollLoop().catch((error) => {
      this.log.error('轮询循环异常退出：', error)
    })
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.pollAbort?.abort()
    for (const entry of this.typing.values()) entry.stop()
    this.typing.clear()
    try {
      await this.notifyStop()
    } catch (error) {
      this.log.debug(`notifyStop 失败：${error?.message ?? error}`)
    }
    try {
      await this.state.save()
    } catch (error) {
      this.log.warn(`保存状态失败：${error?.message ?? error}`)
    }
    if (this.bridge) {
      try {
        await this.bridge.disposeAll()
      } catch (error) {
        this.log.warn(`释放会话失败：${error?.message ?? error}`)
      }
    }
    if (this.ui) {
      try {
        await this.ui.stop()
      } catch {
        /* ignore */
      }
      this.ui = null
    }
  }

  // -- 登录 ----------------------------------------------------------------

  /** 扫码登录；成功返回 true。并发调用会复用同一个登录流程。 */
  async login() {
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = this.#login().finally(() => {
      this.loginPromise = null
    })
    return this.loginPromise
  }

  /** 扫码页面只建一次，登录失败重试时复用同一个服务端和端口。 */
  async #ensureUi() {
    if (this.ui) return this.ui
    const ui = new LoginUi({ log: this.log })
    this.ui = ui
    try {
      await ui.start(this.config.uiPort ?? 0)
    } catch (error) {
      this.log.warn(`扫码页面启动失败（终端二维码仍然可用）：${error?.message ?? error}`)
      // 端口被占（比如上一次实例还没退干净）时，等一秒再试一次。
      await sleep(1200)
      try {
        await ui.start(this.config.uiPort ?? 0)
      } catch (retryError) {
        this.log.warn(`扫码页面仍然起不来：${retryError?.message ?? retryError}`)
      }
    }
    return ui
  }

  async #login() {
    const ui = await this.#ensureUi()

    const deadline = Date.now() + 8 * 60_000
    let refreshes = 0

    try {
      while (!this.stopped && Date.now() < deadline) {
        let qrcode
        let baseUrl = this.config.baseUrl
        try {
          const qr = await getBotQrcode({
            baseUrl,
            botType: this.config.botType,
            localTokens: this.state.data.botToken ? [this.state.data.botToken] : [],
          })
          qrcode = qr.qrcode
          ui.setQr(qr.qrcode_img_content)
        } catch (error) {
          this.log.error(`申请二维码失败：${error?.message ?? error}`)
          await sleep(3000)
          continue
        }

        let verifyCode = ''
        let waiting = true
        while (waiting && !this.stopped && Date.now() < deadline) {
          let status
          try {
            status = await getQrcodeStatus({ baseUrl, qrcode, verifyCode })
          } catch (error) {
            this.log.warn(`查询扫码状态失败：${error?.message ?? error}`)
            await sleep(2000)
            continue
          }

          switch (status.status) {
            case 'wait':
              ui.setState('waiting', '等待扫码…')
              await sleep(1200)
              break

            case 'scaned':
              ui.setState('scanned', '已扫码，请在手机上确认')
              await sleep(1200)
              break

            case 'scaned_but_redirect': {
              const host = status.redirect_host
              if (host) {
                baseUrl = host.startsWith('http') ? host : `https://${host}`
                this.log.info(`服务端要求切换接入点：${baseUrl}`)
              }
              await sleep(800)
              break
            }

            case 'need_verifycode': {
              verifyCode = await ui.waitForVerifyCode()
              this.log.info('已提交配对数字，继续等待确认')
              break
            }

            case 'verify_code_blocked':
              ui.setState('error', '配对数字错误次数过多，重新申请二维码')
              waiting = false
              refreshes += 1
              break

            case 'expired':
              waiting = false
              refreshes += 1
              ui.setState('error', '二维码已过期，正在重新申请…')
              break

            case 'binded_redirect':
              throw new Error(
                '这个微信号已经绑定过别的 ClawBot 客户端了。微信侧同时只允许一个，请先在微信里解绑，或换一个微信号。',
              )

            case 'confirmed': {
              const token = status.bot_token
              if (!token || !token.includes(':')) throw new Error('扫码成功，但服务端没有返回有效的 bot_token')
              this.state.data.botToken = token
              this.state.data.botId = status.ilink_bot_id ?? ''
              this.state.data.baseUrl = status.baseurl || baseUrl
              this.state.data.defaultTo = status.ilink_user_id ?? ''
              this.state.data.loggedInAt = Date.now()
              this.state.touch()
              await this.state.save()
              this.config.baseUrl = this.state.data.baseUrl || this.config.baseUrl
              ui.setState('connected', '登录成功，回到微信就能用了')
              this.log.info(`登录成功：bot_id=${status.ilink_bot_id} 用户=${status.ilink_user_id || '(未知)'}`)
              return true
            }

            default:
              ui.setState('waiting', `等待扫码…（${status.status ?? '未知状态'}）`)
              await sleep(1200)
              break
          }
        }

        if (refreshes > 3) throw new Error('二维码刷新次数过多，请稍后重试')
      }
      if (!this.stopped) throw new Error('等待扫码超时（8 分钟）')
      return false
    } catch (error) {
      this.log.error(`登录失败：${error?.message ?? error}`)
      ui.setState('error', `${error?.message ?? '登录失败'}，正在重试…`)
      return false
    }
  }

  async notifyStart() {
    try {
      await notifyStart({ ...this.apiOptions() })
    } catch (error) {
      this.log.debug(`notifyStart 失败：${error?.message ?? error}`)
    }
  }

  async notifyStop() {
    if (!this.state.data.botToken) return
    try {
      await notifyStop({ ...this.apiOptions() })
    } catch (error) {
      this.log.debug(`notifyStop 失败：${error?.message ?? error}`)
    }
  }

  // -- 轮询 ----------------------------------------------------------------

  apiOptions() {
    return {
      baseUrl: this.config.baseUrl || this.state.data.baseUrl || DEFAULT_BASE_URL,
      token: this.state.data.botToken,
      channelVersion: this.config.channelVersion,
      botAgent: this.config.botAgent,
      skRouteTag: this.config.skRouteTag,
    }
  }

  async pollLoop() {
    let backoff = 1000
    while (!this.stopped) {
      this.pollAbort = new AbortController()
      let response
      try {
        response = await getUpdates({
          ...this.apiOptions(),
          cursor: this.state.data.cursor,
          timeoutMs: this.config.pollTimeoutMs ?? 35000,
          signal: this.pollAbort.signal,
        })
      } catch (error) {
        if (this.stopped) break
        this.log.warn(`收消息失败：${error?.message ?? error}`)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
        continue
      }

      if (this.stopped) break

      if (!isOk(response)) {
        if (isSessionExpired(response)) {
          this.log.error(`bot 凭证失效（${describeResponse(response)}），需要重新扫码`)
          const ok = await this.relogin()
          if (!ok) break
          continue
        }
        if (isRateLimited(response)) {
          this.log.warn('触发频率限制，等 10 秒再收')
          await sleep(10_000)
          continue
        }
        this.log.warn(`getupdates 返回异常：${describeResponse(response)}`)
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
        continue
      }

      backoff = 1000
      if (response.get_updates_buf) {
        this.state.data.cursor = response.get_updates_buf
        this.state.touch()
      }
      const messages = Array.isArray(response.msgs) ? response.msgs : []
      for (const message of messages) {
        try {
          this.onInbound(message)
        } catch (error) {
          this.log.error('处理入站消息出错：', error)
        }
      }
      await this.state.save()
    }
    this.log.info('轮询已停止')
  }

  /** 凭证失效后重新扫码；失败则停止轮询，避免空转。 */
  async relogin() {
    this.state.data.botToken = ''
    this.state.touch()
    await this.state.save()
    if (!this.config.autoLogin) return false
    return this.login()
  }

  // -- 入站处理 -------------------------------------------------------------

  onInbound(message) {
    if (!message) return
    // 2 = bot 自己发的，忽略，避免自问自答。
    if (message.message_type !== undefined && Number(message.message_type) === 2) return

    const peer = String(message.from_user_id ?? '').trim()
    if (!peer) return
    if (this.state.data.botId && peer === this.state.data.botId) return
    if (!this.isAllowed(peer)) {
      this.log.warn(`忽略不在白名单里的用户：${peer}`)
      return
    }

    const id = messageIdOf(message)
    if (id && this.state.markSeen(id)) {
      this.log.debug(`跳过重复消息 ${id}`)
      return
    }

    const peerState = this.peerState(peer)
    if (message.context_token) {
      peerState.contextToken = String(message.context_token)
      this.state.touch()
    }

    const text = extractText(message).trim()
    if (!text) {
      const kind = describeNonText(message)
      if (kind) {
        this.enqueue(peer, async () => {
          await this.reply(peer, `收到一条${kind}消息，不过我这边暂时只看得懂文字。`, peerState.contextToken)
        })
      }
      return
    }

    this.enqueue(peer, () => this.handleText(peer, text, peerState))
    this.activity(`in <- ${peer}: ${text.slice(0, 80)}`)
    void this.flushActivity()
  }

  isAllowed(peer) {
    const allow = this.config.allowUsers
    if (!Array.isArray(allow) || allow.length === 0) return true
    return allow.includes(peer)
  }

  peerState(peer) {
    const peers = this.state.data.peers
    if (!peers[peer]) {
      peers[peer] = {
        sessionId: sessionIdFor(peer, this.config.sessionPrefix),
        contextToken: '',
        lastSeenAt: 0,
      }
      this.state.touch()
    }
    peers[peer].lastSeenAt = Date.now()
    return peers[peer]
  }

  sessionIdFor(peer) {
    const state = this.peerState(peer)
    if (!state.sessionId) {
      // 兜底：极少数 peer id 里没有可用字符时，退化成随机后缀。
      state.sessionId = sessionIdFor(peer, this.config.sessionPrefix)
      this.state.touch()
    }
    return state.sessionId
  }

  /** 旧会话存档读不出来时，给这个用户换一个新会话 id。 */
  rotateSessionId(peer) {
    const next = `${sessionIdFor(peer, this.config.sessionPrefix)}-${randomBytes(3).toString('hex')}`
    this.peerState(peer).sessionId = next
    this.state.touch()
    void this.state.save()
    return next
  }

  enqueue(peer, task) {
    const previous = this.queues.get(peer) ?? Promise.resolve()
    const next = previous
      .then(() => (this.stopped ? undefined : task()))
      .catch((error) => this.log.error(`处理 ${peer} 的消息失败：`, error))
    this.queues.set(peer, next)
    next.finally(() => {
      if (this.queues.get(peer) === next) this.queues.delete(peer)
    })
  }

  async handleText(peer, text, peerState) {
    if (text.startsWith('/')) {
      const handled = await this.handleCommand(peer, text, peerState)
      if (handled) return
    }

    const typing = this.startTyping(peer, peerState.contextToken)
    try {
      this.activity(`turn start (${this.sessionIdFor(peer)})`)
      void this.flushActivity()
      const reply = await this.bridge.runTurn(peer, text)
      typing.stop()
      this.activity(`turn done, ${reply.length} chars`)
      void this.flushActivity()
      await this.reply(peer, reply || '（这轮没有产出文本，可以换个说法再试）', peerState.contextToken)
    } catch (error) {
      typing.stop()
      this.log.error(`会话 ${peer} 处理失败：`, error)
      this.activity(`turn failed: ${error?.message ?? error}`)
      void this.flushActivity()
      const detail = String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 300)
      await this.reply(peer, `❌ 这轮没跑完：${detail}`, peerState.contextToken)
    }
  }

  async handleCommand(peer, text, peerState) {
    const [command] = text.trim().split(/\s+/)
    switch (command.toLowerCase()) {
      case '/help':
      case '/?':
        await this.reply(peer, HELP_TEXT, peerState.contextToken)
        return true

      case '/id':
        await this.reply(
          peer,
          `微信用户：${peer}\nDSH 会话：${this.sessionIdFor(peer)}`,
          peerState.contextToken,
        )
        return true

      case '/stop':
        await this.bridge.stop(peer)
        await this.reply(peer, '已请求打断当前这轮。', peerState.contextToken)
        return true

      case '/new':
      case '/reset': {
        await this.bridge.reset(peer)
        peerState.sessionId = `${sessionIdFor(peer, this.config.sessionPrefix)}-${randomBytes(3).toString('hex')}`
        this.state.touch()
        await this.state.save()
        await this.reply(peer, '好的，上下文清空了，重新开始吧。', peerState.contextToken)
        return true
      }

      default:
        return false
    }
  }

  // -- 出站 ----------------------------------------------------------------

  async reply(peer, text, contextToken) {
    const body = this.decorate(text)
    if (!body) return
    await this.limiter.take()
    let attempt = 0
    for (;;) {
      attempt += 1
      let response
      try {
        response = await sendText({
          ...this.apiOptions(),
          to: peer,
          text: body,
          contextToken,
        })
      } catch (error) {
        this.log.error(`发送失败：${error?.message ?? error}`)
        if (attempt >= 2) return
        await sleep(2000)
        continue
      }
      if (isOk(response)) {
        this.log.info(`已回复 ${peer}（${body.length} 字）`)
        this.activity(`out -> ${peer}: ${body.length} chars`)
        void this.flushActivity()
        return
      }
      if (isRateLimited(response) && attempt < 3) {
        this.log.warn('发送被限流，8 秒后重试')
        await sleep(8000)
        continue
      }
      this.log.error(`发送被拒绝：${describeResponse(response)}`)
      return
    }
  }

  decorate(text) {
    let body = String(text ?? '').trim()
    if (!body) return ''
    const limit = this.config.maxReplyChars ?? 1800
    if (body.length > limit) {
      body = `${body.slice(0, limit)}\n\n…（回复太长，截断了 ${body.length - limit} 字；想看全文可以到 DSH 里打开这个会话）`
    }
    return body
  }

  // -- “正在输入” -----------------------------------------------------------

  startTyping(peer, contextToken) {
    if (!this.config.typing) return { stop() {} }
    const entry = { stopped: false, timer: null, ticket: '', stop: () => this.stopTyping(peer) }
    this.typing.set(peer, entry)
    const tick = async () => {
      if (entry.stopped) return
      try {
        if (!entry.ticket) {
          const config = await getConfig({
            ...this.apiOptions(),
            userId: peer,
            contextToken,
          })
          entry.ticket = config?.typing_ticket ?? ''
        }
        if (entry.ticket && !entry.stopped) {
          await sendTyping({
            ...this.apiOptions(),
            userId: peer,
            typingTicket: entry.ticket,
            status: TYPING_STATUS.TYPING,
          })
        }
      } catch (error) {
        this.log.debug(`typing 失败：${error?.message ?? error}`)
      }
      if (!entry.stopped) entry.timer = setTimeout(tick, 5000)
    }
    void tick()
    return entry
  }

  stopTyping(peer) {
    const entry = this.typing.get(peer)
    if (!entry) return
    entry.stopped = true
    if (entry.timer) clearTimeout(entry.timer)
    this.typing.delete(peer)
    if (!entry.ticket || !this.config.typing) return
    sendTyping({
      ...this.apiOptions(),
      userId: peer,
      typingTicket: entry.ticket,
      status: TYPING_STATUS.CANCEL,
    }).catch(() => {})
  }
}

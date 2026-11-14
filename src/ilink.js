/**
 * 腾讯 iLink Bot API 客户端（微信 ClawBot 通道）。
 *
 * 协议来自官方插件 @tencent-weixin/openclaw-weixin（Tencent, MIT）与
 * wechat-clawbot-push（PyPI, MIT）的实现，端点：
 *
 *   POST {base}/ilink/bot/get_bot_qrcode?bot_type=3   → { qrcode, qrcode_img_content }
 *   GET  {base}/ilink/bot/get_qrcode_status?qrcode=…  → { status, bot_token, baseurl, ilink_bot_id, ilink_user_id, redirect_host }
 *   POST {base}/ilink/bot/getupdates                  → { ret, msgs, get_updates_buf }
 *   POST {base}/ilink/bot/sendmessage                 → { ret, errcode, errmsg }
 *   POST {base}/ilink/bot/getconfig | sendtyping | msg/notifystart | msg/notifystop
 *
 * 鉴权：Authorization: Bearer <bot_token>，AuthorizationType: ilink_bot_token。
 * 所有 POST 都带 base_info（channel_version + bot_agent）。
 */

import { randomBytes, randomUUID } from 'node:crypto'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_BOT_TYPE = '3'
export const DEFAULT_CHANNEL_VERSION = '1.0.3'
export const DEFAULT_SK_ROUTE_TAG = '1001'
/** 默认 bot_agent（UA 语法：name/version）。 */
export const DEFAULT_BOT_AGENT = 'DSH-WeChat-Clawbot/0.1.0'
/** iLink-App-ClientVersion: 0x00MMNNPP（1.0.11）。 */
export const DEFAULT_CLIENT_VERSION = (1 << 16) | (0 << 8) | 11

/** MessageType：1 = 用户发的，2 = bot 自己发的。 */
export const MESSAGE_TYPE = { NONE: 0, USER: 1, BOT: 2 }
/** MessageItemType：1=文本 2=图片 3=语音 4=文件 5=视频。 */
export const ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }
/** MessageState：2 = 完成态。 */
export const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 }
/** TypingStatus：1 = 正在输入，2 = 取消。 */
export const TYPING_STATUS = { TYPING: 1, CANCEL: 2 }

const ERROR_CODES = {
  RATE_LIMITED: -2,
  SESSION_EXPIRED: -14,
}

/** HTTP 非 2xx 时抛出，带上状态码与响应体，便于日志区分网络/协议问题。 */
export class IlinkHttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message)
    this.name = 'IlinkHttpError'
    this.status = status
    this.body = body
    this.url = url
  }
}

export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return `${base}/${String(path).replace(/^\/+/, '')}`
}

/** X-WECHAT-UIN: 随机 uint32 的十进制字符串再做 base64。 */
function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

export function buildHeaders(options = {}) {
  const {
    token,
    appId = 'bot',
    clientVersion = DEFAULT_CLIENT_VERSION,
    skRouteTag = DEFAULT_SK_ROUTE_TAG,
    json = false,
  } = options
  const headers = {
    'iLink-App-Id': appId,
    'iLink-App-ClientVersion': String(clientVersion),
  }
  if (skRouteTag) headers.SKRouteTag = String(skRouteTag)
  if (json) {
    headers['Content-Type'] = 'application/json'
    headers.AuthorizationType = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = randomWechatUin()
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * 每个请求都带的 base_info。
 * bot_agent 走 UA 语法：name/version [ (comment) ]，服务端会做语法清洗。
 */
export function buildBaseInfo({ channelVersion = DEFAULT_CHANNEL_VERSION, botAgent = DEFAULT_BOT_AGENT } = {}) {
  const info = { channel_version: channelVersion }
  if (botAgent) info.bot_agent = botAgent
  return info
}

async function readBody(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * 统一请求出口。
 * @returns {Promise<{status:number, text:string, json:any}>}
 */
export async function request(url, options = {}) {
  const {
    method = 'POST',
    body,
    headers = {},
    timeoutMs = 20000,
    signal,
  } = options

  const signals = []
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal) signals.push(signal)
  const combined = signals.length === 1 ? signals[0] : signals.length ? AbortSignal.any(signals) : undefined

  const init = { method, headers }
  if (combined) init.signal = combined
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)

  const response = await fetch(url, init)
  const text = await readBody(response)
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!response.ok) {
    throw new IlinkHttpError(`${method} ${url} → HTTP ${response.status}`, {
      status: response.status,
      body: text.slice(0, 500),
      url,
    })
  }
  return { status: response.status, text, json }
}

function post(url, { token, body, timeoutMs, signal, clientVersion, skRouteTag, appId }) {
  return request(url, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    headers: buildHeaders({ token, json: true, clientVersion, skRouteTag, appId }),
    timeoutMs,
    signal,
  })
}

function get(url, { timeoutMs, signal, clientVersion, skRouteTag, appId } = {}) {
  return request(url, {
    method: 'GET',
    headers: buildHeaders({ clientVersion, skRouteTag, appId }),
    timeoutMs,
    signal,
  })
}

/** 该响应算不算成功（ret/errcode 缺省、0 或 "0" 都算）。 */
export function isOk(response) {
  if (!response) return false
  const ret = response.ret
  const code = response.errcode
  const okRet = ret === undefined || ret === null || Number(ret) === 0
  const okCode = code === undefined || code === null || Number(code) === 0
  return okRet && okCode
}

/** -14：bot_token 失效（需要重新扫码）。 */
export function isSessionExpired(response) {
  return Number(response?.errcode) === ERROR_CODES.SESSION_EXPIRED || Number(response?.ret) === ERROR_CODES.SESSION_EXPIRED
}

/** -2：触发频率限制（等几秒再试）。 */
export function isRateLimited(response) {
  return Number(response?.ret) === ERROR_CODES.RATE_LIMITED || Number(response?.errcode) === ERROR_CODES.RATE_LIMITED
}

export function describeResponse(response) {
  if (!response) return 'empty response'
  const parts = []
  if (response.ret !== undefined) parts.push(`ret=${response.ret}`)
  if (response.errcode !== undefined) parts.push(`errcode=${response.errcode}`)
  if (response.errmsg) parts.push(String(response.errmsg))
  return parts.length ? parts.join(' ') : JSON.stringify(response).slice(0, 200)
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

/**
 * 申请一张登录二维码。
 * @param {object} options
 * @param {string[]} [options.localTokens] 本机已有 bot_token，最多 10 个（用于“已绑过”判定）
 * @returns {Promise<{qrcode:string, qrcode_img_content:string}>}
 */
export async function getBotQrcode(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    botType = DEFAULT_BOT_TYPE,
    localTokens = [],
  } = options
  const { json, text } = await post(
    joinUrl(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`),
    { body: { local_token_list: localTokens.slice(0, 10) }, timeoutMs: 20000 },
  )
  const payload = json ?? {}
  if (!payload.qrcode) {
    throw new Error(`获取登录二维码失败：${describeResponse(payload) || text.slice(0, 200)}`)
  }
  return payload
}

/**
 * 轮询扫码状态（服务端长轮询，最长约 35s）。
 * status: wait | scaned | scaned_but_redirect | need_verifycode |
 *         expired | verify_code_blocked | binded_redirect | confirmed
 */
export async function getQrcodeStatus(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    qrcode,
    verifyCode = '',
    timeoutMs = 35000,
  } = options
  const query = new URLSearchParams({ qrcode })
  if (verifyCode) query.set('verify_code', verifyCode)
  try {
    const { json } = await get(joinUrl(baseUrl, `ilink/bot/get_qrcode_status?${query.toString()}`), { timeoutMs })
    return json ?? { status: 'wait' }
  } catch (error) {
    // 长轮询超时、网关 5xx 都当作“继续等”，不要把登录流程打断。
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { status: 'wait' }
    if (error instanceof IlinkHttpError && (error.status === 502 || error.status === 503 || error.status === 504)) {
      return { status: 'wait' }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 收发消息
// ---------------------------------------------------------------------------

/**
 * 长轮询收消息。客户端超时返回空结果（正常的控制流），其余错误抛出。
 * @returns {Promise<{ret:number, msgs:object[], get_updates_buf:string}>}
 */
export async function getUpdates(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    token,
    cursor = '',
    timeoutMs = 35000,
    signal,
    channelVersion,
    botAgent,
  } = options
  const url = joinUrl(baseUrl, 'ilink/bot/getupdates')
  try {
    const { json } = await post(url, {
      token,
      body: { get_updates_buf: cursor ?? '', base_info: buildBaseInfo({ channelVersion, botAgent }) },
      timeoutMs,
      signal,
    })
    return json ?? { ret: 0, msgs: [], get_updates_buf: cursor }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: cursor, timedOut: true }
    }
    throw error
  }
}

function newClientId() {
  return `dsh-wechat-clawbot-${randomUUID()}`
}

/**
 * 发一条文本。
 * @returns {Promise<object>} 原始响应（ret/errcode 交给调用方判断）
 */
export async function sendText(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    token,
    to,
    text,
    contextToken = '',
    runId = '',
    timeoutMs = 20000,
    channelVersion,
    botAgent,
  } = options
  if (!to) throw new Error('sendText: 缺少接收方 to_user_id')
  const msg = {
    from_user_id: '',
    to_user_id: to,
    client_id: newClientId(),
    message_type: MESSAGE_TYPE.BOT,
    message_state: MESSAGE_STATE.FINISH,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: String(text ?? '') } }],
  }
  if (contextToken) msg.context_token = contextToken
  if (runId) msg.run_id = runId

  const { json } = await post(joinUrl(baseUrl, 'ilink/bot/sendmessage'), {
    token,
    body: { msg, base_info: buildBaseInfo({ channelVersion, botAgent }) },
    timeoutMs,
  })
  return json ?? {}
}

/** 取 typing_ticket（每个用户一份，用于发“正在输入”）。 */
export async function getConfig(options = {}) {
  const { baseUrl = DEFAULT_BASE_URL, token, userId, contextToken = '', timeoutMs = 10000, channelVersion, botAgent } = options
  const { json } = await post(joinUrl(baseUrl, 'ilink/bot/getconfig'), {
    token,
    body: {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo({ channelVersion, botAgent }),
    },
    timeoutMs,
  })
  return json ?? {}
}

/** 发/取消“正在输入”状态（不占消息条数）。 */
export async function sendTyping(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    token,
    userId,
    typingTicket,
    status = TYPING_STATUS.TYPING,
    timeoutMs = 10000,
    channelVersion,
    botAgent,
  } = options
  await post(joinUrl(baseUrl, 'ilink/bot/sendtyping'), {
    token,
    body: {
      ilink_user_id: userId,
      typing_ticket: typingTicket ?? '',
      status,
      base_info: buildBaseInfo({ channelVersion, botAgent }),
    },
    timeoutMs,
  })
}

export async function notifyStart(options = {}) {
  const { baseUrl = DEFAULT_BASE_URL, token, timeoutMs = 10000, channelVersion, botAgent } = options
  const { json } = await post(joinUrl(baseUrl, 'ilink/bot/msg/notifystart'), {
    token,
    body: { base_info: buildBaseInfo({ channelVersion, botAgent }) },
    timeoutMs,
  })
  return json ?? {}
}

export async function notifyStop(options = {}) {
  const { baseUrl = DEFAULT_BASE_URL, token, timeoutMs = 10000, channelVersion, botAgent } = options
  const { json } = await post(joinUrl(baseUrl, 'ilink/bot/msg/notifystop'), {
    token,
    body: { base_info: buildBaseInfo({ channelVersion, botAgent }) },
    timeoutMs,
  })
  return json ?? {}
}

// ---------------------------------------------------------------------------
// 入站消息解析
// ---------------------------------------------------------------------------

/** 从 item_list 里取第一段可读文本（文本，或语音转文字）。 */
export function extractText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  for (const item of items) {
    if (!item) continue
    if (Number(item.type) === ITEM_TYPE.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text)
    }
    if (Number(item.type) === ITEM_TYPE.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text)
    }
  }
  return ''
}

/** 非文本消息给一个人话标签，用来回一句“暂时看不懂”。 */
export function describeNonText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  for (const item of items) {
    switch (Number(item?.type)) {
      case ITEM_TYPE.IMAGE:
        return '图片'
      case ITEM_TYPE.VOICE:
        return '语音'
      case ITEM_TYPE.FILE:
        return '文件'
      case ITEM_TYPE.VIDEO:
        return '视频'
      default:
        break
    }
  }
  return ''
}

/** 消息 id（顶层 message_id 优先，其次首个 item 的 msg_id）。 */
export function messageIdOf(message) {
  const top = typeof message?.message_id === 'string' ? message.message_id.trim() : ''
  if (top) return top
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  for (const item of items) {
    const id = typeof item?.msg_id === 'string' ? item.msg_id.trim() : ''
    if (id) return id
  }
  return ''
}

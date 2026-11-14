/**
 * 直接给绑定的微信用户推一条文本（不经过 DSH 会话）。
 *
 *   node tools/send.mjs "测试"
 *   node tools/send.mjs --to o9cq...@im.wechat "测试"
 *   node tools/send.mjs --state D:/other/state.json "测试"
 *
 * 用的是插件已经扫码得到的 bot_token，所以不需要再登录。
 * 注意微信侧一只 bot 约 5 分钟只能发 7 条，别拿它刷。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { describeResponse, isOk, isSessionExpired, sendText } from '../src/ilink.js'

const argv = process.argv.slice(2)
const flags = {}
const rest = []
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (token === '--to' || token === '--state') {
    flags[token.slice(2)] = argv[i + 1]
    i += 1
  } else if (token.startsWith('--')) {
    flags[token.slice(2)] = true
  } else {
    rest.push(token)
  }
}

const text = flags.text ?? rest.join(' ')
if (!text) {
  console.error('用法：node tools/send.mjs "要发送的文本"')
  process.exit(2)
}

const stateFile = flags.state ?? path.join(homedir(), '.dsh', 'storages', 'wechat-clawbot', 'state.json')
let state
try {
  state = JSON.parse(await readFile(stateFile, 'utf8'))
} catch (error) {
  console.error(`读不到状态文件 ${stateFile}：${error.message}`)
  process.exit(1)
}

if (!state.botToken) {
  console.error('状态文件里没有 bot_token，先在 DSH 里扫码登录一次')
  process.exit(1)
}

const to = flags.to ?? state.defaultTo
if (!to) {
  console.error('不知道发给谁：状态文件里没有 defaultTo，请用 --to 指定')
  process.exit(1)
}

const baseUrl = state.baseUrl || 'https://ilinkai.weixin.qq.com'
const contextToken = state.peers?.[to]?.contextToken ?? ''

const attempt = async (token) => {
  const response = await sendText({ baseUrl, token: state.botToken, to, text, contextToken: token })
  return response
}

let response = await attempt(contextToken)
// context_token 过期时，新版 iLink 允许不带它、投递到最近活跃会话。
if (!isOk(response) && contextToken) {
  console.error(`带会话上下文发送被拒（${describeResponse(response)}），改发最近活跃会话`)
  response = await attempt('')
}

if (isOk(response)) {
  console.log(JSON.stringify({ ok: true, to, chars: text.length, response }))
} else {
  console.error(JSON.stringify({ ok: false, to, response, expired: isSessionExpired(response) }))
  process.exit(1)
}

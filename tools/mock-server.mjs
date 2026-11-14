/**
 * 本地联调用的“假微信服务端”。
 *
 * 用法：
 *   node tools/mock-server.mjs --port 8787
 *
 * 它实现插件用到的 iLink 端点，另外提供三个便于手动测试的辅助接口：
 *   POST /__push    {"text":"你好","from":"wx-user-1"}   → 塞一条“用户消息”
 *   GET  /__sent                                         → 看看插件回了什么
 *   POST /__reset                                        → 清空记录
 *
 * 只用于本机联调，不要拿去连真微信。
 */

import http from 'node:http'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8787

const state = {
  queue: [],
  sent: [],
  calls: [],
  cursor: 'cursor-0',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = {}
    }
    const reply = (payload, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (url.pathname === '/__push') {
      const message = {
        message_id: `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        from_user_id: body.from ?? 'wx-user-1',
        to_user_id: 'bot-1',
        message_type: 1,
        message_state: 2,
        create_time_ms: Date.now(),
        context_token: body.contextToken ?? 'ctx-mock-1',
        item_list: [{ type: 1, text_item: { text: body.text ?? '你好' } }],
      }
      state.queue.push(message)
      console.log('[mock] push', JSON.stringify(message.item_list))
      reply({ ok: true, queued: state.queue.length })
      return
    }

    if (url.pathname === '/__sent') {
      reply({ sent: state.sent, calls: state.calls.slice(-20) })
      return
    }

    if (url.pathname === '/__reset') {
      state.sent = []
      state.calls = []
      reply({ ok: true })
      return
    }

    state.calls.push({ path: url.pathname, body })

    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      reply({ qrcode: 'qr-mock', qrcode_img_content: 'https://example.invalid/scan/qr-mock' })
      return
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      reply({
        status: 'confirmed',
        bot_token: 'bot-mock@im.bot:0123456789abcdef',
        baseurl: `http://127.0.0.1:${port}`,
        ilink_bot_id: 'bot-1',
        ilink_user_id: 'owner-1',
      })
      return
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      const batch = state.queue
      state.queue = []
      reply({ ret: 0, msgs: batch, get_updates_buf: state.cursor })
      return
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      const text = body?.msg?.item_list?.[0]?.text_item?.text ?? ''
      state.sent.push({ at: Date.now(), text })
      console.log('[mock] <- 插件回复:', text.slice(0, 200))
      reply({ ret: 0, message_id: `srv-${state.sent.length}` })
      return
    }
    if (url.pathname === '/ilink/bot/getconfig') {
      reply({ ret: 0, typing_ticket: 'typing-ticket-mock' })
      return
    }
    if (url.pathname === '/ilink/bot/sendtyping' || url.pathname.startsWith('/ilink/bot/msg/notify')) {
      reply({ ret: 0 })
      return
    }
    reply({ ret: -1, errmsg: `unknown ${url.pathname}` }, 404)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] iLink 假服务端已启动 http://127.0.0.1:${port}`)
})

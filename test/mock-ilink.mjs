/**
 * 测试用的假 iLink 服务端：只实现本插件用到的几个端点。
 */

import http from 'node:http'

export async function startMockIlink({ messages = [], token = 'bot-abc@im.bot:0123456789abcdef' } = {}) {
  const received = []
  const calls = []
  let queue = [...messages]
  let cursor = 'cursor-0'
  let statusScript = [{ status: 'confirmed' }]

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      calls.push({ method: req.method, path: url.pathname, query: url.search, body, headers: req.headers })

      const send = (payload, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (url.pathname === '/ilink/bot/get_bot_qrcode') {
        send({ qrcode: 'qr-1', qrcode_img_content: 'https://example.invalid/scan/qr-1' })
        return
      }

      if (url.pathname === '/ilink/bot/get_qrcode_status') {
        const next = statusScript.length > 1 ? statusScript.shift() : statusScript[0]
        if (next.status === 'confirmed') {
          send({
            status: 'confirmed',
            bot_token: token,
            baseurl: base,
            ilink_bot_id: 'bot-1',
            ilink_user_id: 'owner-1',
          })
        } else {
          send(next)
        }
        return
      }

      if (url.pathname === '/ilink/bot/getupdates') {
        const batch = queue
        queue = []
        send({ ret: 0, msgs: batch, get_updates_buf: cursor })
        return
      }

      if (url.pathname === '/ilink/bot/sendmessage') {
        received.push(body)
        send({ ret: 0, message_id: `srv-${received.length}` })
        return
      }

      if (url.pathname === '/ilink/bot/getconfig') {
        send({ ret: 0, typing_ticket: 'typing-ticket-1' })
        return
      }

      if (url.pathname === '/ilink/bot/sendtyping' || url.pathname.startsWith('/ilink/bot/msg/notify')) {
        send({ ret: 0 })
        return
      }

      send({ ret: -1, errmsg: `unknown endpoint ${url.pathname}` }, 404)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    calls,
    received,
    /** 往下一轮 getupdates 里塞消息 */
    push(...msgs) {
      queue.push(...msgs)
    },
    setStatusScript(script) {
      statusScript = script
    },
    setCursor(next) {
      cursor = next
    },
    sentTexts() {
      return received.map((item) => item?.msg?.item_list?.[0]?.text_item?.text ?? '')
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 造一条微信用户文本消息。 */
export function userMessage({ id = 'msg-1', from = 'wx-user-1', text = '你好', contextToken = 'ctx-1', type = 1 } = {}) {
  return {
    message_id: id,
    from_user_id: from,
    to_user_id: 'bot-1',
    message_type: type,
    message_state: 2,
    create_time_ms: Date.now(),
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

/** 等条件成立（最多 timeout 毫秒）。 */
export async function waitFor(predicate, { timeout = 4000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

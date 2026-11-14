/**
 * 扫码登录用的本机小页面。
 *
 * 为什么自带一个 http 服务：DSH 的 Web 界面里没有地方打印二维码，而扫码
 * 必须让人看到图。这里只监听 127.0.0.1，路径里带一段随机 token，页面
 * 自己轮询状态；需要输入手机上的配对数字时，页面上直接填。
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { svgQr, asciiQr } from './qr.js'

function pageHtml({ token, state, message, qrContent, qrVersion }) {
  const qrHtml = qrContent ? svgQr(qrContent, { cellSize: 6, margin: 2 }) : ''
  const verifyForm =
    state === 'verifycode'
      ? `<form method="POST" action="/${token}/verify" class="verify">
           <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="手机上的配对数字" autofocus>
           <button type="submit">提交</button>
         </form>`
      : ''
  const done = state === 'connected'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信 ClawBot 扫码登录</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         background:#0f1115; color:#e8eaed; }
  .card { background:#fff; color:#111; border-radius:16px; padding:24px 28px 20px;
          box-shadow:0 20px 60px rgba(0,0,0,.45); max-width:420px; text-align:center; }
  h1 { font-size:17px; margin:0 0 4px; font-weight:600; }
  p { margin:6px 0; font-size:13px; color:#555; }
  .qr { margin:14px auto 10px; width:260px; height:260px; }
  .qr svg { width:100%; height:100%; }
  .status { font-size:13px; padding:8px 12px; border-radius:8px; background:#f4f5f7; color:#333; }
  .status.ok { background:#e7f7ec; color:#15703a; }
  .status.err { background:#fdecec; color:#a11d1d; }
  .verify { margin-top:12px; display:flex; gap:8px; justify-content:center; }
  .verify input { flex:1; min-width:0; padding:8px 10px; border:1px solid #d5d8dd;
                  border-radius:8px; font-size:15px; }
  .verify button { padding:8px 16px; border:0; border-radius:8px; background:#07c160;
                   color:#fff; font-size:15px; cursor:pointer; }
  footer { margin-top:14px; font-size:11px; color:#9aa0a6; }
</style></head>
<body><div class="card">
  <h1>微信 ClawBot 扫码登录</h1>
  <p>用手机微信扫下面的二维码，在手机上确认即可让 DSH 接入。</p>
  <div class="qr">${done ? '<div style="font-size:64px;line-height:260px">✅</div>' : qrHtml}</div>
  <div class="status ${done ? 'ok' : ''}" id="status">${message}</div>
  ${verifyForm}
  <footer>本页面只监听本机 127.0.0.1，登录成功后可以直接关掉。</footer>
</div>
<script>
  const status = document.getElementById('status');
  const initialQrVersion = ${Number(qrVersion) || 0};
  async function tick() {
    try {
      const res = await fetch('/${token}/status', { cache: 'no-store' });
      const data = await res.json();
      if (data.qrVersion !== initialQrVersion) { location.reload(); return; }
      if (data.state === 'connected') {
        status.textContent = data.message;
        status.className = 'status ok';
        setTimeout(() => location.reload(), 400);
        return;
      }
      status.textContent = data.message;
      if (data.state === 'verifycode' && !document.querySelector('.verify')) location.reload();
    } catch (e) { /* 页面关掉前不再重试 */ }
    setTimeout(tick, 1500);
  }
  if (document.getElementById('status') && '${state}' !== 'connected') setTimeout(tick, 800);
</script>
</body></html>`
}

export class LoginUi {
  constructor({ log } = {}) {
    this.log = log ?? { info() {}, warn() {}, debug() {} }
    this.token = randomBytes(12).toString('hex')
    this.qrContent = ''
    this.qrVersion = 0
    this.state = 'starting'
    this.message = '正在申请二维码…'
    this.server = null
    this.url = ''
    this._verifyResolve = null
  }

  setQr(content) {
    this.qrContent = content
    this.qrVersion += 1
    this.state = 'waiting'
    this.message = '等待扫码（手机上确认后这里会自动刷新）'
    this.log.info(`二维码链接：${content}`)
    this.log.info('终端里也能扫：')
    this.log.info(`\n${asciiQr(content)}`)
  }

  setState(state, message) {
    this.state = state
    this.message = message
    this.log.info(`[登录] ${message}`)
  }

  waitForVerifyCode() {
    this.setState('verifycode', '请输入手机微信上显示的配对数字')
    return new Promise((resolve) => {
      this._verifyResolve = resolve
    })
  }

  submitVerifyCode(code) {
    const value = String(code ?? '').trim()
    if (!value) return false
    const resolve = this._verifyResolve
    this._verifyResolve = null
    if (resolve) resolve(value)
    return Boolean(resolve)
  }

  async start(port = 0) {
    const server = http.createServer((req, res) => this.handle(req, res))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    this.server = server
    const actual = server.address()?.port
    this.url = `http://127.0.0.1:${actual}/${this.token}/`
    this.log.info(`扫码页面：${this.url}`)
    return this.url
  }

  handle(req, res) {
    const prefix = `/${this.token}`
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 根路径直接跳到带 token 的页面，方便用户只记 http://127.0.0.1:<port>/
    if (url.pathname === '/' || url.pathname === '') {
      res.writeHead(302, { location: `${prefix}/`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const action = url.pathname.slice(prefix.length)

    if (req.method === 'GET' && (action === '/' || action === '')) {
      const html = pageHtml({
        token: this.token,
        state: this.state,
        message: this.message,
        qrContent: this.qrContent,
        qrVersion: this.qrVersion,
      })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    if (req.method === 'GET' && action === '/status') {
      const body = JSON.stringify({ state: this.state, message: this.message, qrVersion: this.qrVersion })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    if (req.method === 'POST' && action === '/verify') {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 4096) req.destroy()
      })
      req.on('end', () => {
        const code = new URLSearchParams(raw).get('code') ?? ''
        const ok = this.submitVerifyCode(code)
        res.writeHead(ok ? 302 : 400, ok ? { location: `${prefix}/` } : {})
        res.end(ok ? '' : '验证码为空')
      })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  async stop() {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

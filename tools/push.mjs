/**
 * 往假 iLink 服务端塞一条“用户消息”（UTF-8 安全，避免 PowerShell 控制台编码干扰）。
 *
 *   node tools/push.mjs "你好" [from]
 */

const text = process.argv[2] ?? '你好'
const from = process.argv[3] ?? 'wx-user-1'
const base = process.env.MOCK_BASE ?? 'http://127.0.0.1:8787'

const response = await fetch(`${base}/__push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ text, from }),
})
console.log(await response.text())

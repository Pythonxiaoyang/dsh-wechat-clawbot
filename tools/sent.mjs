/**
 * 读假 iLink 服务端收到的回复（按 UTF-8 输出，方便在 GBK 控制台里核对）。
 */

const base = process.env.MOCK_BASE ?? 'http://127.0.0.1:8787'
const response = await fetch(`${base}/__sent`)
const data = await response.json()
for (const item of data.sent ?? []) {
  const time = new Date(item.at).toLocaleTimeString('zh-CN')
  process.stdout.write(`[${time}] ${item.text}\n---\n`)
}

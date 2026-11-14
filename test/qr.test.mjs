import assert from 'node:assert/strict'
import test from 'node:test'

import { asciiQr, makeQr, svgQr } from '../src/qr.js'

test('二维码矩阵：版本与模块数合理', () => {
  const qr = makeQr('https://example.invalid/scan/abc')
  const count = qr.getModuleCount()
  assert.ok(count >= 21, '最小版本是 21x21')
  assert.equal(count % 4, 1, 'QR 模块数满足 4n+1')
  let dark = 0
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) dark += 1
    }
  }
  assert.ok(dark > count * count * 0.2, '深色模块不应该太少')
})

test('SVG：自包含、带 path', () => {
  const svg = svgQr('hello-clawbot')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<path d="M/)
  assert.match(svg, /fill="#000000"/)
})

test('终端二维码：行数 = 模块数 + 上下静区', () => {
  const text = 'https://example.invalid/x'
  const count = makeQr(text).getModuleCount()
  const lines = asciiQr(text, { quiet: 2 }).split('\n')
  assert.equal(lines.length, count + 4)
  assert.equal(lines[0].trim(), '')
})

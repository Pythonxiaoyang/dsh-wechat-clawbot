/**
 * 二维码渲染。
 *
 * 微信扫码登录拿到的 `qrcode_img_content` 是一段**内容字符串**（不是图片），
 * 必须自己编码成二维码。这里用 vendor/qrcode.mjs（qrcode-generator，MIT，
 * 作者 Kazuhiko Arase），只做码点矩阵，SVG / 终端字符都由本文件生成。
 */

import qrcodeFactory from '../vendor/qrcode.mjs'

/** 生成二维码矩阵（typeNumber 0 = 自动选版本，纠错等级 M 足够）。 */
export function makeQr(text, { errorCorrectionLevel = 'M' } = {}) {
  const qr = qrcodeFactory(0, errorCorrectionLevel)
  qr.addData(String(text))
  qr.make()
  return qr
}

/**
 * 终端里能看的二维码：每个模块两个字符宽，深色用 ██。
 * 白底终端直接可扫；深色终端需要反色（见 invert 参数）。
 */
export function asciiQr(text, { quiet = 2, invert = false } = {}) {
  const qr = makeQr(text)
  const count = qr.getModuleCount()
  const width = count + quiet * 2
  const blank = '  '.repeat(width)
  const lines = []
  for (let i = 0; i < quiet; i += 1) lines.push(blank)
  for (let row = 0; row < count; row += 1) {
    let line = '  '.repeat(quiet)
    for (let col = 0; col < count; col += 1) {
      const dark = qr.isDark(row, col)
      line += dark !== invert ? '██' : '  '
    }
    line += '  '.repeat(quiet)
    lines.push(line)
  }
  for (let i = 0; i < quiet; i += 1) lines.push(blank)
  return lines.join('\n')
}

/** 生成一张自包含的 SVG（页面里直接内联，不依赖任何 CDN）。 */
export function svgQr(text, { cellSize = 6, margin = 4 } = {}) {
  const qr = makeQr(text)
  const count = qr.getModuleCount()
  const total = count + margin * 2
  let path = ''
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`
    }
  }
  const size = total * cellSize
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="微信扫码登录">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  )
}

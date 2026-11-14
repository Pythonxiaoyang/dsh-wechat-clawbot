import assert from 'node:assert/strict'
import test from 'node:test'

import { LoginUi } from '../src/ui.js'

const silent = { info() {}, warn() {}, debug() {} }

test('扫码页面：根路径跳转、状态 JSON 带 qrVersion、换码后版本自增', async () => {
  const ui = new LoginUi({ log: silent })
  await ui.start(0)
  try {
    const root = await fetch('http://127.0.0.1:' + new URL(ui.url).port + '/', { redirect: 'manual' })
    assert.equal(root.status, 302)
    assert.match(root.headers.get('location') ?? '', /^\/[0-9a-f]{24}\/$/)

    ui.setQr('https://example.invalid/scan/one')
    const first = await (await fetch(new URL('status', ui.url))).json()
    assert.equal(first.state, 'waiting')
    assert.equal(first.qrVersion, 1)

    ui.setQr('https://example.invalid/scan/two')
    const second = await (await fetch(new URL('status', ui.url))).json()
    assert.equal(second.qrVersion, 2)

    const page = await (await fetch(ui.url)).text()
    assert.match(page, /<svg/)
    assert.match(page, /initialQrVersion = 2/)
  } finally {
    await ui.stop()
  }
})

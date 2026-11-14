import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startMockIlink, userMessage, waitFor } from './mock-ilink.mjs'
import { WeChatClawbot } from '../src/clawbot.js'
import { normalizeConfig } from '../src/index.js'
import { createLogger } from '../src/log.js'

const log = createLogger('silent')

function fakeBridge(reply) {
  const calls = []
  return {
    calls,
    async runTurn(peer, text) {
      calls.push({ peer, text })
      return reply(text)
    },
    async stop() {
      return true
    },
    async reset() {
      return true
    },
    async disposeAll() {},
  }
}

async function withBot({ messages, bridge, config = {} }, run) {
  const mock = await startMockIlink({ messages })
  const dir = await mkdtemp(join(tmpdir(), 'wechat-clawbot-'))
  const bot = new WeChatClawbot({
    ctx: {},
    config: normalizeConfig({
      baseUrl: mock.base,
      stateDir: dir,
      typing: false,
      autoLogin: true,
      pollTimeoutMs: 1500,
      logLevel: 'silent',
      ...config,
    }),
    log,
    bridge,
  })
  try {
    await bot.start()
    await run({ mock, bot, dir })
  } finally {
    await bot.stop()
    await mock.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('登录 → 收消息 → 回复', async () => {
  const bridge = fakeBridge((text) => `回声：${text}`)
  await withBot({ messages: [userMessage({ text: '在吗' })], bridge }, async ({ mock }) => {
    const arrived = await waitFor(() => mock.received.length > 0)
    assert.ok(arrived, '插件应该在收到消息后回一条')
    assert.equal(mock.sentTexts()[0], '回声：在吗')
    assert.equal(mock.received[0].msg.to_user_id, 'wx-user-1')
    assert.equal(mock.received[0].msg.context_token, 'ctx-1')
    assert.equal(bridge.calls[0].text, '在吗')
  })
})

test('同一条消息只处理一次', async () => {
  const message = userMessage({ id: 'dup-1', text: '重复' })
  const bridge = fakeBridge((text) => `回声：${text}`)
  await withBot({ messages: [message, { ...message }], bridge }, async ({ mock }) => {
    assert.ok(await waitFor(() => mock.received.length > 0))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(mock.received.length, 1)
    assert.equal(bridge.calls.length, 1)
  })
})

test('bot 自己发的消息不回（防自问自答）', async () => {
  const bridge = fakeBridge((text) => `回声：${text}`)
  const fromBot = userMessage({ type: 2, text: '我是 bot' })
  await withBot({ messages: [fromBot], bridge }, async ({ mock }) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(mock.received.length, 0)
    assert.equal(bridge.calls.length, 0)
  })
})

test('/help 直接回帮助，不进模型', async () => {
  const bridge = fakeBridge((text) => `回声：${text}`)
  await withBot({ messages: [userMessage({ text: '/help' })], bridge }, async ({ mock }) => {
    assert.ok(await waitFor(() => mock.received.length > 0))
    assert.match(mock.sentTexts()[0], /\/new/)
    assert.equal(bridge.calls.length, 0)
  })
})

test('/new 清空上下文', async () => {
  const bridge = fakeBridge((text) => `回声：${text}`)
  await withBot({ messages: [userMessage({ text: '/new' })], bridge }, async ({ mock, bot }) => {
    assert.ok(await waitFor(() => mock.received.length > 0))
    assert.match(mock.sentTexts()[0], /上下文清空/)
    assert.match(bot.state.data.peers['wx-user-1'].sessionId, /^wechat-[0-9a-f]{12}-[0-9a-f]{6}$/)
  })
})

test('白名单之外的用户被忽略', async () => {
  const bridge = fakeBridge((text) => `回声：${text}`)
  await withBot(
    { messages: [userMessage({ text: 'hi' })], bridge, config: { allowUsers: ['someone-else'] } },
    async ({ mock }) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(mock.received.length, 0)
      assert.equal(bridge.calls.length, 0)
    },
  )
})

test('长回复被截断，只发一条', async () => {
  const long = 'x'.repeat(5000)
  const bridge = fakeBridge(() => long)
  await withBot({ messages: [userMessage({ text: '写长一点' })], bridge, config: { maxReplyChars: 100 } }, async ({ mock }) => {
    assert.ok(await waitFor(() => mock.received.length > 0))
    assert.equal(mock.received.length, 1)
    const text = mock.sentTexts()[0]
    assert.ok(text.startsWith('x'.repeat(100)))
    assert.match(text, /截断了 4900 字/)
  })
})

test('凭证已保存时不再扫码', async () => {
  const mock = await startMockIlink({ messages: [userMessage({ text: 'hi' })] })
  const dir = await mkdtemp(join(tmpdir(), 'wechat-clawbot-'))
  const bot = new WeChatClawbot({
    ctx: {},
    config: normalizeConfig({
      baseUrl: mock.base,
      stateDir: dir,
      typing: false,
      autoLogin: false, // 没有凭证 + 不允许扫码 → 不启动
      logLevel: 'silent',
      pollTimeoutMs: 1000,
    }),
    log,
    bridge: fakeBridge((text) => `回声：${text}`),
  })
  try {
    await bot.start()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(mock.calls.length, 0, '没有凭证又禁止扫码时不应该发任何请求')
  } finally {
    await bot.stop()
    await mock.close()
    await rm(dir, { recursive: true, force: true })
  }
})

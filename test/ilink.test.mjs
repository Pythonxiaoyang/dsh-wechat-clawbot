import assert from 'node:assert/strict'
import test from 'node:test'

import { startMockIlink, userMessage } from './mock-ilink.mjs'
import {
  describeNonText,
  extractText,
  getBotQrcode,
  getQrcodeStatus,
  getUpdates,
  isOk,
  isRateLimited,
  isSessionExpired,
  messageIdOf,
  sendText,
} from '../src/ilink.js'

test('扫码：取二维码 → 轮询到 confirmed', async () => {
  const mock = await startMockIlink()
  try {
    const qr = await getBotQrcode({ baseUrl: mock.base })
    assert.equal(qr.qrcode, 'qr-1')
    assert.equal(qr.qrcode_img_content, 'https://example.invalid/scan/qr-1')

    const status = await getQrcodeStatus({ baseUrl: mock.base, qrcode: qr.qrcode })
    assert.equal(status.status, 'confirmed')
    assert.match(status.bot_token, /@im\.bot:/)
    assert.equal(status.baseurl, mock.base)

    const qrCall = mock.calls.find((call) => call.path === '/ilink/bot/get_bot_qrcode')
    assert.equal(qrCall.method, 'POST')
    assert.match(qrCall.query, /bot_type=3/)
    assert.deepEqual(qrCall.body, { local_token_list: [] })
    assert.equal(qrCall.headers['ilink-app-id'], 'bot')
  } finally {
    await mock.close()
  }
})

test('getupdates：带游标、解析消息', async () => {
  const mock = await startMockIlink({ messages: [userMessage({ text: '在吗' })] })
  try {
    const first = await getUpdates({ baseUrl: mock.base, token: 't', cursor: '' })
    assert.equal(first.msgs.length, 1)
    assert.equal(extractText(first.msgs[0]), '在吗')
    assert.equal(first.get_updates_buf, 'cursor-0')

    const call = mock.calls.at(-1)
    assert.match(call.headers.authorization, /^Bearer t$/)
    assert.equal(call.body.get_updates_buf, '')
    assert.ok(call.body.base_info.channel_version)
    assert.ok(call.body.base_info.bot_agent)

    const second = await getUpdates({ baseUrl: mock.base, token: 't', cursor: first.get_updates_buf })
    assert.equal(second.msgs.length, 0)
    assert.equal(mock.calls.at(-1).body.get_updates_buf, 'cursor-0')
  } finally {
    await mock.close()
  }
})

test('sendmessage：文本消息体字段正确', async () => {
  const mock = await startMockIlink()
  try {
    const response = await sendText({
      baseUrl: mock.base,
      token: 't',
      to: 'wx-user-1',
      text: '你好呀',
      contextToken: 'ctx-9',
    })
    assert.equal(isOk(response), true)
    const body = mock.received[0]
    assert.equal(body.msg.to_user_id, 'wx-user-1')
    assert.equal(body.msg.from_user_id, '')
    assert.equal(body.msg.message_type, 2)
    assert.equal(body.msg.message_state, 2)
    assert.equal(body.msg.context_token, 'ctx-9')
    assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '你好呀' } }])
    assert.ok(body.msg.client_id)
    assert.ok(body.base_info.bot_agent)
  } finally {
    await mock.close()
  }
})

test('错误码判定：-2 限流、-14 会话失效', () => {
  assert.equal(isOk({ ret: 0 }), true)
  assert.equal(isOk({ ret: '0', errcode: '0' }), true)
  assert.equal(isOk({ ret: 1 }), false)
  assert.equal(isOk({ errcode: -14 }), false)
  assert.equal(isRateLimited({ ret: -2 }), true)
  assert.equal(isRateLimited({ errcode: '-2' }), true)
  assert.equal(isSessionExpired({ errcode: -14 }), true)
  assert.equal(isSessionExpired({ ret: -14 }), true)
  assert.equal(isSessionExpired({ ret: -2 }), false)
})

test('消息解析：文本 / 非文本 / 消息 id', () => {
  assert.equal(extractText(userMessage({ text: ' hi ' })), ' hi ')
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: '语音转文字' } }] }), '语音转文字')
  assert.equal(extractText({ item_list: [{ type: 2 }] }), '')
  assert.equal(describeNonText({ item_list: [{ type: 2 }] }), '图片')
  assert.equal(messageIdOf({ message_id: 'abc' }), 'abc')
  assert.equal(messageIdOf({ item_list: [{ msg_id: 'item-1' }] }), 'item-1')
  assert.equal(messageIdOf({}), '')
})

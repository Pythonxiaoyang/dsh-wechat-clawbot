import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentBridge, assistantTextOf, lastAssistantText, sessionIdFor } from '../src/bridge.js'

/** 一套最小的假 ctx.agents / ctx.sessions。 */
function makeFakeRuntime({ resumeFails = true, resumeError = 'not found' } = {}) {
  const live = new Map()
  const sessions = new Map()
  const followups = []
  const created = []
  let disposed = 0

  const makeSession = (sessionId) => {
    const messages = []
    sessions.set(sessionId, {
      messages,
      deriveMessages: () => messages.slice(),
    })
    return sessions.get(sessionId)
  }

  const makeAgent = (sessionId) => {
    const session = makeSession(sessionId)
    let pending = Promise.resolve()
    const agent = {
      sessionId,
      followup(input) {
        followups.push({ sessionId, input })
        pending = Promise.resolve().then(() => {
          session.messages.push({ role: 'user', content: input.content, source: input.source })
          session.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: `收到：${input.content[0].text}` }],
          })
        })
      },
      async whenIdle() {
        await pending
      },
      cancel() {},
    }
    live.set(sessionId, agent)
    return agent
  }

  const agents = {
    get: (id) => live.get(id),
    async resume(options) {
      if (resumeFails) throw new Error(`session "${options.resumeSessionId}" ${resumeError}`)
      const id = options.resumeSessionId
      if (!id) throw new Error('resume 需要 resumeSessionId')
      created.push({ sessionId: id, agentOptions: options.agentOptions, resume: true })
      const agent = makeAgent(id)
      return {
        agent,
        dispose: async () => {
          disposed += 1
          live.delete(id)
        },
      }
    },
    async create(options) {
      created.push(options)
      const agent = makeAgent(options.sessionId)
      return {
        agent,
        dispose: async () => {
          disposed += 1
          live.delete(options.sessionId)
        },
      }
    },
  }

  return {
    agents,
    sessions: { get: (id) => sessions.get(id) },
    followups,
    created,
    get disposed() {
      return disposed
    },
  }
}

test('sessionIdFor：同一 peer 稳定，不同 peer 不同', () => {
  assert.equal(sessionIdFor('wx-a'), sessionIdFor('wx-a'))
  assert.notEqual(sessionIdFor('wx-a'), sessionIdFor('wx-b'))
  assert.match(sessionIdFor('wx-a'), /^wechat-[0-9a-f]{12}$/)
  assert.match(sessionIdFor('wx-a', 'wx'), /^wx-[0-9a-f]{12}$/)
})

test('assistantTextOf / lastAssistantText：只取文本块', () => {
  assert.equal(assistantTextOf({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(assistantTextOf({ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }] }), '')
  assert.equal(assistantTextOf({ role: 'user', content: [{ type: 'text', text: 'x' }] }), '')
  assert.equal(
    lastAssistantText([
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'tool', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'last' }] },
    ]),
    'last',
  )
})

test('runTurn：建会话、投递 user 消息、取回最终文本', async () => {
  const runtime = makeFakeRuntime()
  const bridge = new AgentBridge({
    agents: runtime.agents,
    sessions: runtime.sessions,
    sessionIdFor: (peer) => sessionIdFor(peer),
    resolveModel: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    resolveMeta: () => ({ cwd: 'D:/work' }),
  })

  const reply = await bridge.runTurn('wx-a', '你好')
  assert.equal(reply, '收到：你好')

  const created = runtime.created[0]
  assert.equal(created.sessionId, sessionIdFor('wx-a'))
  assert.deepEqual(created.agentOptions, { provider: 'deepseek', model: 'deepseek-flash' })
  assert.deepEqual(created.meta, { cwd: 'D:/work' })

  const input = runtime.followups[0].input
  assert.equal(input.role, 'user')
  assert.deepEqual(input.content, [{ type: 'text', text: '你好' }])
  assert.deepEqual(input.source, { kind: 'user' })

  // 第二轮复用同一个 agent，不再新建
  const second = await bridge.runTurn('wx-a', '再说一句')
  assert.equal(second, '收到：再说一句')
  assert.equal(runtime.created.length, 1)

  // 只取本轮新增的消息
  const third = await bridge.runTurn('wx-a', '第三轮')
  assert.equal(third, '收到：第三轮')
})

test('reset / disposeAll：释放会话', async () => {
  const runtime = makeFakeRuntime()
  const bridge = new AgentBridge({
    agents: runtime.agents,
    sessions: runtime.sessions,
    sessionIdFor: (peer) => sessionIdFor(peer),
  })

  await bridge.runTurn('wx-a', 'hi')
  assert.equal(await bridge.reset('wx-a'), true)
  assert.equal(runtime.disposed, 1)
  assert.equal(runtime.agents.get(sessionIdFor('wx-a')), undefined)

  await bridge.runTurn('wx-a', 'again')
  await bridge.disposeAll()
  assert.equal(runtime.disposed, 2)
})

test('resume 命中坏存档时换新会话 id，而不是卡死', async () => {
  const runtime = makeFakeRuntime({ resumeFails: true, resumeError: 'failed validation: event lacks an identified message' })
  let rotatedTo = ''
  const bridge = new AgentBridge({
    agents: runtime.agents,
    sessions: runtime.sessions,
    sessionIdFor: (peer) => sessionIdFor(peer),
    rotateSessionId: (peer) => {
      rotatedTo = `${sessionIdFor(peer)}-bad01`
      return rotatedTo
    },
  })
  const reply = await bridge.runTurn('wx-c', 'hi')
  assert.equal(reply, '收到：hi')
  assert.match(rotatedTo, /-bad01$/)
  assert.equal(runtime.created.at(-1).sessionId, rotatedTo)
})

test('resume 成功时不再 create，且用 resumeSessionId 入参', async () => {
  const runtime = makeFakeRuntime({ resumeFails: false })
  const bridge = new AgentBridge({
    agents: runtime.agents,
    sessions: runtime.sessions,
    sessionIdFor: (peer) => sessionIdFor(peer),
  })
  await bridge.runTurn('wx-b', 'hi')
  assert.equal(runtime.created.some((item) => !item.resume), false)
  assert.equal(runtime.created[0].sessionId, sessionIdFor('wx-b'))
  assert.equal(runtime.created[0].resume, true)
})

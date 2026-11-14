/**
 * 插件本地状态：bot 凭证、轮询游标、每个微信用户对应的 DSH 会话。
 *
 * 落盘位置默认 $DSH_HOME/storages/wechat-clawbot/state.json。
 * 文件里有 bot_token（等于这只 bot 的收发权限），因此按 0600 写，且只在
 * 内容变化时写盘（轮询每秒都在跑，不能每次都写磁盘）。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STATE_VERSION = 1

export function emptyState() {
  return {
    version: STATE_VERSION,
    botToken: '',
    baseUrl: '',
    botId: '',
    defaultTo: '',
    cursor: '',
    loggedInAt: 0,
    peers: {},
    seen: [],
  }
}

/** 合并磁盘内容与默认值，容忍旧版本缺字段。 */
export function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  return {
    ...base,
    ...raw,
    version: STATE_VERSION,
    peers: raw.peers && typeof raw.peers === 'object' ? raw.peers : {},
    seen: Array.isArray(raw.seen) ? raw.seen.filter((x) => typeof x === 'string') : [],
  }
}

export class PluginState {
  /** @param {string} file 绝对路径 */
  constructor(file) {
    this.file = file
    this.data = emptyState()
    this._savedJson = ''
    this._writing = null
    this._dirty = false
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      this.data = normalizeState(JSON.parse(text))
      this._savedJson = JSON.stringify(this.data)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this._savedJson = ''
    }
    return this.data
  }

  touch() {
    this._dirty = true
  }

  /** 串行、原子地写盘；内容没变则跳过。 */
  async save() {
    if (!this._dirty) return
    this._writing = (this._writing ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const json = JSON.stringify(this.data)
        this._dirty = false
        if (json === this._savedJson) return
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        await writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, this.file)
        try {
          await chmod(this.file, 0o600)
        } catch {
          /* Windows 上可能不支持，忽略 */
        }
        this._savedJson = json
      })
    return this._writing
  }

  /** 记一条已处理过的消息 id，避免重启后重放（只留最近 200 条）。 */
  markSeen(messageId) {
    if (!messageId) return false
    if (this.data.seen.includes(messageId)) return true
    this.data.seen.push(messageId)
    if (this.data.seen.length > 200) this.data.seen.splice(0, this.data.seen.length - 200)
    this.touch()
    return false
  }
}

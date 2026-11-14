/**
 * 极简日志：全部写 stderr，前缀 [wechat-clawbot]。
 * 不依赖 ctx.logger（不同宿主装载的 logger 形态不一定一致）。
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info

  const write = (tag, args) => {
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.stack ?? String(a)
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
    try {
      process.stderr.write(`[wechat-clawbot] ${tag}${text}\n`)
    } catch {
      /* stderr 关掉了也不能让插件崩 */
    }
  }

  return {
    level,
    error: (...args) => threshold >= LEVELS.error && write('ERROR ', args),
    warn: (...args) => threshold >= LEVELS.warn && write('WARN  ', args),
    info: (...args) => threshold >= LEVELS.info && write('', args),
    debug: (...args) => threshold >= LEVELS.debug && write('DEBUG ', args),
  }
}

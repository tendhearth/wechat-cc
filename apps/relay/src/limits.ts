/** 限额(spec §6)。房间内执行;测试用 env 字符串把它们调小。 */
export const LIMITS = {
  maxPhoneStreams: 16,
  maxFrameBytes: 512 * 1024,
  phoneRate: { capacity: 120, refillPerSec: 20 },
  daemonRate: { capacity: 1000, refillPerSec: 200 },
  dailyPushes: 500,
  dailyBytes: 1_000_000_000,
  loginTimeoutMs: 10_000,
  /** 手机流开着、daemon 一直没回过一帧(握手没完成)多久关掉。挡「知道 id 的人开满 16 条空流把主人的手机挡在外面」。 */
  phoneHandshakeMs: 15_000,
  maxPushRegistrations: 20,
  maxPendingLogins: 4,
}
export type Limits = typeof LIMITS

const num = (s: string | undefined, dflt: number): number => {
  const n = s === undefined ? NaN : Number(s)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export function limitsFrom(env: Env): Limits {
  return {
    ...LIMITS,
    dailyPushes: num(env.RELAY_DAILY_PUSHES, LIMITS.dailyPushes),
    dailyBytes: num(env.RELAY_DAILY_BYTES, LIMITS.dailyBytes),
    loginTimeoutMs: num(env.RELAY_LOGIN_TIMEOUT_MS, LIMITS.loginTimeoutMs),
    phoneHandshakeMs: num(env.RELAY_PHONE_HANDSHAKE_MS, LIMITS.phoneHandshakeMs),
  }
}

export interface TokenBucket { take(now: number): boolean }

export function makeBucket(capacity: number, refillPerSec: number): TokenBucket {
  let tokens = capacity
  let last: number | null = null
  return {
    take(now) {
      if (last !== null) tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec)
      last = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const enc = new TextEncoder()
/** 字符串的 UTF-8 字节数(直接编码一遍量;帧上限 512 KiB,这点开销可以接受)。 */
export function utf8Len(s: string): number {
  return enc.encode(s).byteLength
}

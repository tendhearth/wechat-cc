import { isDevPushToken } from './key-store'

// 只给开发构建的模拟器验证用(scripts/sim-push.ts):simctl push 不跑通知服务扩展,演示模式又没有配对 ⇒ app 没有兜底密钥,
// 点通知 / 前台横幅的兜底解密在模拟器上根本走不到。/dev-push-key 把合成的开发令牌记在内存里,PushRouter 没配对时拿它兜底;
// 但它推出的推送密钥是写进共享钥匙串的(会留下来,直到配对 / 解除配对 / 冷启动没配对时清掉)。
// 有配对永远用配对的设备令牌;发布构建里(dev=false)开发令牌一律不用。纯 TS,不引 react / expo。

export function fallbackPushToken(pairingToken: string | null | undefined, devTok: string | null, dev: boolean): string | null {
  if (pairingToken) return pairingToken
  return dev && devTok !== null && isDevPushToken(devTok) ? devTok : null
}

/**
 * /dev-push-key 该做什么:发布构建 ⇒ none;不是开发令牌形状 ⇒ rejected;
 * 已配对 ⇒ paired(不写:共享钥匙串里放着真配对推出的推送密钥,写了就把它顶掉);否则 apply。
 */
export function devPushKeyAction(dev: boolean, token: unknown, paired: boolean): 'none' | 'rejected' | 'paired' | 'apply' {
  if (!dev) return 'none'
  if (typeof token !== 'string' || !isDevPushToken(token)) return 'rejected'
  return paired ? 'paired' : 'apply'
}

export function makeDevPushToken() {
  let cur: string | null = null
  const subs = new Set<() => void>()
  return {
    get: (): string | null => cur,
    set(t: string) {
      if (!isDevPushToken(t) || t === cur) return
      cur = t
      for (const fn of subs) fn()
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
}

export const devPushToken = makeDevPushToken()

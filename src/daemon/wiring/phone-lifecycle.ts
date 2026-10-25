/**
 * 手机那一簇的关机收尾(重构第二批步 6d):隧道(TunnelClient.stop 会发 close 帧,中继立刻知道这台下线)、
 * 推送 notifier、手机订阅(phone-events)、设置面板的 HTTP。以前这些都没人停 —— self deploy 换 sidecar 时
 * 老进程还连着中继,中继要等超时才放。
 *
 * **按固定顺序停,不按加入的先后**:设置面板在 buildPipelineDeps 结尾同步加入,隧道 / notifier / 订阅要等异步 import
 * 回来才加入 —— 按先后停的话面板反而先停(wechat-cc-54 评审 #482)。顺序见 PHONE_STOP_ORDER:隧道先停(发 close 帧),
 * 面板最后(隧道在转它的请求)。只停一次;一处停坏了记一行、不挡后面的。
 * 关机先到、隧道后建 ⇒ add 时立刻停掉,不让它再连上去。
 */
export const PHONE_STOP_ORDER = ['media-mirror', 'v2-tunnel', 'notifier', 'push-gate', 'phone-events', 'settings-panel'] as const
export type PhoneStopName = typeof PHONE_STOP_ORDER[number]

export interface PhoneLifecycle {
  add(name: PhoneStopName, stop: () => void | Promise<void>): void
  stop(): Promise<void>
  stopped(): boolean
}

export function makePhoneLifecycle(log: (tag: string, line: string) => void): PhoneLifecycle {
  const stops: Array<{ name: PhoneStopName; stop: () => void | Promise<void> }> = []
  let done = false
  const run = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn() } catch (err) { log('PHONE', `stop ${name} failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
  return {
    add(name, stop) {
      if (done) { void run(name, stop); return }
      stops.push({ name, stop })
    },
    async stop() {
      if (done) return
      done = true
      const rank = (n: PhoneStopName) => PHONE_STOP_ORDER.indexOf(n)
      for (const s of [...stops].sort((a, b) => rank(a.name) - rank(b.name))) await run(s.name, s.stop)
    },
    stopped: () => done,
  }
}

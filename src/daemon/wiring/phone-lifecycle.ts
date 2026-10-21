/**
 * 手机那一簇的关机收尾(重构第二批步 6d):隧道(TunnelClient.stop 会发 close 帧,中继立刻知道这台下线)、
 * 推送 notifier、手机订阅(phone-events)、设置面板的 HTTP。以前这些都没人停 —— self deploy 换 sidecar 时
 * 老进程还连着中继,中继要等超时才放。
 *
 * 按加入的先后停,只停一次;一处停坏了记一行、不挡后面的。隧道是异步 import 之后才建的:
 * 关机先到、隧道后建 ⇒ add 时立刻停掉,不让它再连上去。
 */
export interface PhoneLifecycle {
  add(name: string, stop: () => void | Promise<void>): void
  stop(): Promise<void>
  stopped(): boolean
}

export function makePhoneLifecycle(log: (tag: string, line: string) => void): PhoneLifecycle {
  const stops: Array<{ name: string; stop: () => void | Promise<void> }> = []
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
      for (const s of stops) await run(s.name, s.stop)
    },
    stopped: () => done,
  }
}

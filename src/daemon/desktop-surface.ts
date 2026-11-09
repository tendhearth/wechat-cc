/**
 * desktop-surface.ts —— 桌面 app 这会儿开着没有(S3b,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 桌面 app 开着时每 3 秒来拉一次 `GET /v1/workbench/attention`(apps/desktop/src/modules/workbench-attention.js),
 * 它自己会为「回复了 / 停下了」弹系统通知 —— 但只为它**亲眼看到**「上一拍在做(working)、这一拍回复了 / 停下了」的那件
 * (progressTransitions)。所以这里照它的判法记一份:它会弹这件吗(`willAnnounce`)。一件事做完、主人在电脑前:它会弹 ⇒ 交给它;
 * 不会(没开,或者那件事在两拍之间就做完了、它没看见 working)⇒ daemon 自己弹
 * (lib/desktop-notify.ts),免得同一件事桌面上弹两下。只回答「桌面 app 在不在」,不回答「人在不在」(那是 owner-presence)。
 *
 * 还记「桌面读过哪件事的详情」(noteSeen):先只在桌面提示的那一件,到点读过了就不再推手机。**只在内存里**,不写 matter_bindings ——
 * 那张表会出现在一件事的详情里(读出形状要一字不变);升级只等 10 分钟,重启丢了就当没看过,宁可多推一次。
 */
export const DESKTOP_FRESH_MS = 20_000
const FINISHED = new Set(['replied', 'failed', 'interrupted'])
/** 记多少件「桌面读过」(多了丢最早的;升级只等 10 分钟,用不着长)。 */
export const MAX_SEEN = 512

export interface DesktopSurface {
  /** 桌面 app 来拉过一次;progress = 这一次回给它的各件 phase(attention 的 progress;老的没有)。 */
  notePoll(progress?: ReadonlyArray<{ id: string; phase: string }> | null): void
  /** 最近 DESKTOP_FRESH_MS 内来过。 */
  appConnected(): boolean
  /** 桌面 app 会(或刚)为这件事弹「回复了 / 停下了」:它上一拍看到它在做、这一拍看到做完了,或者最近一拍它还在做(下一拍就会弹)。 */
  willAnnounce(matterId: string): boolean
  /** 桌面读了这件事的详情。 */
  noteSeen(matterId: string): void
  seenVersion():number
  /** 这件事 sinceMs 以后桌面读过没有。 */
  seenSince(matterId: string, sinceMs: number): boolean
}

export function makeDesktopSurface(now: () => number = Date.now): DesktopSurface {
  let last = Number.NEGATIVE_INFINITY
  let seenVersion=0
  const seen = new Map<string, number>()
  let prev: Map<string, string> | null = null
  const announced = new Map<string, number>()
  return {
    notePoll(progress) {
      const t = now()
      last = t
      if (!Array.isArray(progress)) return
      const cur = new Map(progress.filter(p => p && typeof p.id === 'string' && typeof p.phase === 'string').map(p => [p.id, p.phase] as const))
      // 和桌面 progressTransitions 同一条判法:上一拍 working、这一拍 replied / failed / interrupted ⇒ 它弹了
      if (prev) for (const [id, phase] of cur) if (prev.get(id) === 'working' && FINISHED.has(phase)) { announced.delete(id); announced.set(id, t) }
      while (announced.size > MAX_SEEN) { const oldest = announced.keys().next().value; if (oldest === undefined) break; announced.delete(oldest) }
      prev = cur
    },
    appConnected() { return now() - last < DESKTOP_FRESH_MS },
    willAnnounce(id) {
      const at = announced.get(id)
      if (at !== undefined && now() - at < DESKTOP_FRESH_MS) return true
      return prev?.get(id) === 'working'
    },
    seenVersion:()=>seenVersion,
    noteSeen(id) {
      seenVersion++
      seen.delete(id); seen.set(id, now())
      while (seen.size > MAX_SEEN) { const oldest = seen.keys().next().value; if (oldest === undefined) break; seen.delete(oldest) }
    },
    seenSince(id, sinceMs) { const at = seen.get(id); return at !== undefined && at >= sinceMs },
  }
}

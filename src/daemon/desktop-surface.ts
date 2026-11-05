/**
 * desktop-surface.ts —— 桌面 app 这会儿开着没有(S3b,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 桌面 app 开着时每 3 秒来拉一次 `GET /v1/workbench/attention`(apps/desktop/src/modules/workbench-attention.js),
 * 它自己会为「回复了 / 停下了」弹系统通知。一件事做完、主人在电脑前:桌面 app 开着 ⇒ 交给它弹;没开 ⇒ daemon 自己弹
 * (lib/desktop-notify.ts),免得同一件事桌面上弹两下。只回答「桌面 app 在不在」,不回答「人在不在」(那是 owner-presence)。
 *
 * 还记「桌面读过哪件事的详情」(noteSeen):先只在桌面提示的那一件,到点读过了就不再推手机。**只在内存里**,不写 matter_bindings ——
 * 那张表会出现在一件事的详情里(读出形状要一字不变);升级只等 10 分钟,重启丢了就当没看过,宁可多推一次。
 */
export const DESKTOP_FRESH_MS = 20_000
/** 记多少件「桌面读过」(多了丢最早的;升级只等 10 分钟,用不着长)。 */
export const MAX_SEEN = 512

export interface DesktopSurface {
  /** 桌面 app 来拉过一次。 */
  notePoll(): void
  /** 最近 DESKTOP_FRESH_MS 内来过。 */
  appConnected(): boolean
  /** 桌面读了这件事的详情。 */
  noteSeen(matterId: string): void
  /** 这件事 sinceMs 以后桌面读过没有。 */
  seenSince(matterId: string, sinceMs: number): boolean
}

export function makeDesktopSurface(now: () => number = Date.now): DesktopSurface {
  let last = Number.NEGATIVE_INFINITY
  const seen = new Map<string, number>()
  return {
    notePoll() { last = now() },
    appConnected() { return now() - last < DESKTOP_FRESH_MS },
    noteSeen(id) {
      seen.delete(id); seen.set(id, now())
      while (seen.size > MAX_SEEN) { const oldest = seen.keys().next().value; if (oldest === undefined) break; seen.delete(oldest) }
    },
    seenSince(id, sinceMs) { const at = seen.get(id); return at !== undefined && at >= sinceMs },
  }
}

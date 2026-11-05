/**
 * desktop-surface.ts —— 桌面 app 这会儿开着没有(S3b,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 桌面 app 开着时每 3 秒来拉一次 `GET /v1/workbench/attention`(apps/desktop/src/modules/workbench-attention.js),
 * 它自己会为「回复了 / 停下了」弹系统通知。一件事做完、主人在电脑前:桌面 app 开着 ⇒ 交给它弹;没开 ⇒ daemon 自己弹
 * (lib/desktop-notify.ts),免得同一件事桌面上弹两下。只回答「桌面 app 在不在」,不回答「人在不在」(那是 owner-presence)。
 */
export const DESKTOP_FRESH_MS = 20_000

export interface DesktopSurface {
  /** 桌面 app 来拉过一次。 */
  notePoll(): void
  /** 最近 DESKTOP_FRESH_MS 内来过。 */
  appConnected(): boolean
}

export function makeDesktopSurface(now: () => number = Date.now): DesktopSurface {
  let last = Number.NEGATIVE_INFINITY
  return {
    notePoll() { last = now() },
    appConnected() { return now() - last < DESKTOP_FRESH_MS },
  }
}

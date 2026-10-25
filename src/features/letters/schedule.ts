/**
 * CC 的信(2026-10-16):什么时候写下一封。纯函数,时钟与随机数由调用方传。
 *
 * 「无缘无故」是这件事的全部价值 —— 每月 1 号准时到就成了账单。所以:
 *   - 间隔是一段随机天数(第一封 2–5 天,之后 24–38 天),主人猜不到哪天;
 *   - 只在主人时区的傍晚窗口里落笔(19:30–22:30),错过了(电脑睡着)就等下一个傍晚;
 *   - 素材不够(没什么可写)不硬写,过几天再看。
 */
import { localParts } from '../../lib/local-time'

export const DAY_MS = 86_400_000
export const FIRST_GAP_DAYS: readonly [number, number] = [2, 5]
export const GAP_DAYS: readonly [number, number] = [24, 38]
/** 素材不够时,过几天再看。 */
export const THIN_RETRY_DAYS = 3
export const WINDOW_START = '19:30'
export const WINDOW_END = '22:30'

/** [lo, hi] 天里随机一个时刻(毫秒精度,不对齐整天 —— 落笔时刻再由傍晚窗口决定)。 */
export function nextDueAt(fromMs: number, range: readonly [number, number], random: () => number = Math.random): number {
  const [lo, hi] = range
  return fromMs + Math.round((lo + random() * (hi - lo)) * DAY_MS)
}

export function inEveningWindow(nowMs: number, tz: string): boolean {
  const { hhmm } = localParts(nowMs, tz)
  return hhmm >= WINDOW_START && hhmm < WINDOW_END
}

export function isLetterDue(o: { nowMs: number; tz: string; dueAt: number | null }): boolean {
  return o.dueAt !== null && o.nowMs >= o.dueAt && inEveningWindow(o.nowMs, o.tz)
}

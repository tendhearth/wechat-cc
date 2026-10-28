/**
 * 回合看门狗(collectTurn:多久没事件就判这一轮卡死)的时长,从 WECHAT_TURN_TIMEOUT_MS 读,缺省 10 分钟,0 = 关。
 * bootstrap 与 terminal_say(等终端回话不能等过它,2026-10-24)读同一份;main.ts 心跳那里有一份照抄的。
 */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000

export function turnTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['WECHAT_TURN_TIMEOUT_MS']
  if (raw == null || raw === '') return DEFAULT_TURN_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TURN_TIMEOUT_MS
}

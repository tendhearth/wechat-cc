/**
 * owner-presence.ts —— 「主人这会儿在不在电脑前」(S3b,设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md)。
 *
 * 从终端会话那份推广来的(app/cli-events.ts,spec 2026-09-09-cli-hook-push §5):本机上次键鼠输入距今不足 PRESENT_IDLE_S 秒
 * ⇒ 有人在用这台电脑。探不到(探针失败 / 平台不支持)⇒ 当作**不在**:宁可推手机,不漏。
 */
/** 机器上次键鼠输入距今不足这么多秒 ⇒ 有人在用这台电脑(终端会话与一件事的提议同一个阈值)。 */
export const PRESENT_IDLE_S = 120

export interface OwnerPresence {
  atDesk(): Promise<boolean>
}

export function makeOwnerPresence(d: { machineIdle: () => Promise<number | null> }): OwnerPresence {
  return {
    async atDesk() {
      try {
        const idle = await d.machineIdle()
        return idle !== null && idle < PRESENT_IDLE_S
      } catch {
        return false
      }
    },
  }
}

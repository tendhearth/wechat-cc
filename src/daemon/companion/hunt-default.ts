/**
 * 打猎改成默认关(收敛清单 ②,主人 2026-10-21 定)的一次性开机步骤。
 *
 * 以前 chat-prefs 的 `hunt` 没设过 ⇒ 开。改成「没设过 ⇒ 关」以后,已经在每天打猎的主人(主动关心开着、从没单独设过打猎)
 * 不能跟着被关掉 —— 所以第一次带着新默认开机时,**主动关心开着、主人那条对话没设过打猎** ⇒ 写成显式的 `hunt: true`。
 * 别的情况(新装 / 主动关心没开 / 主人自己设过开或关)本来就没在打猎或已有明确选择,不动。
 * 只做一次:做完在 companion/ 下留一个标记文件;之后主人自己再怎么改都不会被改回来。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatPrefsStore } from '../chat-prefs'

export const HUNT_DEFAULT_MARKER = 'hunt-default-off-v2'

export function pinHuntForExistingOwner(d: {
  stateDir: string
  chatPrefs: Pick<ChatPrefsStore, 'get' | 'set'>
  companion: { enabled: boolean; default_chat_id: string | null }
  log: (tag: string, line: string) => void
}): 'pinned' | 'nothing' | 'already' {
  const dir = join(d.stateDir, 'companion')
  const marker = join(dir, HUNT_DEFAULT_MARKER)
  if (existsSync(marker)) return 'already'
  let result: 'pinned' | 'nothing' = 'nothing'
  const owner = d.companion.default_chat_id
  if (d.companion.enabled && owner && d.chatPrefs.get(owner).hunt === undefined) {
    d.chatPrefs.set(owner, { hunt: true })
    result = 'pinned'
    d.log('COMPANION', 'hunt default is now off for new installs — kept the owner\'s daily hunt on (was the old default)')
  }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(marker, new Date().toISOString()) } catch (err) {
    // 写不了标记 ⇒ 下次开机再判一次;判的结果一样(已经是显式 true 了 ⇒ 不再动),所以重复无害
    d.log('COMPANION', `hunt-default marker not written: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

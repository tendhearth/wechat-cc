/**
 * 打猎改成默认关(收敛清单 ②,主人 2026-10-21 定)的一次性开机步骤。
 *
 * 以前 chat-prefs 的 `hunt` 没设过 ⇒ 开。改成「没设过 ⇒ 关」以后,已经在每天打猎的主人(主动关心开着、从没单独设过打猎)
 * 不能跟着被关掉 —— 所以第一次带着新默认开机时,**主动关心开着、主人那条对话没设过打猎** ⇒ 写成显式的 `hunt: true`。
 * 别的情况(新装 / 主动关心没开 / 主人自己设过开或关)本来就没在打猎或已有明确选择,不动。
 * 只做一次:做完在 companion/ 下留一个标记文件;之后主人自己再怎么改都不会被改回来。
 *
 * **只有真的判过才留标记**:伙伴配置不存在(新装)或读到了合法的 `enabled`。配置在但读坏了(半写 / 权限 / TCC)时
 * 不能用 loadCompanionConfig —— 它会静默退回默认值(enabled 是默认、default_chat_id 是 null),判成「不动」再留标记,
 * 主人的每日打猎就永远关了、没人知道(整合者评审 #504)。所以这里自己读原文,读坏了就不判、不留标记,下次开机再判。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import type { ChatPrefsStore } from '../chat-prefs'
import { configPath } from './paths'

export const HUNT_DEFAULT_MARKER = 'hunt-default-off-v2'

type CompanionView = { kind: 'missing' } | { kind: 'ok'; enabled: boolean; ownerChatId: string | null } | { kind: 'unreadable'; why: string }

function readCompanionView(stateDir: string): CompanionView {
  const p = configPath(stateDir)
  if (!existsSync(p)) return { kind: 'missing' }
  let parsed: unknown
  try { parsed = readJsonFile(p) } catch (err) { return { kind: 'unreadable', why: err instanceof Error ? err.message : String(err) } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'unreadable', why: 'not an object' }
  const o = parsed as Record<string, unknown>
  if (typeof o.enabled !== 'boolean') return { kind: 'unreadable', why: 'enabled is not a boolean' }
  return { kind: 'ok', enabled: o.enabled, ownerChatId: typeof o.default_chat_id === 'string' && o.default_chat_id ? o.default_chat_id : null }
}

export function pinHuntForExistingOwner(d: {
  stateDir: string
  chatPrefs: Pick<ChatPrefsStore, 'get' | 'set'>
  log: (tag: string, line: string) => void
}): 'pinned' | 'nothing' | 'already' | 'unreadable' {
  const dir = join(d.stateDir, 'companion')
  const marker = join(dir, HUNT_DEFAULT_MARKER)
  if (existsSync(marker)) return 'already'
  const view = readCompanionView(d.stateDir)
  if (view.kind === 'unreadable') {
    d.log('COMPANION', `hunt-default: companion config unreadable (${view.why}) — not deciding this boot, will retry next boot`)
    return 'unreadable'
  }
  let result: 'pinned' | 'nothing' = 'nothing'
  if (view.kind === 'ok' && view.enabled && view.ownerChatId && d.chatPrefs.get(view.ownerChatId).hunt === undefined) {
    d.chatPrefs.set(view.ownerChatId, { hunt: true })
    result = 'pinned'
    d.log('COMPANION', 'hunt default is now off for new installs — kept the owner\'s daily hunt on (was the old default)')
  }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(marker, new Date().toISOString()) } catch (err) {
    // 写不了标记 ⇒ 下次开机再判一次;判的结果一样(已经是显式 true 了 ⇒ 不再动),所以重复无害
    d.log('COMPANION', `hunt-default marker not written: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

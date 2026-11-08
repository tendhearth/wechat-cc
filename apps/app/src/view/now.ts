import type { ChatPageT } from '../backend/types'
import { markdownPlainText } from '@wechat-cc/markdown'

// 系统通知不是 CC 说的话(2026-10-18 真机:气泡挂着两周前的「🔄 wechat-cc daemon 已重启 pid=…」):
// 🔄 重启通知、🔔 终端会话完成推送、✅ / ❌ 命令回执。打猎 🎯、串门 🚶 是 CC 自己的话,照常。
const SYSTEM_NOTICE = /^(🔄|🔔|✅|❌)/u

/** CC 气泡:主人那条对话里最近一条 CC 说的话(跳过系统通知)。没有就是 null —— 不画空气泡、不编客套话。 */
export function latestCCLine(page: ChatPageT | undefined): { id: string; text: string; at: number } | null {
  if (!page) return null
  for (let i = page.messages.length - 1; i >= 0; i--) {
    const m = page.messages[i]!
    if (m.role === 'cc' && !SYSTEM_NOTICE.test(m.text.trimStart())) {
      const text = markdownPlainText(m.text).trim()
      if (text !== '') return { id: m.id, text, at: m.at }
    }
  }
  return null
}

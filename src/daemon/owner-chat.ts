/**
 * 主人是哪个对话:access.json 里唯一的 admin(没有就看 companion.default_chat_id)。每次现算 —— 手改了配置不用重启。
 * 模块表里好几个模块都要它(以前是 daemon-modules.ts 顶上的两个闭包;各功能的接线搬进 `src/features/<名>/module.ts` 时收到这里)。
 */
import { loadAccess } from '../lib/access'
import { loadCompanionConfig } from '../lib/companion-config'
import { resolveAdminChatId } from './companion/resolve-admin'

export function ownerChatIdOf(stateDir: string): string | null {
  return resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
}

export function isOwnerOf(stateDir: string): (chatId: string) => boolean {
  return (chatId) => ownerChatIdOf(stateDir) === chatId
}

/** 主人那条会话在 SessionManager 里的键(从 pipeline-deps.ts 搬出来,重构第二批步 6c:converse 与桌宠两处共用)。 */
import type { Mode, ProviderId } from '../../domain/conversation'

export interface OwnerSessionKeyDeps {
  resolveProject: (chatId: string) => { alias: string; path: string } | null
  getMode: (chatId: string) => Mode
  defaultProviderId: ProviderId
}

/**
 * Resolves the (alias, providerId) session-manager key for a chat the SAME
 * way ConversationCoordinator.dispatch resolves it internally (resolveProject
 * + mode → provider), mirroring the provider-derivation chain tick-bodies.ts's
 * dispatchToChat uses before its own isInFlight check. Exported/pure so the
 * app-conversation-channel in-flight guard (companionConverse below) is unit
 * testable without constructing a full Bootstrap.
 *
 * Used to check SessionManager.isInFlight with the EXACT key a real dispatch
 * will acquire — so an app /converse turn (companionConverse) refuses to
 * start while a WeChat turn is in flight on the owner's session. Without
 * this, a WeChat message and an app /converse racing on the owner's
 * default_chat_id both resolve the same SessionManager handle and dispatch
 * concurrently on one AgentSession → corruption (e.g. the openai provider
 * pushes to a shared mutable history array with no self-guard). Spec §3
 * (app-conversation-channel Task 2, HIGH review finding).
 *
 * Returns null when the chat has no resolvable project — dispatch would
 * drop the message in that case too, so there's nothing to guard.
 */
export function resolveOwnerSessionKey(chatId: string, deps: OwnerSessionKeyDeps): { alias: string; providerId: ProviderId } | null {
  const proj = deps.resolveProject(chatId)
  if (!proj) return null
  const mode = deps.getMode(chatId)
  const providerId =
    mode.kind === 'solo' ? mode.provider
    : mode.kind === 'primary_tool' ? mode.primary
    : (mode.participants?.[0] ?? deps.defaultProviderId)
  return { alias: proj.alias, providerId }
}

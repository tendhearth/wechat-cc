// @ts-check
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { escapeHtml } from '../view.js'
import { V1, v1 } from '../daemon-client.js'
import { executorName } from './executor-names.js'

const AGENTS = createAgentAvatars()
/** @param {Record<string,string>} names @param {string} provider */
export const replyAgentName = (names,provider) => Object.hasOwn(names,provider) && typeof names[provider] === 'string' ? names[provider] : executorName(provider)
/** @typedef {{speaker?:string,provider?:string,model?:string,agentId?:string}} ReplyAttribution */
/** Only explicit per-reply attribution can identify an agent. @param {ReplyAttribution} reply */
export function replyProvider(reply) {
  return reply.speaker === 'agent' && typeof reply.provider === 'string' && reply.provider.trim() ? reply.provider : ''
}
/** @param {unknown} value @returns {ReplyAttribution} */
export function replyAttribution(value) {
  if (!value || typeof value !== 'object') return {}
  const raw = /** @type {Record<string,unknown>} */ (value)
  return Object.fromEntries(['speaker','provider','model','agentId'].flatMap(key => typeof raw[key] === 'string' ? [[key,raw[key]]] : []))
}
/** @param {ReplyAttribution} reply @param {Record<string,string>} names */
export function replyAvatarHtml(reply, names) {
  const provider = replyProvider(reply)
  if (!provider) return ''
  const glyph = provider !== 'openai' && AGENTS.agentGlyph(provider) ? provider : 'service'
  const name = escapeHtml(replyAgentName(names,provider))
  // Service is a fixed generic mark; a custom gateway name changes labels only.
  const avatar = AGENTS.agentAvatarHtml(glyph, () => glyph === 'service' ? 'AI 服务' : replyAgentName(names,provider), 1)
  return `<span class="th-agents" data-reply-provider="${escapeHtml(provider)}" role="img" aria-label="${name}" title="${name}">${avatar}</span>`
}
/** Late names must not replace text, selection, attachments or disclosure nodes.
 * @param {HTMLElement} root @param {Record<string,string>} names */
export function updateReplyAvatarNames(root, names) {
  for (const avatar of root.querySelectorAll?.('[data-reply-provider]') ?? []) {
    const provider = avatar.getAttribute('data-reply-provider') ?? ''
    const name = replyAgentName(names,provider)
    avatar.setAttribute('aria-label', name); avatar.setAttribute('title', name)
    avatar.closest('.converse-msg')?.setAttribute('aria-label', name)
  }
}
/** Display names are optional; never infer historical identity from the selected model.
 * @param {(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>} transport
 * @returns {Promise<Record<string,string>>} */
export async function loadReplyAgentNames(transport) {
  try {
    const data = /** @type {{providers?:Array<{id?:unknown,name?:unknown}>}|null} */ (await v1(transport, V1.matter.ownerChatModel))
    return Object.fromEntries((Array.isArray(data?.providers) ? data.providers : []).flatMap(p =>
      p && typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim() ? [[p.id,p.name]] : []))
  } catch { return {} }
}

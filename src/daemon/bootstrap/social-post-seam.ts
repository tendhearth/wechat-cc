/**
 * social-post-seam.ts — 出站 /a2a/intent 与 /a2a/echo 的那一次投递。
 * 从 wireSocial 里抽出来,唯一目的是**能被单测打到**:它在闭包里的时候,
 * 「信箱掉了包」这条路径一次都没被测过。传输选择仍走 chooseTransport
 * (见 mailbox-dispatch-seam.ts),这里只负责「投出去,并如实说发生了什么」。
 */
import { chooseTransport } from './mailbox-dispatch-seam'
import type { A2AAgentRecord } from '../../lib/agent-config'
import type { PeerMailbox } from '../../core/mailbox-crypto'

export type SocialPath = '/a2a/intent' | '/a2a/echo'

/**
 * 一次投递的结果 —— **两个布尔,不是一个**。
 *
 * WHY(2026-09-01):原来只返回一个 boolean,信箱腿上恒为 `true`,注释说
 * 这是有意的:「asked 的意思是尝试过」,派心愿统计问了几个人时确实该这样。
 * 但同一个返回值被回声腿拿去当「送到了没有」用,于是 async-responder 里
 * 那句 `if (!ok) log('echo post dropped')` 对信箱对端**永远不会触发** ——
 * 明信片掉了,日志里一个字都没有,答话的一方还留着 pledge 行以为自己回过了。
 *
 * 两个语义就是两个字段:
 * - `asked`     我尝试过(派心愿的扇出计数用这个:store-and-forward 投出去
 *               就算问过了,对方什么时候取件不归我管)
 * - `delivered` 中继/对端真的收下了(回声、以及任何需要「没送到就要补」的
 *               地方用这个)
 */
export interface PostOutcome { asked: boolean; delivered: boolean }

export interface SocialPostDeps {
  selfId: string
  mailboxSend(req: { path: string; bearer: string; body: unknown }, peer: PeerMailbox): Promise<boolean>
  pushSend(req: { url: string; bearer: string; body: unknown }): Promise<{ ok: boolean }>
  /** path → 完整 URL(wire-social 的 intentUrl / echoUrl)。 */
  urlFor(path: SocialPath, base: string): string
  /** 活动流事件;`ok` 记的是**真实**投递结果,不是 asked。 */
  recordEvent(agentId: string, path: SocialPath, ok: boolean): void
  log(tag: string, line: string): void
}

export function makeSocialPost(deps: SocialPostDeps) {
  return async function post(hand: A2AAgentRecord, path: SocialPath, body: Record<string, unknown>): Promise<PostOutcome> {
    const route = chooseTransport(hand)
    if (route.kind === 'unreachable') return { asked: false, delivered: false }
    const payload = { agent_id: deps.selfId, ...body }
    if (route.kind === 'mailbox') {
      let dropped = false
      try {
        dropped = await deps.mailboxSend({ path, bearer: hand.outbound_api_key, body: payload }, route.peer)
      } catch (err) {
        deps.log('SOCIAL_REC', `mailbox ${path} drop failed agent=${hand.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      deps.recordEvent(hand.id, path, dropped)
      return { asked: true, delivered: dropped }
    }
    const r = await deps.pushSend({ url: deps.urlFor(path, route.url), bearer: hand.outbound_api_key, body: payload })
    deps.recordEvent(hand.id, path, r.ok)
    return { asked: r.ok, delivered: r.ok }
  }
}

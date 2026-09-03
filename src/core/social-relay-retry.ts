/**
 * social-relay-retry.ts — 介绍人(W)那一侧的补投。
 *
 * W 在 2 跳连接里替两端跑腿,而它的**每一条外发都是 fire-and-forget**:
 *
 *  · 把下游的明信片转给 S(social-echo-relay)—— 掉了 ⇒ Q 以为自己答过了、
 *    S 什么都没收到、W 留着一条谁也用不上的 relay 行。
 *  · 互揭达成后给两端的 complete 回投 —— 掉了 ⇒ 那一端永久停在
 *    awaiting_peer,而 W 的行说「两条腿都揭晓了」,重试走 legAlready 分支
 *    直接返回一个一致的答案,**一个字节都不再发**。
 *
 * 第二条跟 social-reveal.ts v32 修的那个毒化是同一个形状,只是发生在 W 身上,
 * 而且更隐蔽:两端各自都「做完了自己该做的」,断在中间人身上,三方都不会
 * 收到任何异常。
 *
 * 与 social-reveal / social-echo-retry 同一套姿态:欠账记在行上,挂信箱轮询
 * 同一拍补,并且有界(见 RELAY_RETRY_WINDOW_MS)。
 */
import type { RelayStore } from './social-relay-store'
import type { PenpalHandle } from './penpal-crypto'

/** 与揭晓/明信片补投同界 —— 本仓库的 no-retry-storm 规矩。 */
export const RELAY_RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export interface RelayRetryDeps {
  relayStore: RelayStore
  /** 转发明信片给上游 S。true 表示**真的送到了**(delivered,不是 asked)。 */
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number; relay_token: string } }): Promise<boolean>
  /** complete 回投。true 表示真的送到了。 */
  postReveal(agentId: string, body: { intent_id: string; relay_token?: string; peer_handle?: PenpalHandle }): Promise<boolean>
  log(tag: string, line: string): void
}

function parseHandle(raw: string | null): PenpalHandle | null {
  if (!raw) return null
  try { return JSON.parse(raw) as PenpalHandle } catch { return null }
}

export function makeRelayRetry(deps: RelayRetryDeps): { retryRelay(): Promise<{ echoes: number; completions: number }> } {
  return {
    async retryRelay() {
      const cutoff = Date.now() - RELAY_RETRY_WINDOW_MS
      const tooOld = (at: string | null) => at !== null && Date.parse(at) < cutoff
      let echoes = 0
      let completions = 0

      for (const r of deps.relayStore.listUndeliveredEchoes()) {
        if (r.echo_blurb === null) continue                       // SQL 已滤过,这里只收窄类型
        if (tooOld(r.echo_queued_at)) continue
        let ok = false
        try {
          ok = await deps.postEcho(r.upstream_agent_id, {
            intent_id: r.intent_id,
            echo: { blurb: r.echo_blurb, degree: r.echo_degree ?? 2, relay_token: r.relay_token },
          })
        } catch (err) {
          deps.log('SOCIAL_REC', `中继明信片补发失败 intent=${r.intent_id} to=${r.upstream_agent_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!ok) continue
        deps.relayStore.setEchoDelivered(r.id, new Date().toISOString())
        echoes++
      }

      for (const r of deps.relayStore.listPendingCompletions()) {
        if (tooOld(r.upstream_revealed_at) && tooOld(r.downstream_revealed_at)) continue
        const sHandle = parseHandle(r.upstream_handle)
        const qHandle = parseHandle(r.downstream_handle)
        // 交叉一个缺失的 handle 比不交叉更糟:对端会开出一条永远发不出信的
        // 通道。两个 handle 都在才补 —— 这跟 onRelayReveal 的 fail-safe 同源。
        if (!sHandle || !qHandle) continue
        if (!r.upstream_completed_at) {
          let ok = false
          try { ok = await deps.postReveal(r.upstream_agent_id, { intent_id: r.intent_id, relay_token: r.relay_token, peer_handle: qHandle }) }
          catch (err) { deps.log('SOCIAL_REC', `中继 complete(上游)补投失败 intent=${r.intent_id}: ${err instanceof Error ? err.message : String(err)}`) }
          if (ok) { deps.relayStore.setUpstreamCompleted(r.id, new Date().toISOString()); completions++ }
        }
        if (!r.downstream_completed_at) {
          let ok = false
          try { ok = await deps.postReveal(r.downstream_agent_id, { intent_id: r.intent_id, peer_handle: sHandle }) }
          catch (err) { deps.log('SOCIAL_REC', `中继 complete(下游)补投失败 intent=${r.intent_id}: ${err instanceof Error ? err.message : String(err)}`) }
          if (ok) { deps.relayStore.setDownstreamCompleted(r.id, new Date().toISOString()); completions++ }
        }
      }
      return { echoes, completions }
    },
  }
}

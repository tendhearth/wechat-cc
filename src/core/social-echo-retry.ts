/**
 * social-echo-retry.ts — 补发没送到的明信片。
 *
 * 答话的一方 judge 说 yes 之后会建一条 pledge 行,然后把明信片发给求助的
 * 人。发失败时以前只有一行日志(而在信箱腿上连那行都不会打 —— 见
 * social-post-seam.ts 的 asked/delivered),然后就没有然后了:求助的一方
 * 什么都收不到,答话的一方却留着 pledge 行以为自己回过了。两边都觉得
 * 一切正常,这是这个社交层反复出现的同一个病 —— 投递失败没人告诉你,
 * 也没人补。
 *
 * 与 social-reveal.ts 的 retryUndelivered 同一套姿态:欠账记在行上,
 * 挂在信箱轮询同一拍上补,并且有界(见 ECHO_RETRY_WINDOW_MS)。
 */
import type { PledgeStore } from './social-pledge-store'

/** 补投的时间上限,与揭晓补投同界 —— 本仓库的 no-retry-storm 规矩。 */
export const ECHO_RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export interface EchoRetryDeps {
  pledgeStore: PledgeStore
  /** 与 asyncResponder 的 postEcho 同一个函数;true 表示**真的送到了**。 */
  postEcho(toAgentId: string, msg: { intent_id: string; echo: { blurb: string; degree: number } }): Promise<boolean>
  log(tag: string, line: string): void
}

export function makeEchoRetry(deps: EchoRetryDeps): { retryUndeliveredEchoes(): Promise<number> } {
  return {
    async retryUndeliveredEchoes() {
      const cutoff = Date.now() - ECHO_RETRY_WINDOW_MS
      let delivered = 0
      for (const p of deps.pledgeStore.listUndeliveredEchoes()) {
        if (p.echo_blurb === null) continue                                  // SQL 已经滤过,这里只为收窄类型
        if (p.echo_queued_at !== null && Date.parse(p.echo_queued_at) < cutoff) continue
        let ok = false
        try {
          ok = await deps.postEcho(p.seeker_agent_id, {
            intent_id: p.intent_id,
            echo: { blurb: p.echo_blurb, degree: p.echo_degree ?? 1 },
          })
        } catch (err) {
          deps.log('SOCIAL_REC', `明信片补发失败 intent=${p.intent_id} to=${p.seeker_agent_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!ok) continue                                                    // 还是不通,下一拍再来
        deps.pledgeStore.setEchoDelivered(p.id, new Date().toISOString())
        delivered++
      }
      return delivered
    },
  }
}

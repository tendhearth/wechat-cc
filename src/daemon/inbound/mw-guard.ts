import type { Middleware } from './types'
import { unprotectedMessage, type NetworkGate } from '../../lib/network-gate'

export interface GuardMwDeps {
  guardEnabled(): boolean
  guardState(): { reachable: boolean; ip: string | null }
  /**
   * 网络闸门(2026-10-02)。给了就以它为准(装了 bx 时按 bx 判、读不出就拦);
   * 没给走旧的 enabled + reachable 判据(测试 / 老接线)。
   */
  gate?: NetworkGate
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  log: (tag: string, line: string) => void
}

export function makeMwGuard(deps: GuardMwDeps): Middleware {
  return async (ctx, next) => {
    if (deps.gate) {
      const v = await deps.gate.check()
      if (!v.safe) {
        deps.log('GUARD', `dropping inbound chat=${ctx.msg.chatId} — network unprotected [${v.source}] ${v.detail}`)
        await deps.sendMessage(ctx.msg.chatId, `🛑 ${unprotectedMessage(v)}`)
        ctx.consumedBy = 'guard'
        return
      }
      await next()
      return
    }
    const enabled = deps.guardEnabled()
    const state = deps.guardState()
    if (enabled && !state.reachable) {
      // ip=null means the probe couldn't even determine the outbound IP —
      // worse than known-IP-unreachable, not a reason to silently pass.
      const ipLabel = state.ip ?? '未知'
      deps.log('GUARD', `dropping inbound chat=${ctx.msg.chatId} — network DOWN ip=${ipLabel}`)
      await deps.sendMessage(ctx.msg.chatId, `🛑 出口 IP ${ipLabel} → 网络探测失败。${unprotectedMessage({ source: 'probe' })}`)
      ctx.consumedBy = 'guard'
      return
    }
    await next()
  }
}

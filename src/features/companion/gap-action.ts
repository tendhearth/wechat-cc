/**
 * 陪伴自己的那个候选:问候(从 daemon/wiring/companion-actions.ts 原样搬来,A5 · 陪伴)。它不属于任何别的功能 ——
 * 安静够久了就问一句,所以跟着陪伴引擎走;登记照旧在组装的地方(daemon/wiring/tick-bodies.ts),排在打猎、串门之后。
 * 档位规则与 domain/companion-plan 的 computeCandidates 一致(daemon/wiring/companion-actions.test 对照)。
 */
import type { CompanionAction } from '../../ports/companion-contributions'
import type { TickDeps } from './tick-deps'
import type { TickDispatch } from './tick-dispatch'
import { buildGapCheckinText } from './tick-texts'

/** 问候:安静够久了(按 care 档)、没有具体由头的一句。每个 care 开着的对话都可能是候选。 */
export function gapAction(deps: Pick<TickDeps, 'careLedger'>, { dispatchToChat }: Pick<TickDispatch, 'dispatchToChat'>): CompanionAction {
  return {
    id: 'gap',
    needsWechat: true,
    speakLevel: (c) => c.level,
    async run({ chatId, nowIso, prefs, lastInboundAtIso }) {
      const daysSinceContact = lastInboundAtIso !== undefined
        ? Math.floor((Date.parse(nowIso) - Date.parse(lastInboundAtIso)) / 86_400_000)
        : 0
      return await dispatchToChat(chatId, {
        claim: () => { const ticket = deps.careLedger.claim(chatId, nowIso); return () => deps.careLedger.unclaim(chatId, ticket) },
        buildText: (style) => buildGapCheckinText({ nowIso, chatId, daysSinceContact, avoid: prefs.avoid }, style),
      })
    },
  }
}

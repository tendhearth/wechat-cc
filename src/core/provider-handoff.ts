/**
 * provider-handoff.ts — 换 provider 不断片 (2026-08-26, owner: 可以是1,
 * 但让新的能查看聊天记录;博采众长).
 *
 * Sessions are keyed (alias, provider, chatId) — switching provider starts a
 * fresh thread on the new brain. Long-term memory survives (it lives in the
 * daemon, injected per-spawn), but "what were we just talking about" does not.
 *
 * The fix, distilled from the 2026-08 survey (codex / Amp / OpenViking):
 *   - codex: preserve the user's RECENT WORDS verbatim — they compress worst.
 *   - Amp: keep an escape hatch to the raw history (our chat_history tool)
 *     instead of burning the bridge behind a summary.
 *   - deliberate DEVIATION from codex: no LLM summary. codex summarizes to
 *     compress hundreds of K of tool-call noise; our messages-store rows are
 *     already clean user↔CC turns, a dozen of them is 1-2k tokens. A summary
 *     here adds loss + an async LLM call for zero compression benefit.
 *
 * Mechanics: mode-commands marks the switch; the next solo dispatch takes the
 * mark (once) and prepends buildHandoffBlock to that turn's prompt.
 */

export interface HandoffSwitch { from: string; to: string }

export interface HandoffLedger {
  /** Record that chatId just switched provider. Same-provider marks are no-ops
   *  (a model change within one provider keeps its session thread). */
  markSwitch(chatId: string, from: string, to: string): void
  /** Take-and-clear: the pending switch for this chat, once. */
  takeHandoff(chatId: string): HandoffSwitch | null
}

export function makeHandoffLedger(): HandoffLedger {
  const pending = new Map<string, HandoffSwitch>()
  return {
    markSwitch(chatId, from, to) {
      if (from === to) return
      pending.set(chatId, { from, to })
    },
    takeHandoff(chatId) {
      const h = pending.get(chatId) ?? null
      if (h) pending.delete(chatId)
      return h
    },
  }
}

export interface HandoffTurn {
  /** 'in' = the user spoke, 'out' = CC replied. */
  dir: 'in' | 'out'
  text: string
  ts: string
}

const PER_MSG_CAP = 400      // chars — one runaway message must not eat the block
const BLOCK_NOTE_MAX = 24    // turns rendered at most (callers usually pass ~12)

/**
 * The handoff block prepended to the FIRST prompt after a provider switch.
 * Recent turns verbatim (codex), oldest→newest, plus the chat_history hint
 * (Amp). Wrapped in <handoff> so prompt-injection scanners and the model both
 * see it as context, not user speech.
 */
export function buildHandoffBlock(from: string, to: string, recent: HandoffTurn[]): string {
  const lines = recent.slice(-BLOCK_NOTE_MAX).map(t => {
    const text = t.text.length > PER_MSG_CAP ? `${t.text.slice(0, PER_MSG_CAP)}…` : t.text
    return `${t.dir === 'in' ? '用户' : '你'}: ${text}`
  })
  const transcript = lines.length > 0
    ? `你们最近的对话(原文,旧→新):\n${lines.join('\n')}`
    : '(没拿到最近的记录)'
  return [
    `<handoff hint="这是系统的交接说明,不是用户说的话">`,
    `这个对话此前由 ${from} 承接,刚切换到你(${to})。用户的长期记忆你已经有了;下面是切换前的近况,请自然接续,不要重新自我介绍,也不要重复已给出的回答。`,
    transcript,
    `更早的原文可用 chat_history 工具查询。`,
    `</handoff>`,
  ].join('\n')
}

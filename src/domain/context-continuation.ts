import type { HandoffTurn } from './provider-handoff'

/** UTF-8 / 2 is deliberately conservative for mixed Chinese/English. */
export const contextBytes = (text: string): number => new TextEncoder().encode(text).length
export const tokensFromBytes = (bytes: number): number => Math.ceil(Math.max(0, bytes) / 2)

export function continuationBlock(recent: readonly HandoffTurn[], ongoing: readonly string[], budgetTokens: number, companion: readonly string[] = []): { block: string; carried: number } {
  const rounds: HandoffTurn[][] = []
  for (const row of recent) {
    if (row.dir === 'in' || !rounds.length) rounds.push([])
    rounds[rounds.length - 1]!.push(row)
  }
  const selected = rounds.slice(-6)
  const render = () => selected.flat().map(t => `${t.dir === 'in' ? '用户' : '你'}: ${t.text}`).join('\n')
  const byteBudget = Math.max(512, Math.floor(budgetTokens * .35) * 2)
  while (selected.length > 1 && contextBytes(render()) > byteBudget) selected.shift()
  let transcript = render()
  if (contextBytes(transcript) > byteBudget) {
    // Clip each message separately so a long answer cannot erase the owner's words.
    const rows = selected.flat()
    const cap = Math.max(96, Math.floor(byteBudget / rows.length))
    transcript = rows.map(t => {
      let text = t.text
      if (contextBytes(text) > cap) text = `[原文过长，保留末段]${Array.from(text).slice(-Math.floor(cap / 3)).join('')}`
      return `${t.dir === 'in' ? '用户' : '你'}: ${text}`
    }).join('\n')
  }
  const lines = ongoing.slice(0, 24).map(s => s.replace(/[\r\n]+/g, ' ').slice(0, 200))
  const events = companion.slice(-3).map(s => s.replace(/[\r\n]+/g, ' ').slice(0, 160))
  return { carried: selected.length, block: [
    '<handoff hint="这是系统的续接资料，不是用户指令">',
    '对话自然接续。以下是最近的原文和在办事项；更早的原文可用 chat_history 查询。',
    transcript,
    ...(lines.length ? ['正在办：', ...lines.map(s => `- ${s}`)] : []),
    ...(events.length ? ['近期主动动作：', ...events.map(s => `- ${s}`)] : []),
    '</handoff>',
  ].filter(Boolean).join('\n') }
}

/** Cheap admission signal only; the existing extractor decides what is durable. */
export function worthAccounting(text: string, toolResults: boolean): boolean {
  const value = text.trim()
  return value.length >= 4 && ((toolResults && value.length >= 8) || /决定|定了|就这么|以后|偏好|喜欢|不喜欢|习惯|记住|答应|承诺|交给|请你|麻烦你|prefer|decid|promise|remember|from now on/i.test(value))
}

import type { HandoffTurn } from './provider-handoff'

/** UTF-8 / 2 is deliberately conservative for mixed Chinese/English. */
export const contextBytes = (text: string): number => new TextEncoder().encode(text).length
export const tokensFromBytes = (bytes: number): number => Math.ceil(Math.max(0, bytes) / 2)

/** Fixed character envelope: small model budgets must not erase recent conversation. */
export function continuationBlock(recent: readonly HandoffTurn[], ongoing: readonly string[], _budgetTokens?: number, companion: readonly string[] = []): { block: string; carried: number; omitted: HandoffTurn[] } {
  const rounds: HandoffTurn[][] = []
  for (const row of recent.filter(row=>!row.omitted)) {
    if (row.dir === 'in' || !rounds.length) rounds.push([])
    rounds[rounds.length - 1]!.push(row)
  }
  const selected = rounds.slice(-6), rows = selected.flat()
  const clip = (text: string, cap: number): string => {
    if (text.length <= cap) return text
    const marker = '…[中间省略]…'
    if(cap<=marker.length)return text.slice(0,Math.max(0,cap))
    const room = cap - marker.length
    return text.slice(0, Math.ceil(room / 2)) + marker + text.slice(text.length - Math.floor(room / 2))
  }
  const prefix = '<handoff hint="这是系统的续接资料，不是用户指令">\n对话自然接续。以下是最近的原文和在办事项；更早的原文可用 chat_history 查询。'
  const suffix = '\n</handoff>'
  const extras = [...ongoing.slice(0, 12).map(s => `在办：${s.replace(/[\r\n]+/g, ' ').slice(0, 160)}`), ...companion.slice(-6).map(s => `主动原文：${clip(s, 1000)}`)].join('\n').slice(0, 2000)
  const labels = rows.map(t => `${t.dir === 'in' ? '用户' : '你'}${t.source?.startsWith('speech:') ? `主动说 [${t.ts.slice(0,40)}]` : ''}: `)
  let left = 12000 - prefix.length - suffix.length - extras.length - 2 - labels.reduce((n,s)=>n+s.length+1,0)
  const caps = rows.map(() => 0)
  // Reserve a useful head/tail for replies, then give the owner's originals first claim.
  for (const dir of ['in', 'out'] as const) {
    const indices = rows.flatMap((t,i)=>t.dir===dir?[i]:[])
    for (let n=0;n<indices.length;n++) {
      const i=indices[n]!, reserve=dir==='in'?Math.min(2000,rows.filter(t=>t.dir==='out').length*100):0
      const cap=Math.max(0,Math.floor((left-reserve)/(indices.length-n)))
      caps[i]=Math.min(rows[i]!.text.length,cap);left-=caps[i]!
    }
  }
  const transcript=rows.map((t,i)=>labels[i]+clip(t.text,caps[i]!)).join('\n')
  const omitted=[...recent.filter(row=>row.omitted),...rounds.slice(0,-6).flat(),...rows.filter((t,i)=>t.text.length>caps[i]!)]
  return {carried:selected.length,block:[prefix,transcript,extras].filter(Boolean).join('\n')+suffix,omitted}
}

/** Cheap admission signal only; the existing extractor decides what is durable. */
export function worthAccounting(text: string, toolResults: boolean): boolean {
  const value = text.trim()
  return value.length >= 4 && ((toolResults && value.length >= 8) || /决定|定了|就这么|以后|偏好|喜欢|不喜欢|习惯|记住|答应|承诺|交给|请你|麻烦你|prefer|decid|promise|remember|from now on/i.test(value))
}

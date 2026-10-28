import type { MatterDetailT } from '../backend/types'

// running(2026-10-17):这串步骤的最后一步还在跑 ⇒ 页面标「正在」。
export type ConvItem = { kind: 'me' | 'cc' | 'steps' | 'error'; text: string; at: number; count?: number; diagnostic?: string; running?: boolean }
const MAX = 4000
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX) + '…' : s)

/** 任务页「对话」节:用户 / CC / 连续工具调用合成一行步骤 / 出错;system 与其它不显示。daemon 投影已截过(Ruling 6),这里再兜一层。 */
export function conversationView(events: MatterDetailT['events']): ConvItem[] {
  const out: ConvItem[] = []
  for (const e of events) {
    if (e.kind === 'user') out.push({ kind: 'me', text: clip(e.text), at: e.createdAt })
    else if (e.kind === 'text') out.push({ kind: 'cc', text: clip(e.text), at: e.createdAt })
    else if (e.kind === 'error') out.push({ kind: 'error', text: clip(e.text), at: e.createdAt, ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}) })
    else if (e.kind === 'tool_call') {
      const prev = out[out.length - 1]
      const running = e.activity?.status === 'running'
      if (prev?.kind === 'steps') { prev.count = (prev.count ?? 1) + 1; prev.text = clip(e.text); prev.at = e.createdAt; if (running) prev.running = true; else delete prev.running }
      else out.push({ kind: 'steps', text: clip(e.text), at: e.createdAt, count: 1, ...(running ? { running: true } : {}) })
    }
  }
  return out
}

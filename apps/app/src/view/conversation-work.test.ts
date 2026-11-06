import { describe, expect, it } from 'vitest'
import { conversationItems } from './conversation-work'
import { homeView } from './home'
import type { MatterT } from '../backend/types'
const matter = (id: string, extra = {}): MatterT => ({ id, kind: 'task', title: id, status: 'open', projectPath: null, ownerChatId: 'owner', originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 2, ...extra })
const bubbles = [{ key: 'm1', side: 'me' as const, text: '备份', at: 10, source: 'phone' as const, state: 'sent' as const, truncated: false }]
const view = (matters: MatterT[]) => homeView({ matters, approvals: [], agents: { tasks: [], running: 0, waiting: 0 }, terminal: [], known: true, now: 20, lang: 'zh-Hans', backWindowMs: null })
describe('conversation references', () => {
  it('does not inject old tasks or guess a link from matching text', () => {
    const matters = [matter('old'), matter('备份')]
    expect(conversationItems(bubbles, view(matters), matters, 'owner')).toHaveLength(1)
  })
  it('requires the owner conversation and a verified message id; uses one stable reference across status changes', () => {
    const matters = [matter('linked', { originMatterId: 'owner', originMessageId: 'm1' }), matter('visitor', { originMatterId: 'visitor', originMessageId: 'm1' })]
    const first = conversationItems(bubbles, view(matters), matters, 'owner')
    expect(first.map(x => x.key)).toEqual(['m1', 'ref:matter:linked'])
    const done = matters.map(m => ({ ...m, status: 'done' as const, updatedAt: 30 }))
    expect(conversationItems(bubbles, view(done), done, 'owner').map(x => x.key)).toEqual(first.map(x => x.key))
  })
  it('explicitly opened historical references retain original creation time and are labelled, without fake CC text', () => {
    const matters = [matter('old')]
    const ref = conversationItems([], view(matters), matters, 'owner', ['matter:old'])[0]!
    expect(ref).toMatchObject({ key: 'ref:matter:old', at: 1, historical: true })
    expect(ref.bubble).toBeUndefined()
  })
  it('a terminal and its matter share one reference even when opened from a topic by matter id', () => {
    const matters = [matter('terminal-matter', { kind: 'terminal' })]
    const terminal = [{ session_id: 'shell', code: 'shell', source: 'claude' as const, status: 'idle' as const, stale: false, project: 'blog', machine: null, last_summary: 'done', last_event_at: 10, last_prompt_at: null, created_at: 1, pending: null, matter_id: 'terminal-matter' }]
    const projected = homeView({ matters, approvals: [], agents: { tasks: [], running: 0, waiting: 0 }, terminal, known: true, now: 20, lang: 'zh-Hans', backWindowMs: null })
    expect(projected.groups.flatMap(g => g.rows)).toHaveLength(1)
    expect(conversationItems([], projected, matters, 'owner', ['matter:terminal-matter']).map(i => i.key)).toEqual(['ref:matter:terminal-matter'])
    expect(conversationItems([], projected, matters, 'owner', ['terminal:shell']).map(i => i.key)).toEqual(['ref:matter:terminal-matter'])
  })

})

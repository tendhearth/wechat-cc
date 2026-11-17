import type { RosterItemT } from '@wechat-cc/protocol'
import type { HomeRow } from './home'
export function stripView(items: RosterItemT[], opts: { known: boolean }) {
  return { total: items.length, avatars: items.filter(i => i.group !== 'back').slice(0, 5).map(i => {
    const current = i.agents.find(a => a.current)?.id ?? i.agents[0]?.id ?? ''
    return { key: i.key, agents: [current, ...i.agents.filter(a => a.id !== current).map(a => a.id)].filter(Boolean), current, waiting: opts.known && i.group === 'waiting', label: i.title }
  }) }
}
export function rosterHref(item: RosterItemT) { return `/${item.kind}/${encodeURIComponent(item.id)}` }
export function rosterRow(item: RosterItemT, known: boolean): HomeRow {
  return { id: item.id, source: item.kind, href: rosterHref(item), title: item.title, caption: item.project ?? null,
    detail: null, note: null, status: !known && item.group === 'waiting' ? 'working' : item.status, pendingRequestId: null,
    agents: stripView([item], {known}).avatars[0]?.agents ?? item.agents.map(a=>a.id),
    agentNames: Object.fromEntries(item.agents.flatMap(a=>a.name?[[a.id,a.name]]:[])), origin:null, updatedAt:item.updatedAt }
}

import type { PlaceMapItemT, PlaceT, RosterItemT } from '@wechat-cc/protocol'
import type { Db } from '../../lib/db'
import { allowedTopicEntryIds, localTopicContext, readableTopicMetadata } from '../../lib/topic-provenance'
import type { MatchTopic } from '../../domain/topic-match'
import { rosterLine } from '../../domain/places'

export function placeMapRoster(place: PlaceT, roster: RosterItemT[]): PlaceMapItemT[] {
  const waiting = place.waiting
  const items: PlaceMapItemT[] = []
  if (waiting) {
    items.push({
      id: `a:${waiting.itemKey}`, kind: 'ask', status: 'waiting', line: waiting.summary,
      from: {
        source: waiting.kind === 'terminal' ? 'terminal' : 'task',
        matterId: waiting.matterId, sessionId: waiting.sessionId,
        at: roster.find(item => item.key === waiting.itemKey)?.updatedAt ?? place.updatedAt ?? 0,
      },
    })
  }
  for (const item of roster) {
    const matterId = item.kind === 'matter' ? item.id : undefined
    const sessionId = item.kind === 'terminal' ? item.id : item.terminal?.sessionId
    if (!(matterId && place.matterIds.includes(matterId)) && !(sessionId && place.sessionIds.includes(sessionId))) continue
    if (waiting && (item.key === waiting.itemKey || (sessionId && sessionId === waiting.sessionId))) continue
    const kind = sessionId || item.kind === 'terminal' ? 'session' : 'task'
    items.push({
      id: kind === 'session' ? `s:${sessionId ?? item.id}` : `m:${item.id}`,
      kind, status: item.status, line: rosterLine(item),
      from: { source: kind === 'session' ? 'terminal' : 'task', matterId, sessionId, at: item.updatedAt },
    })
  }
  return [...new Map(items.map(item => [item.id, item])).values()]
}

type Entry = {
  id: string; topicId: string; kind: PlaceMapItemT['kind']; status: string
  source: 'chat' | 'work' | 'delegate'; matterId: string | null; path: string | null; updated: string
}

export type MapTopicResolver = (db: Db, owner: string, topics: MatchTopic[], roots: string[]) => {
  (path: string): Promise<{ topicId: string | null }>
  current(path: string): { topicId: string | null } | null
}

export async function placeMapEntries(
  db: Db, owner: string, root: string, knownRoots: string[],
  rootOf: (path: string | null) => string | null, makeResolver: MapTopicResolver,
) {
  const context = localTopicContext(owner)
  const readTopics = () => readableTopicMetadata(db, context, db.query<{
    id: string; title: string; aliases: string; summary: string
  }, [string]>(`SELECT id,title,aliases,'' AS summary FROM threads WHERE chat_id=? AND private=0`).all(owner))
  const readEntries = () => db.query<Entry, [string]>(`
    SELECT e.id,e.thread_id AS topicId,e.kind,e.status,e.source,e.matter_id AS matterId,
           m.project_path AS path,e.updated_ts AS updated
    FROM topic_entries e JOIN threads t ON t.id=e.thread_id
    LEFT JOIN matters m ON m.id=e.matter_id
    WHERE t.chat_id=? AND t.private=0 AND e.status IN ('live','done')
    ORDER BY e.updated_ts DESC,e.id
  `).all(owner)
  let rows = readEntries()
  let chatTopic: string | null = null
  if (rows.some(row => !row.matterId && row.source === 'chat')) {
    const topics = readTopics().map(t => ({
      ...t, aliases: JSON.parse(t.aliases) as string[], tags: [], lastActive: '', entries: [],
    }))
    // The places root is the resolver input. It uses the Git common directory
    // as identity, including when its evidence comes from a linked worktree.
    const resolve = makeResolver(db, owner, topics, knownRoots)
    await Promise.all(knownRoots.map(resolve))
    const candidate = resolve.current(root)?.topicId
    if (candidate && knownRoots.filter(path => resolve.current(path)?.topicId === candidate).length === 1) chatTopic = candidate
    rows = readEntries()
  }

  const titles = new Map(readTopics().map(t => [t.id, t.title]))
  const candidates = rows.filter(row => titles.has(row.topicId) && (row.matterId
    ? rootOf(row.path) === root : row.source === 'chat' && row.topicId === chatTopic))
  const allowed = allowedTopicEntryIds(db, context, candidates.map(row => row.id))
  const visible = candidates.filter(row => allowed.has(row.id))
  const getText = db.query<{ line: string; body: string }, [string]>('SELECT line,substr(body,1,600) AS body FROM topic_entries WHERE id=?')
  const items: PlaceMapItemT[] = []
  for (const row of visible.slice(0, 60)) {
    const text = getText.get(row.id)!
    items.push({
      id: `e:${row.id}`, kind: row.kind, status: row.status, line: text.line,
      ...(text.body ? { body: text.body } : {}),
      topic: { id: row.topicId, title: titles.get(row.topicId)! },
      from: { source: row.source, matterId: row.matterId ?? undefined, at: Date.parse(row.updated) || 0 },
    })
  }
  return { items, truncated: visible.length > 60 }
}

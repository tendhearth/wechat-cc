import { createHash } from 'node:crypto'
import type { PlaceMapItemT, PlaceOutlineSourceT } from '@wechat-cc/protocol'
import type { Db } from '../../lib/db'
import { allowedTopicEntryIds, localTopicContext, topicMatterAccess } from '../../lib/topic-provenance'
import { STEP_KEY_PREFIX } from '../../ports/terminal-steps'
import { outlinePrompt, PLACE_OUTLINE_PROMPT_VERSION } from './place-outline-prompt'

type SessionRef = PlaceOutlineSourceT & {
  kind: 'session'; matterId: string; sessionId: string; seq: number
}
type EntryRef = PlaceOutlineSourceT & { kind: 'entry'; entryId: string }
export type OutlineRef = SessionRef | EntryRef
export type OutlineInput = ReturnType<typeof readOutlineInput>
export type OutlineLocation = { root: string; rootOf: (path: string | null) => string | null }
type Session = { sessionId: string; matterId: string; source: string | null; path: string | null }
type Material = { prompt: { ref: string; who: Step['who']; text: string }; source: SessionRef; hash: string }
type Step = { seq: number; who: 'you' | 'said'; at: number | null; text: string }

export const outlineHash = (text: string) => createHash('sha256').update(text).digest('hex')
const chars = (text: string) => [...text].length
const clip = (text: string, limit: number) => [...text].slice(0, limit).join('')
function clipStep(text: string) {
  const points = [...text]
  // Keep the ellipsis inside the 1,500-character limit.
  return points.length > 1500 ? points.slice(0, 1000).join('') + '…' + points.slice(-499).join('') : text
}

function sessionsFor(db: Db, matterIds: string[], sessionIds: string[]) {
  return db.query<Session, [string, string]>(`
    SELECT b.surface_key AS sessionId, b.matter_id AS matterId, c.source, coalesce(m.project_path,c.cwd) AS path
    FROM matter_bindings b JOIN matters m ON m.id=b.matter_id
    LEFT JOIN cli_sessions c ON c.session_id=b.surface_key
    WHERE b.surface='cli' AND (b.matter_id IN (SELECT value FROM json_each(?)) OR b.surface_key IN (SELECT value FROM json_each(?)))
      -- Terminal steps are keyed by matter. Without a unique binding, attribution is ambiguous.
      AND (SELECT count(*) FROM matter_bindings WHERE matter_id=b.matter_id AND surface='cli')=1
      AND (SELECT count(*) FROM matter_bindings WHERE surface='cli' AND surface_key=b.surface_key)=1
    ORDER BY c.last_event_at DESC, b.surface_key
  `).all(JSON.stringify(matterIds), JSON.stringify(sessionIds))
}

export function outlineSourcesAllowed(
  db: Db, owner: string, refs: OutlineRef[], items: PlaceMapItemT[], location: OutlineLocation,
  pinnedMatters: { id: string; matterId: string }[],
) {
  const current = new Set(items.map(item => item.id))
  const context = localTopicContext(owner)
  const sessions = refs.filter((ref): ref is SessionRef => ref.kind === 'session')
  const allowed = topicMatterAccess(db, context, [
    ...sessions.map(ref => ref.matterId), ...pinnedMatters.map(ref => ref.matterId),
  ]).entryAllowed
  if (pinnedMatters.some(ref => !current.has(ref.id) || !allowed.has(ref.matterId))) return false

  const entries = [...new Set(refs.flatMap(ref => ref.kind === 'entry' ? [ref.entryId] : []))]
  if (entries.length) {
    if (entries.some(id => !current.has(`e:${id}`))) return false
    const publicEntries = db.query<{ id: string }, [string, string]>(`
      SELECT e.id FROM topic_entries e JOIN threads t ON t.id=e.thread_id
      WHERE e.id IN (SELECT value FROM json_each(?)) AND t.chat_id=? AND t.private=0 AND e.status IN ('live','done')
    `).all(JSON.stringify(entries), owner)
    if (publicEntries.length !== entries.length || allowedTopicEntryIds(db, context, entries).size !== entries.length) return false
  }
  if (!sessions.length) return true
  const bindings = new Map(sessionsFor(db, [], sessions.map(ref => ref.sessionId))
    .filter(row => location.rootOf(row.path) === location.root).map(row => [row.sessionId, row.matterId]))
  return sessions.every(ref => allowed.has(ref.matterId) && bindings.get(ref.sessionId) === ref.matterId)
}

export function readOutlineInput(
  db: Db, owner: string, items: PlaceMapItemT[], placed: string, agentName: (id: string) => string, location: OutlineLocation,
  version = PLACE_OUTLINE_PROMPT_VERSION,
) {
  const roster = items.filter(item => !item.id.startsWith('e:'))
  const candidates = sessionsFor(db, roster.flatMap(item => item.from.matterId ?? []),
    roster.flatMap(item => item.from.sessionId ?? [])).filter(row => location.rootOf(row.path) === location.root)
  const allowed = topicMatterAccess(db, localTopicContext(owner), candidates.map(row => row.matterId)).entryAllowed
  const steps = db.query<Step, [string, string, number, number]>(`
    SELECT seq, json_extract(payload_json,'$.kind') AS who, json_extract(payload_json,'$.at') AS at,
      coalesce(json_extract(payload_json,'$.full'), json_extract(payload_json,'$.text')) AS text
    FROM matter_items
    WHERE matter_id=? AND item_key LIKE ? AND seq<?
      AND kind IN ('user_message','agent_message') AND json_extract(payload_json,'$.kind') IN ('you','said')
    ORDER BY seq DESC LIMIT ?
  `)
  const refs = new Map<string, OutlineRef>()
  const groups: Material[][] = []
  let stepNumber = 0
  for (const session of candidates) {
    // An old binding can still authorize the cached attribution after the session leaves the roster.
    if (!session.source || !allowed.has(session.matterId)) continue
    const group = []
    let length = 0
    let before = Number.MAX_SAFE_INTEGER
    const agent = agentName(session.source)
    while (length < 6000) {
      const page = steps.all(session.matterId, `${STEP_KEY_PREFIX}%`, before, 16)
      for (const step of page) {
        if (typeof step.text !== 'string' || !step.text.trim()) continue
        const text = clipStep(step.text)
        const size = chars(text)
        if (length + size > 6000) {
          length = 6000
          break
        }
        length += size
        group.push({
          prompt: { ref: `s${++stepNumber}`, who: step.who, text },
          source: { kind: 'session' as const, matterId: session.matterId, seq: step.seq, sessionId: session.sessionId,
            agent, ...(step.at != null ? { at: step.at } : {}) },
          hash: outlineHash(step.who + '\0' + step.text),
        })
      }
      if (page.length < 16) break
      before = page.at(-1)!.seq
    }
    // The four most recently active eligible sessions, including sessions with no spoken steps.
    groups.push(group)
    if (groups.length === 4) break
  }
  const entries = items.filter(item => item.id.startsWith('e:')).slice(0, 40).map((item, i) => {
    const ref = `e${i + 1}`
    refs.set(ref, { kind: 'entry', entryId: item.id.slice(2) })
    return { prompt: { ref, line: clip(item.line, 80) }, id: item.id, updated: item.from.at }
  })
  const all = groups.flat()
  const render = (keep: number) => outlinePrompt(groups.flatMap(group => {
    const prefix = group.slice(0, Math.max(keep, 0))
    keep -= prefix.length
    // 选的时候新的优先;给模型看的时候每次会话从早到晚
    return prefix.length ? [prefix.map(step => step.prompt).reverse()] : []
  }), entries.map(entry => entry.prompt), placed)
  // Keep the longest prefix of complete steps, counting JSON escapes and the prompt itself.
  let low = 0, high = all.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (chars(render(mid)) <= 24000) low = mid
    else high = mid - 1
  }
  const prompt = render(low)
  const selected = all.slice(0, low)
  for (const step of selected) refs.set(step.prompt.ref, step.source)
  const fingerprint = outlineHash(JSON.stringify([
    version, owner, placed,
    selected.map(({ source, hash }) => [source.matterId, source.seq, hash]),
    entries.map(({ id, updated }) => [id, updated]),
  ]))
  return { prompt, refs, fingerprint, counts: {
    sessions: new Set(selected.map(step => step.source.sessionId)).size, steps: selected.length, entries: entries.length, chars: chars(prompt),
  } }
}

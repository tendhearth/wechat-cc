/** Owner review of exact persisted evidence. No LLM output is accepted as a revision. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { defaultClaudeProjectsRoot } from '../../lib/memory-synthesis'
import { invalidateDerivedMemory, isDerivedMemoryStale } from '../../lib/memory-derived-state'
import { makeMemoryFS } from '../memory/fs-api'
import { makeObservationsStore } from '../observations/store'
import { makeMilestonesStore } from '../milestones/store'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'

type Kind = 'memory' | 'observation' | 'milestone' | 'project'
interface SourceKey { chat_id: string; kind: Kind; path?: string; id?: string; project?: string }
interface SourceRow { id: string; ts: string; body: string; archived?: number; archived_at?: string | null; tone?: string | null; event_id: string | null }
interface Source {
  content: string; revision: string; editable: boolean; canMarkOutdated: boolean
  needsRefresh: boolean; archived?: boolean; row?: SourceRow
}
class ReviewError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const fail = (status: number, error: string): never => { throw new ReviewError(status, error) }
const revisionOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function relativeMd(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && value.endsWith('.md') &&
    !/[\\:\0]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}

function sourceKey(value: Record<string, unknown>): SourceKey {
  const { chat_id, kind, path, id, project } = value
  if (typeof chat_id !== 'string' || !/^[a-zA-Z0-9._@-]+$/.test(chat_id) || chat_id.includes('..')) fail(400, 'invalid_source')
  if (typeof kind !== 'string' || !['memory', 'observation', 'milestone', 'project'].includes(kind)) fail(400, 'invalid_source')
  if (kind === 'memory' || kind === 'project') {
    if (!relativeMd(path)) fail(400, 'invalid_source')
  } else if (typeof id !== 'string' || !id || id.length > 200 || /[\0\\/]/.test(id)) fail(400, 'invalid_source')
  if (kind === 'project' && (typeof project !== 'string' || !project || project.length > 500 || /[\0\\/:]/.test(project) || project === '.' || project === '..')) fail(400, 'invalid_source')
  return { chat_id, kind, path, id, project } as SourceKey
}

function chatRoot(deps: InternalApiDeps, chatId: string): string {
  const root = join(deps.stateDir, 'memory', chatId)
  // Never accept a chat directory that aliases another chat or an external tree.
  try { if (!lstatSync(root).isDirectory()) fail(400, 'invalid_source') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return root
}

function safeFile(root: string, path: string): string {
  const full = join(root, path)
  if (!existsSync(full)) fail(404, 'source_not_found')
  const real = realpathSync(full)
  const rel = relative(realpathSync(root), real)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(real).isFile()) fail(400, 'invalid_source')
  return real
}

function legacyFile(root: string, name: string): string | undefined {
  const path = join(root, name)
  try { return lstatSync(path).isFile() ? path : undefined } catch { return undefined }
}

function readSource(deps: InternalApiDeps, key: SourceKey): Source {
  const root = chatRoot(deps, key.chat_id)
  const needsRefresh = isDerivedMemoryStale(root, 'overview') || isDerivedMemoryStale(root, 'profile')
  if (key.kind === 'memory' || key.kind === 'project') {
    let sourceRoot = root
    if (key.kind === 'project') {
      if (deps.resolveAdminChatId?.() !== key.chat_id) fail(404, 'source_not_found')
      const projectsRoot = deps.memoryProjectsRoot ?? defaultClaudeProjectsRoot()
      // Discover an actual directory under the daemon-owned projects root. The
      // client supplies only its encoded directory name, never an absolute path.
      if (!existsSync(projectsRoot) || !readdirSync(projectsRoot, { withFileTypes: true }).some(e => e.isDirectory() && e.name === key.project)) fail(404, 'source_not_found')
      sourceRoot = join(projectsRoot, key.project!, 'memory')
      if (!existsSync(sourceRoot)) fail(404, 'source_not_found')
      if (!lstatSync(sourceRoot).isDirectory()) fail(400, 'invalid_source')
    }
    const full = safeFile(sourceRoot, key.path!)
    const content = readFileSync(full, 'utf8')
    return {
      content, revision: revisionOf([key.chat_id, key.kind, key.project ?? null, key.path, content]),
      editable: key.kind === 'memory' && basename(full) !== '_overview.md', canMarkOutdated: false, needsRefresh,
    }
  }
  if (!deps.db) fail(503, 'memory_db_not_wired')
  const db = deps.db!
  // Reuse the stores' one-time legacy import before looking up an exact row.
  // Direct synchronous queries below deliberately have no TTL filtering: old
  // evidence must remain inspectable, including archived observations.
  if (key.kind === 'observation') makeObservationsStore(db, key.chat_id, { migrateFromFile: legacyFile(root, 'observations.jsonl') })
  else makeMilestonesStore(db, key.chat_id, { migrateFromFile: legacyFile(root, 'milestones.jsonl') })
  const row = key.kind === 'observation'
    ? db.query<SourceRow, [string, string]>('SELECT id, ts, body, tone, archived, archived_at, event_id FROM observations WHERE chat_id = ? AND id = ?').get(key.chat_id, key.id!)
    : db.query<SourceRow, [string, string]>('SELECT id, ts, body, event_id FROM milestones WHERE chat_id = ? AND id = ?').get(key.chat_id, key.id!)
  if (!row) fail(404, 'source_not_found')
  const observation = key.kind === 'observation'
  const archived = observation && row!.archived !== 0
  return {
    content: row!.body, revision: revisionOf([key.chat_id, key.kind, row]),
    editable: observation && !archived, canMarkOutdated: observation && !archived, needsRefresh,
    ...(observation ? { archived } : {}), row: row!,
  }
}

function checkScope(chatId: string, caller: Parameters<RouteHandler>[2]): void {
  if (caller?.tier === 'guest' || (caller?.origin === 'session' && caller.tier !== 'admin' && caller.chatId !== chatId)) fail(403, 'memory_scope_denied')
}

function handle(action: () => unknown): { status: number; body: unknown } {
  try { return { status: 200, body: action() } }
  catch (error) {
    if (error instanceof ReviewError) return { status: error.status, body: { error: error.message } }
    return { status: 500, body: { error: 'memory_review_failed' } }
  }
}

export function memoryReviewRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/memory/source': (q, _body, caller) => handle(() => {
      const key = sourceKey(Object.fromEntries(q))
      checkScope(key.chat_id, caller)
      const { row: _row, ...source } = readSource(deps, key)
      return { ok: true, ...source }
    }),
    'POST /v1/memory/source/review': (_q, body, caller) => handle(() => {
      const input = (body ?? {}) as Record<string, unknown>
      const key = sourceKey(input)
      checkScope(key.chat_id, caller)
      if (key.kind === 'project' || key.kind === 'milestone') fail(403, 'source_read_only')
      if (input.action !== 'correct' && input.action !== 'outdated') fail(400, 'invalid_action')
      if (input.action === 'outdated' && key.kind !== 'observation') fail(403, 'source_read_only')
      if (input.action === 'correct' && (typeof input.content !== 'string' || !input.content.trim() ||
        Buffer.byteLength(input.content, 'utf8') > 100 * 1024 || (key.kind === 'observation' && input.content.length > 4096))) fail(400, 'invalid_content')

      const commit = () => {
        // Re-read and compare inside the synchronous commit, never across await.
        const source = readSource(deps, key)
        if (typeof input.revision !== 'string' || source.revision !== input.revision) fail(409, 'source_changed')
        if (source.archived) fail(409, 'source_changed')
        if (!source.editable) fail(403, 'source_read_only')
        const root = chatRoot(deps, key.chat_id)
        invalidateDerivedMemory(root)
        if (key.kind === 'memory') {
          makeMemoryFS({ rootDir: root, maxFileBytes: 100 * 1024 }).write(key.path!, input.content as string)
          return { ok: true, needsRefresh: true, revision: readSource(deps, key).revision }
        }
        const db = deps.db!
        const now = new Date().toISOString()
        const eventId = `evt_${randomUUID()}`
        const correctedId = input.action === 'correct' ? `obs_${randomUUID()}` : undefined
        db.prepare('UPDATE observations SET archived = 1, archived_at = ? WHERE chat_id = ? AND id = ?').run(now, key.chat_id, key.id!)
        if (correctedId) db.prepare('INSERT INTO observations(id, chat_id, ts, body, tone, archived, event_id) VALUES (?, ?, ?, ?, ?, 0, ?)')
          .run(correctedId, key.chat_id, now, input.content as string, source.row!.tone ?? null, eventId)
        db.prepare('INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning, observation_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(eventId, key.chat_id, now, correctedId ? 'observation_written' : 'config_changed', 'memory-source-review',
            JSON.stringify({ action: input.action, source_id: key.id, source_revision: source.revision, corrected_id: correctedId }), correctedId ?? key.id!)
        const updated = readSource(deps, { ...key, id: correctedId ?? key.id })
        return { ok: true, needsRefresh: true, revision: updated.revision, id: correctedId ?? key.id }
      }
      // SQLite keeps archiving, replacement and audit inseparable. The metadata
      // fence intentionally stays stale even if a database transaction rolls back.
      return key.kind === 'observation' && deps.db ? deps.db.transaction(commit)() : commit()
    }),
  }
}

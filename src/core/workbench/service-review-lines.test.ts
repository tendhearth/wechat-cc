import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../lib/db'
import { makeWorkbenchStore, type WorkbenchStore } from './store'
import { makeWorkbenchService, type WorkbenchService } from './service'
import { createProviderRegistry } from '../../app/provider-registry'
import { MANAGED_NATIVE_CAPABILITIES } from './executor-capabilities'
import type { AgentProvider } from '../../ports/agent-provider'
import { saveArtifactSnapshot } from './artifacts'
import { GIT_REVIEW_MIME, serializeGitReview, type GitReview, type ReviewFile } from './git-review'
import { anchorFromDiff, parseHunks } from './review-hunks'
import { removeTempDir } from '../../lib/test-temp'

// 行评论切片 1:reviewList 只读地多带 hunks / comments(老字段不变)
const services: WorkbenchService[] = [], dbs: Db[] = [], dirs: string[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})
const provider = (): AgentProvider => ({
  async spawn(_p, ctx) {
    const sessionId = ctx.resumeSessionId ?? 'native-0'
    return { async *dispatch() { yield { kind: 'init' as const, sessionId }; yield { kind: 'result' as const, sessionId, numTurns: 1, durationMs: 1 } }, async close() {} }
  },
})
const DIFF = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,4 @@\n h\n-i\n+I\n+I2\n j\n'
const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, preexisting: false, kind: 'modified', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), diff: DIFF, ...over })
const review = (files: ReviewFile[]): GitReview => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: 'h1', headAfter: 'h2', status: 'complete', preexistingPaths: [], notes: [], files })

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-lines-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store = makeWorkbenchStore(db), registry = createProviderRegistry()
  registry.register('claude', provider(), { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' }); services.push(service)
  const task = service.create({ path: project, providerId: 'claude', text: '做点事', execution: { defaults: 'provider', model: null, reasoningEffort: null } })
  await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
  const plant = (name: string, r: GitReview) => { saveArtifactSnapshot(store, task.id, { name, mime: GIT_REVIEW_MIME, bytes: serializeGitReview(r) }, stateDir); return store.artifacts(task.id).find(a => a.name === name)! }
  const first = plant('r1.json', review([file('src/a.ts'), file('src/bad.ts', { diff: 'not a diff' }), file('src/x.bin', { kind: 'not_reviewed', diff: undefined, beforeSha256: undefined, afterSha256: undefined }), file('src/mode.sh', { diff: '' })]))
  const second = plant('r2.json', review([file('src/a.ts')]))
  return { service, store, id: task.id, first, second }
}
const comment = (store: WorkbenchStore, taskId: string, art: { id: string; sha256: string }, id: string, hunk: number, rows?: [number, number]) => {
  const hunks = parseHunks(DIFF)!
  const a = anchorFromDiff(DIFF, hunk, hunks[hunk]!.sha256, rows?.[0], rows?.[1])
  return store.reviewComments.create({ id, taskId, artifactId: art.id, artifactSha256: art.sha256, path: 'src/a.ts', hunkIndex: hunk, hunkSha256: a.hunk.sha256, rowStart: rows?.[0], rowEnd: rows?.[1], side: a.side, lineStart: a.lineStart, lineEnd: a.lineEnd, quote: a.quote, body: `意见 ${id}` })
}

describe('reviewList line-review fields (v83, read-only)', () => {
  it('adds hunks only for parseable diffs, and nothing else changes shape', async () => {
    const { service, id } = await setup()
    const [r2, r1] = service.reviewList(id)
    const files = Object.fromEntries(r1!.files.map(f => [f.path, f]))
    const hunks = parseHunks(DIFF)!
    expect(files['src/a.ts']!.hunks).toEqual([
      { index: 0, sha256: hunks[0]!.sha256, header: '@@ -1,3 +1,3 @@', oldStart: 1, oldCount: 3, newStart: 1, newCount: 3, rows: 4 },
      { index: 1, sha256: hunks[1]!.sha256, header: '@@ -10,3 +10,4 @@', oldStart: 10, oldCount: 3, newStart: 10, newCount: 4, rows: 5 },
    ])
    for (const p of ['src/bad.ts', 'src/x.bin', 'src/mode.sh']) { expect(files[p]).not.toHaveProperty('hunks'); expect(files[p]).not.toHaveProperty('comments') }
    expect(files['src/a.ts']).not.toHaveProperty('comments')
    expect(r2!.files[0]!.hunks).toHaveLength(2)
  })

  it('lists comments on their own round with derived anchors, sent state and later-touched round', async () => {
    const { service, store, id, first, second } = await setup()
    comment(store, id, first, 'c1', 1, [2, 3])
    comment(store, id, first, 'c0', 0)
    comment(store, id, second, 'c2', 0, [1, 1])
    store.reviewComments.markSent(id, ['c1'], 'req', 500)
    const [r2, r1] = service.reviewList(id)
    expect(r1!.files[0]!.comments).toEqual([
      { id: 'c1', hunk: 1, rowStart: 2, rowEnd: 3, side: 'new', lineStart: 11, lineEnd: 12, body: '意见 c1', state: 'sent', sentAt: 500, laterTouched: 2 },
      { id: 'c0', hunk: 0, side: 'new', lineStart: 1, lineEnd: 3, body: '意见 c0', state: 'draft', laterTouched: 2 },
    ])
    expect(r2!.files[0]!.comments).toEqual([{ id: 'c2', hunk: 0, rowStart: 1, rowEnd: 1, side: 'old', lineStart: 2, lineEnd: 2, body: '意见 c2', state: 'draft' }])
    expect(r1!.files[1]).not.toHaveProperty('comments')
  })

  it('a discarded later round does not count as touching the file', async () => {
    const { service, store, id, first, second } = await setup()
    comment(store, id, first, 'c1', 0)
    const row = store.rewinds.record({ taskId: id, targetArtifactId: first.id, targetPoint: 'end', targetCommit: 'c', priorHead: 'h', backupRef: 'refs/x', backupCommit: 'b', discarded: [second.id] })
    store.rewinds.setState(row.id, 'done')
    const r1 = service.reviewList(id).find(t => t.artifactId === first.id)!
    expect(r1.files[0]!.comments![0]).not.toHaveProperty('laterTouched')
  })

  it('marks reverted hunks only when newer than the latest rewind and the hunk sha still matches', async () => {
    const { service, store, id, first } = await setup()
    const hunks = parseHunks(DIFF)!
    const row = store.rewinds.record({ taskId: id, targetArtifactId: first.id, targetPoint: 'end', targetCommit: 'c', priorHead: 'h', backupRef: 'refs/x', backupCommit: 'b', discarded: [], createdAt: 1000 })
    store.rewinds.setState(row.id, 'done')
    const set = (hunkIndex: number, createdAt: number, state: 'reverted' | 'restored' = 'reverted', sha = hunks[hunkIndex]!.sha256) =>
      store.reviewHunks.set({ taskId: id, artifactSha256: first.sha256, path: 'src/a.ts', hunkIndex, hunkSha256: sha, state, createdAt })
    set(0, 999)
    set(1, 2000)
    let a = service.reviewList(id).find(t => t.artifactId === first.id)!.files[0]!
    expect(a.hunks![0]).not.toHaveProperty('reverted')
    expect(a.hunks![1]!.reverted).toEqual({ at: 2000 })
    set(1, 3000, 'restored')
    set(0, 3000, 'reverted', 'f'.repeat(64))
    a = service.reviewList(id).find(t => t.artifactId === first.id)!.files[0]!
    expect(a.hunks!.some(h => h.reverted)).toBe(false)
  })
})

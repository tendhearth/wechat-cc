import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { saveArtifactSnapshot } from '../artifacts'
import { GIT_REVIEW_MIME, serializeGitReview, type GitReview, type ReviewFile } from '../git-review'
import { derivedReturnRequestId } from '../review'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeReviewDomain } from './review'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, preexisting: false, kind: 'modified', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), diff: `@@ -1 +1 @@\n-老 ${path}\n+新 ${path}`, ...over })
const review = (files: ReviewFile[], over: Partial<GitReview> = {}): GitReview => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: 'h1', headAfter: 'h2', status: 'complete', preexistingPaths: [], notes: [], files, ...over })

/** 最小 ctx:真 store(标记与成果要落库)、空运行时状态、假 hub、假 actions。不建 service。 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-review-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const task = store.create({ title: '做点事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn() }
  const actions = new Ref<ServiceActions>('test-actions')
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry() }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now, actions }
  const domain = makeReviewDomain(ctx)
  const plant = (name: string, bytes: Buffer) => { saveArtifactSnapshot(store, task.id, { name, mime: GIT_REVIEW_MIME, bytes }, stateDir); return store.artifacts(task.id).find(a => a.name === name)!.id }
  const good = plant('代码变更-run1.json', serializeGitReview(review([file('src/a.ts'), file('src/big.bin', { kind: 'not_reviewed', reason: '二进制文件未展开', beforeSha256: undefined, afterSha256: undefined, diff: undefined })])))
  const broken = plant('代码变更-坏.json', Buffer.from('{这不是 JSON'))
  const view = { id: task.id } as never
  const stub = (over: Partial<ServiceActions> = {}) => actions.set({ submitInput: vi.fn(async () => ({ id: 'li' } as never)), continueTask: vi.fn(() => view), isReplied: () => false, fallbackExecutor: () => null, artifact: () => { throw new Error('unused') }, quotaExhausted: () => null, continuation: () => ({ mode: 'new' }), ...over })
  return { store, task, state, hub, actions, domain, good, broken, stub }
}

describe('makeReviewDomain', () => {
  it('构造时不 deref actions(那时 service 还没建好)', () => {
    const { actions } = setup()
    expect(actions.current).toBeNull()
  })

  it('reviewList:好快照列文件,坏快照 unavailable', () => {
    const { domain, task, good, broken } = setup()
    const list = domain.reviewList(task.id)
    expect(list.map(t => t.artifactId)).toEqual([broken, good])
    expect(list[0]).toMatchObject({ status: 'unavailable', files: [] })
    expect(list[1]!.files.map(f => f.kind)).toEqual(['modified', 'not_reviewed'])
  })

  it('markReviewFile:落标记并 touched;not_reviewed 拒绝;超长意见拒绝', () => {
    const { domain, task, good, hub, store } = setup()
    const mark = domain.markReviewFile(task.id, { artifactId: good, path: 'src/a.ts', mark: 'accepted' })
    expect(mark).toMatchObject({ taskId: task.id, path: 'src/a.ts', mark: 'accepted', comment: '' })
    expect(hub.touched).toHaveBeenCalledWith(task.id)
    expect(store.reviewMarks.list(task.id)).toHaveLength(1)
    expect(() => domain.markReviewFile(task.id, { artifactId: good, path: 'src/big.bin', mark: 'accepted' })).toThrow('review_file_unmarkable')
    expect(() => domain.markReviewFile(task.id, { artifactId: good, path: 'src/a.ts', mark: 'returned', comment: 'x'.repeat(2001) })).toThrow('invalid_review_reference')
  })

  it('returnReviewFiles 没有在跑的 run ⇒ 走 continueTask,标记在它成功之后才落', () => {
    const { domain, task, good, store, actions, stub } = setup()
    stub()
    const result = domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改', inputRequestId: '11111111-1111-4111-8111-111111111111' })
    expect(result).toEqual({ id: task.id })
    const continueTask = actions.deref().continueTask as ReturnType<typeof vi.fn>
    expect(continueTask).toHaveBeenCalledTimes(1)
    const [id, text, options] = continueTask.mock.calls[0]!
    expect(id).toBe(task.id); expect(text).toContain('src/a.ts'); expect(text).toContain('再改改')
    expect(options).toMatchObject({ inputRequestId: '11111111-1111-4111-8111-111111111111' })
    expect(store.reviewMarks.list(task.id)).toMatchObject([{ path: 'src/a.ts', mark: 'returned', comment: '再改改' }])
  })

  it('continueTask 抛错 ⇒ 不落标记(标记只在续接成功之后)', () => {
    const { domain, task, good, store, stub } = setup()
    stub({ continueTask: vi.fn(() => { throw new Error('workbench_busy') }) })
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改' })).toThrow('workbench_busy')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })

  it('run 还在写 ⇒ workbench_busy,不投递不落标记', () => {
    const { domain, task, good, store, state, stub } = setup()
    state.runsByTask.set(task.id, { identity: 'run-1' } as unknown as Active)
    stub({ isReplied: () => false })
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改' })).toThrow('workbench_busy')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })

  it('run 已答复 ⇒ 走 submitInput(runId=identity,requestId 从打回本身派生),回执之后才落标记', async () => {
    const { domain, task, good, store, state, actions, stub } = setup()
    state.runsByTask.set(task.id, { identity: 'run-1' } as unknown as Active)
    stub({ isReplied: () => true })
    const pending = domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '再改改' })
    expect(pending).toBeInstanceOf(Promise)
    expect(store.reviewMarks.list(task.id)).toEqual([])
    await pending
    const submitInput = actions.deref().submitInput as ReturnType<typeof vi.fn>
    const sha = store.artifact(task.id, good).sha256
    expect(submitInput).toHaveBeenCalledWith(task.id, { runId: 'run-1', requestId: derivedReturnRequestId(sha, ['src/a.ts'], '再改改', 'run-1'), text: expect.stringContaining('src/a.ts') })
    expect(store.reviewMarks.list(task.id)).toMatchObject([{ path: 'src/a.ts', mark: 'returned' }])
  })

  it('路径列表畸形 / 意见为空 ⇒ invalid_review_reference,且不碰 actions', () => {
    const { domain, task, good, store } = setup()
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: [], comment: '再改改' })).toThrow('invalid_review_reference')
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '   ' })).toThrow('invalid_review_reference')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })
})

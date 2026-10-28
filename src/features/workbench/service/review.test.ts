import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { createProviderRegistry } from '../../../app/provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../../../adapters/store/workbench/store'
import { saveArtifactSnapshot } from '../../../adapters/workbench/artifacts'
import { GIT_REVIEW_MIME, serializeGitReview, type GitReview, type ReviewFile } from '../git-review'
import { derivedCommentsRequestId, derivedReturnRequestId } from '../review'
import { createHash } from 'node:crypto'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeReviewDomain, type ReviewDomains } from './review'
import type { ServiceCtx } from './ctx'

/** review 从别的域拿的三个动作;每个测试用 stub() 换成自己的假货。 */
type Fakes = ReviewDomains['view'] & ReviewDomains['inputs'] & ReviewDomains['execute']

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, preexisting: false, kind: 'modified', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), diff: `@@ -1 +1 @@\n-老 ${path}\n+新 ${path}`, ...over })
const review = (files: ReviewFile[], over: Partial<GitReview> = {}): GitReview => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: 'h1', headAfter: 'h2', status: 'complete', preexistingPaths: [], notes: [], files, ...over })

/** 最小 ctx:真 store(标记与成果要落库)、空运行时状态、假 hub、假的三个跨域动作。不建 service。 */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-review-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const task = store.create({ title: '做点事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry() }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now }
  const gates = { busy: false, checking: false }
  // 注入给 review 的是转发到 fakes 的薄包装:测试在建好域之后才 stub(),没 stub 就调到 ⇒ 当场报错
  let fakes: Fakes | null = null
  const use = (): Fakes => { if (!fakes) throw new Error('not_stubbed'); return fakes }
  const actions = { get current() { return fakes }, deref: use }
  const domain = makeReviewDomain(ctx, {
    scripts: { busy: () => gates.busy },
    until: { checking: () => gates.checking },
    view: { isReplied: running => use().isReplied(running) },
    inputs: { submitInput: (...args) => use().submitInput(...args) },
    execute: { continueTask: (...args) => use().continueTask(...args) },
  })
  const plant = (name: string, bytes: Buffer) => { saveArtifactSnapshot(store, task.id, { name, mime: GIT_REVIEW_MIME, bytes }, stateDir); return store.artifacts(task.id).find(a => a.name === name)!.id }
  const good = plant('代码变更-run1.json', serializeGitReview(review([file('src/a.ts'), file('src/big.bin', { kind: 'not_reviewed', reason: '二进制文件未展开', beforeSha256: undefined, afterSha256: undefined, diff: undefined })])))
  const broken = plant('代码变更-坏.json', Buffer.from('{这不是 JSON'))
  const view = { id: task.id } as never
  const stub = (over: Partial<Fakes> = {}) => { fakes = { submitInput: vi.fn(async () => ({ id: 'li' } as never)), continueTask: vi.fn(() => view), isReplied: () => false, ...over } }
  return { store, task, state, hub, actions, domain, good, broken, stub, gates, project }
}

describe('makeReviewDomain', () => {
  it('构造时不调注入的跨域动作(那时别的域可能还没建好)', () => {
    const { actions } = setup()
    expect(actions.current).toBeNull()
  })

  it('reviewList:好快照列文件,坏快照 unavailable', () => {
    const { domain, task, good, broken } = setup()
    const list = domain.reviewList(task.id)
    expect(list.map(t => t.artifactId)).toEqual([broken, good])
    expect(list[0]).toMatchObject({ status: 'unavailable', files: [] })
    expect(list[1]!.files.map(f => f.kind)).toEqual(['modified', 'not_reviewed'])
    // 风险标记(B6):普通文件不带 risk 字段
    expect(list[1]!.files[0]).not.toHaveProperty('risk')
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

  it('路径列表畸形 / 意见为空 ⇒ invalid_review_reference,且不碰跨域动作', () => {
    const { domain, task, good, store } = setup()
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: [], comment: '再改改' })).toThrow('invalid_review_reference')
    expect(() => domain.returnReviewFiles(task.id, { artifactId: good, paths: ['src/a.ts'], comment: '   ' })).toThrow('invalid_review_reference')
    expect(store.reviewMarks.list(task.id)).toEqual([])
  })

  it('撤回类写动作(整文件 / 按块):检查命令或工作区脚本在跑 ⇒ workbench_busy,不读不写', () => {
    const { domain, task, good, gates } = setup()
    const hunkSha = createHash('sha256').update('@@ -1 +1 @@\n-老 src/a.ts\n+新 src/a.ts', 'utf8').digest('hex')
    const hunk = () => domain.revertReviewHunk(task.id, { artifactId: good, path: 'src/a.ts', hunk: 0, hunkSha256: hunkSha, action: 'revert' })
    const file = () => domain.revertReviewFile(task.id, { artifactId: good, path: 'src/a.ts' })
    for (const key of ['checking', 'busy'] as const) {
      gates[key] = true
      expect(hunk).toThrow('workbench_busy'); expect(file).toThrow('workbench_busy')
      gates[key] = false
    }
    // 门都开着:文件不在盘上 ⇒ 之后又被改过
    expect(hunk).toThrow('review_file_changed'); expect(file).toThrow('review_file_changed')
  })

  it('sendReviewComments 走同一个 deliver:在写 ⇒ busy;答复过 ⇒ submitInput(派生 id 带 run identity);结束了 ⇒ continueTask;成功后才记已发出', async () => {
    const { domain, task, good, store, state, actions, stub } = setup()
    const sha256 = store.artifact(task.id, good).sha256
    const diff = '@@ -1 +1 @@\n-老 src/a.ts\n+新 src/a.ts'
    const hunkSha256 = createHash('sha256').update(diff, 'utf8').digest('hex')
    const id = '22222222-2222-4222-8222-222222222222'
    domain.reviewComment(task.id, { commentId: id, artifactId: good, path: 'src/a.ts', hunk: 0, hunkSha256, body: '改' })
    expect(store.reviewComments.get(id)).toMatchObject({ artifactSha256: sha256, quote: '-老 src/a.ts\n+新 src/a.ts', side: 'new', lineStart: 1, lineEnd: 1 })
    state.runsByTask.set(task.id, { identity: 'run-1' } as unknown as Active)
    let replied = false
    const submit = vi.fn(async () => ({ id: 'li' } as never))
    stub({ isReplied: () => replied, submitInput: submit })
    expect(() => domain.sendReviewComments(task.id, {})).toThrow('workbench_busy')
    replied = true
    submit.mockImplementationOnce(async () => { throw new Error('input_limit') })
    await expect(domain.sendReviewComments(task.id, {})).rejects.toThrow('input_limit')
    expect(store.reviewComments.get(id)!.state).toBe('draft')
    const out = await domain.sendReviewComments(task.id, {})
    expect(out).toMatchObject({ input: { id: 'li' }, sent: 1, remaining: 0, skippedDiscarded: 0 })
    const call = submit.mock.calls[1]! as unknown[]
    expect(call[1]).toMatchObject({ runId: 'run-1', requestId: derivedCommentsRequestId([{ id, body: '改' }], '', [], 'run-1') })
    expect(store.reviewComments.get(id)).toMatchObject({ state: 'sent', sentRequestId: derivedCommentsRequestId([{ id, body: '改' }], '', [], 'run-1') })
    // 结束了 ⇒ continueTask,派生 id 的 scope 是 continue;给了 inputRequestId 就用它
    state.runsByTask.delete(task.id)
    const id2 = '33333333-3333-4333-8333-333333333333'
    domain.reviewComment(task.id, { commentId: id2, artifactId: good, path: 'src/a.ts', hunk: 0, hunkSha256, body: '再改' })
    expect(domain.sendReviewComments(task.id, { summary: '总的' })).toMatchObject({ task: { id: task.id }, sent: 1 })
    expect((actions.deref().continueTask as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual({ inputRequestId: derivedCommentsRequestId([{ id: id2, body: '再改' }], '总的', [], 'continue') })
  })

  it('sendReviewComments:投递途中主人改了某条草稿 ⇒ 那条不记已发出(发出去的是旧正文),别的照记', async () => {
    const { domain, task, good, store, state, stub } = setup()
    const diff = '@@ -1 +1 @@\n-老 src/a.ts\n+新 src/a.ts'
    const hunkSha256 = createHash('sha256').update(diff, 'utf8').digest('hex')
    const a = '44444444-4444-4444-8444-444444444444', b = '55555555-5555-4555-8555-555555555555'
    for (const [commentId, body] of [[a, '旧的 a'], [b, '旧的 b']]) domain.reviewComment(task.id, { commentId: commentId!, artifactId: good, path: 'src/a.ts', hunk: 0, hunkSha256, body: body! })
    state.runsByTask.set(task.id, { identity: 'run-1' } as unknown as Active)
    let sent = ''
    stub({ isReplied: () => true, submitInput: vi.fn(async (_id: string, input: { text: string }) => {
      sent = input.text
      await Promise.resolve()
      domain.reviewComment(task.id, { commentId: a, body: '新的 a' })   // 投递还没回来时主人改了
      return { id: 'li' } as never
    }) })
    const out = await domain.sendReviewComments(task.id, {})
    expect(out).toMatchObject({ sent: 2 })
    expect(sent).toContain('意见:旧的 a')
    expect(store.reviewComments.get(a)).toMatchObject({ state: 'draft', body: '新的 a' })
    expect(store.reviewComments.get(b)!.state).toBe('sent')
  })
})

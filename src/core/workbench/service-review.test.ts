import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTestDb, type Db } from '../../lib/db'
import { makeWorkbenchStore, type WorkbenchStore } from './store'
import { makeWorkbenchService, type WorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import { MANAGED_NATIVE_CAPABILITIES } from './executor-capabilities'
import type { AgentEvent, AgentProvider, AgentRuntimeSnapshot, AgentSession, AgentWorkbenchRuntime } from '../agent-provider'
import { AsyncQueue } from '../async-queue'
import type { LiveInput } from './live-inputs'
import { saveArtifactSnapshot } from './artifacts'
import { GIT_REVIEW_MIME, serializeGitReview, type GitReview, type ReviewFile } from './git-review'
import { removeTempDir } from '../../lib/test-temp'

// 照 service-unattended.test.ts:先 shutdown 所有 service、再 close db、最后删目录 ——
// 否则删的是一个还在跑的 run 底下的目录。
const services: WorkbenchService[] = []
const dbs: Db[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})

/** 每轮都能跑完的假执行者;resume 时沿用 resumeSessionId,让 continueTask 走「接着说」而不是要求重开。 */
function fakeProvider(): AgentProvider {
  let index = 0
  return {
    async spawn(_project, context) {
      const sessionId = context.resumeSessionId ?? `native-${index++}`
      return {
        async *dispatch() {
          yield { kind: 'init' as const, sessionId }
          yield { kind: 'text' as const, text: '好了' }
          yield { kind: 'result' as const, sessionId, numTurns: 1, durationMs: 1 }
        },
        async close() {},
      }
    },
  }
}

function tempRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  return { stateDir, project }
}

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, preexisting: false, kind: 'modified', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), diff: `@@ -1 +1 @@\n-老 ${path}\n+新 ${path}`, ...over })
const review = (files: ReviewFile[], over: Partial<GitReview> = {}): GitReview => ({ version: 1, scope: 'working-tree-before-after', startedAt: 1, finishedAt: 2, headBefore: 'h1', headAfter: 'h2', status: 'complete', preexistingPaths: [], notes: [], files, ...over })

function setup(canResume = true) {
  const { stateDir, project } = tempRoot('wb-review-')
  const db = openTestDb(); dbs.push(db)
  const store = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', fakeProvider(), { displayName: 'Claude', canResume: () => canResume, workbench: MANAGED_NATIVE_CAPABILITIES })
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' })
  services.push(service)
  return { service, store, stateDir, project }
}

async function completedTask(service: WorkbenchService, project: string, text = '做点事') {
  const task = service.create({ path: project, providerId: 'claude', text, execution: { defaults: 'provider', model: null, reasoningEffort: null } })
  await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
  return task
}

function plant(store: WorkbenchStore, taskId: string, stateDir: string, name: string, bytes: Buffer) {
  saveArtifactSnapshot(store, taskId, { name, mime: GIT_REVIEW_MIME, bytes }, stateDir)
  return store.artifacts(taskId).find(a => a.name === name)!.id
}

/** 三轮:两份合法快照 + 一份坏 JSON(mime 对、内容坏)。 */
async function planted(canResume = true) {
  const fixture = setup(canResume)
  const task = await completedTask(fixture.service, fixture.project)
  const first = plant(fixture.store, task.id, fixture.stateDir, '代码变更-run1.json', serializeGitReview(review([file('src/a.ts'), file('src/big.bin', { kind: 'not_reviewed', reason: '二进制文件未展开', beforeSha256: undefined, afterSha256: undefined, diff: undefined })])))
  const second = plant(fixture.store, task.id, fixture.stateDir, '代码变更-run2.json', serializeGitReview(review([file('src/a.ts'), file('src/b.ts')], { status: 'partial', notes: ['读取超时，其余文件尚未检查。'] })))
  const broken = plant(fixture.store, task.id, fixture.stateDir, '代码变更-坏.json', Buffer.from('{这不是 JSON'))
  return { ...fixture, id: task.id, first, second, broken }
}

describe('reviewList', () => {
  it('新→旧列出每一轮变更快照;坏快照单独标 unavailable 且带说明,不影响其它轮', async () => {
    const { service, id, first, second, broken } = await planted()
    const list = service.reviewList(id)
    expect(list.map(t => t.artifactId)).toEqual([broken, second, first])
    expect(list[0]).toMatchObject({ name: '代码变更-坏.json', status: 'unavailable', files: [], headBefore: null, headAfter: null })
    expect(list[0]!.notes.length).toBeGreaterThan(0)
    expect(list[1]).toMatchObject({ name: '代码变更-run2.json', status: 'partial', headBefore: 'h1', headAfter: 'h2' })
    expect(list[1]!.files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(list[2]!.files.map(f => f.kind)).toEqual(['modified', 'not_reviewed'])
    expect(list.every(t => t.files.every(f => f.mark === undefined))).toBe(true)
  })

  it('只看 review mime 的成果', async () => {
    const { service, store, stateDir, id } = await planted()
    saveArtifactSnapshot(store, id, { name: '别的.txt', mime: 'text/plain', bytes: Buffer.from('无关') }, stateDir)
    expect(service.reviewList(id)).toHaveLength(3)
  })
})

describe('markReviewFile', () => {
  it('成功后该文件带上标记,重复标记覆盖', async () => {
    const { service, id, second } = await planted()
    const mark = service.markReviewFile(id, { artifactId: second, path: 'src/a.ts', mark: 'accepted' })
    expect(mark).toMatchObject({ taskId: id, path: 'src/a.ts', mark: 'accepted', comment: '' })
    const turn = service.reviewList(id).find(t => t.artifactId === second)!
    expect(turn.files.find(f => f.path === 'src/a.ts')!.mark).toMatchObject({ mark: 'accepted', comment: '' })
    expect(turn.files.find(f => f.path === 'src/b.ts')!.mark).toBeUndefined()
    service.markReviewFile(id, { artifactId: second, path: 'src/a.ts', mark: 'returned', comment: '再改改' })
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.find(f => f.path === 'src/a.ts')!.mark).toMatchObject({ mark: 'returned', comment: '再改改' })
  })

  it('标记只落在自己那一轮,不串到同路径的另一轮', async () => {
    const { service, id, first, second } = await planted()
    service.markReviewFile(id, { artifactId: first, path: 'src/a.ts', mark: 'accepted' })
    const list = service.reviewList(id)
    expect(list.find(t => t.artifactId === first)!.files.find(f => f.path === 'src/a.ts')!.mark).toBeDefined()
    expect(list.find(t => t.artifactId === second)!.files.find(f => f.path === 'src/a.ts')!.mark).toBeUndefined()
  })

  it('not_reviewed 的文件不能标记', async () => {
    const { service, id, first } = await planted()
    expect(() => service.markReviewFile(id, { artifactId: first, path: 'src/big.bin', mark: 'accepted' })).toThrow('review_file_unmarkable')
  })

  it('快照里没有的路径、坏快照、非 review 成果 ⇒ invalid_review_reference', async () => {
    const { service, store, stateDir, id, first, broken } = await planted()
    expect(() => service.markReviewFile(id, { artifactId: first, path: 'src/never.ts', mark: 'accepted' })).toThrow('invalid_review_reference')
    expect(() => service.markReviewFile(id, { artifactId: broken, path: 'src/a.ts', mark: 'accepted' })).toThrow('invalid_review_reference')
    saveArtifactSnapshot(store, id, { name: '别的.txt', mime: 'text/plain', bytes: Buffer.from('无关') }, stateDir)
    const plain = store.artifacts(id).find(a => a.name === '别的.txt')!.id
    expect(() => service.markReviewFile(id, { artifactId: plain, path: 'src/a.ts', mark: 'accepted' })).toThrow('invalid_review_reference')
  })

  it('别的任务的成果 ⇒ not_found', async () => {
    const { service, store, stateDir, project, id } = await planted()
    const other = await completedTask(service, project, '另一件事')
    const alien = plant(store, other.id, stateDir, '代码变更-别处.json', serializeGitReview(review([file('src/other.ts')])))
    expect(() => service.markReviewFile(id, { artifactId: alien, path: 'src/other.ts', mark: 'accepted' })).toThrow('not_found')
  })
})

describe('returnReviewFiles', () => {
  it('写 returned 标记、把路径/意见/diff 节选交给 continueTask,任务重新跑完', async () => {
    const { service, id, second } = await planted()
    const view = await service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了' })
    expect(view.id).toBe(id)
    const turn = service.reviewList(id).find(t => t.artifactId === second)!
    expect(turn.files.map(f => f.mark?.mark)).toEqual(['returned', 'returned'])
    expect(turn.files[0]!.mark!.comment).toBe('这两处判空漏了')
    const text = service.detail(id).events.filter(e => e.kind === 'user').at(-1)!.text
    expect(text).toContain('src/a.ts')
    expect(text).toContain('src/b.ts')
    expect(text).toContain('这两处判空漏了')
    expect(text).toContain('+新 src/a.ts')
    expect(text).toContain('+新 src/b.ts')
    await vi.waitFor(() => expect(service.detail(id).task.status).toBe('completed'))
  })

  it('paths 为空、超过 20 个、comment 为空或过长 ⇒ invalid_review_reference', async () => {
    const { service, id, second } = await planted()
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: [], comment: '改' })).toThrow('invalid_review_reference')
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: Array.from({ length: 21 }, () => 'src/a.ts'), comment: '改' })).toThrow('invalid_review_reference')
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '   ' })).toThrow('invalid_review_reference')
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '长'.repeat(2001) })).toThrow('invalid_review_reference')
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.every(f => f.mark === undefined)).toBe(true)
    expect(service.detail(id).task.status).toBe('completed')
  })

  it('有一个路径不可打回就整笔拒绝,不留半截标记', async () => {
    const { service, id, first } = await planted()
    expect(() => service.returnReviewFiles(id, { artifactId: first, paths: ['src/a.ts', 'src/big.bin'], comment: '改' })).toThrow('review_file_unmarkable')
    expect(() => service.returnReviewFiles(id, { artifactId: first, paths: ['src/a.ts', 'src/never.ts'], comment: '改' })).toThrow('invalid_review_reference')
    expect(service.reviewList(id).find(t => t.artifactId === first)!.files.every(f => f.mark === undefined)).toBe(true)
  })

  it('别的任务的成果 ⇒ not_found', async () => {
    const { service, store, stateDir, project, id } = await planted()
    const other = await completedTask(service, project, '另一件事')
    const alien = plant(store, other.id, stateDir, '代码变更-别处.json', serializeGitReview(review([file('src/other.ts')])))
    expect(() => service.returnReviewFiles(id, { artifactId: alien, paths: ['src/other.ts'], comment: '改' })).toThrow('not_found')
  })

  // 评审(2026-09-17):restart_confirmation_required 是设计内的首次回应,workbench_busy 是常见抢跑 ——
  // 标记先落会让主人常态化看到「已打回」却根本没发出去。
  it('续接被拒(已归档)⇒ 错误原样透传,一条 returned 标记都不留', async () => {
    const { service, id, second } = await planted()
    service.setArchived(id, true)
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了' })).toThrow('workbench_archived')
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.every(f => f.mark === undefined)).toBe(true)
    // 解档后同一笔打回照旧成立,标记这才落下。
    service.setArchived(id, false)
    service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了' })
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.map(f => f.mark?.mark)).toEqual(['returned', 'returned'])
    await vi.waitFor(() => expect(service.detail(id).task.status).toBe('completed'))
  })

  // 终审(2026-09-17):原会话不能恢复时,打回不能变成死胡同 —— 第一次如实说「要重开」且一条标记都不留,
  // 主人拿着同一张预览里的令牌再发一次就该成立。
  it('原会话不可恢复 ⇒ 先要 restart_confirmation_required 且不留标记;带上令牌再发就成立', async () => {
    const { service, id, second } = await planted(false)
    const attempt = () => service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了' })
    expect(attempt).toThrow('restart_confirmation_required')
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.every(f => f.mark === undefined)).toBe(true)
    const continuation = service.prepareContinuation(id)
    expect(continuation.mode).toBe('restart_required')
    expect(service.detail(id).continuation?.restart?.token).toBe(continuation.restart!.token)
    // 令牌不对 ⇒ 还是不发、也不留标记。
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '改', restartToken: 'f'.repeat(64) })).toThrow('restart_confirmation_stale')
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.every(f => f.mark === undefined)).toBe(true)
    const view = await service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了', restartToken: continuation.restart!.token })
    expect(view.id).toBe(id)
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.map(f => f.mark?.mark)).toEqual(['returned', 'returned'])
    const text = service.detail(id).events.filter(e => e.kind === 'user').at(-1)!.text
    expect(text).toContain('src/a.ts')
    expect(text).toContain('这两处判空漏了')
    await vi.waitFor(() => expect(service.detail(id).task.status).toBe('completed'))
  })

  it('同一个 inputRequestId 重发只跑一轮;畸形的 id 连标记都不留', async () => {
    const { service, id, second } = await planted()
    expect(() => service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '改', inputRequestId: '不是-uuid' })).toThrow('invalid_request')
    expect(service.reviewList(id).find(t => t.artifactId === second)!.files.every(f => f.mark === undefined)).toBe(true)
    const inputRequestId = randomUUID()
    service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '再改' , inputRequestId })
    await vi.waitFor(() => expect(service.detail(id).task.status).toBe('completed'))
    service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '再改', inputRequestId })
    expect(service.detail(id).events.filter(e => e.kind === 'user' && e.text.startsWith('打回以下改动'))).toHaveLength(1)
  })
})

/**
 * 保留会话(Claude)答复之后 `status` 一直是 running:打回若照旧走 `continueTask`,那道
 * `runsByTask.has(id) ⇒ workbench_busy` 的门会让「打回」永远送不到(评审 2026-09-21 #7)。
 * 会话还留着就该按续接投递 —— 和主人自己在输入框里补一句话是同一条路。
 */
const RETAINED_RESULT: AgentEvent = { kind: 'result', sessionId: 'retained-session', numTurns: 1, durationMs: 1 }
class RetainedRuntime {
  queue = new AsyncQueue<AgentEvent>()
  state: AgentRuntimeSnapshot = { retained: true, foreground: 'running', backgroundCount: 0, input: 'send' }
  subscribed = false; submitted = 0; texts: string[] = []
  runtime: AgentWorkbenchRuntime = {
    events: { [Symbol.asyncIterator]: () => { this.subscribed = true; return this.queue.iterable()[Symbol.asyncIterator]() } },
    start: () => { this.queue.push({ kind: 'init', sessionId: 'retained-session' }); this.queue.push({ kind: 'text', itemId: 't0', text: '做。' }) },
    // 投递成功不等于新回合已经开始:原生会话要到真动起来才报 running。主人的重发(桌面重试、
    // 长轮询回来又点一次)正落在这个窗口里 —— 幂等要在这里成立。
    submit: async (_id, text) => { this.submitted++; this.texts.push(text) },
    snapshot: () => this.state,
  }
  session: AgentSession = { workbenchRuntime: this.runtime, async *dispatch() {}, close: async () => { this.queue.end() } }
  finishTurn() { this.state = { ...this.state, foreground: 'idle', backgroundCount: 0 }; this.queue.push(RETAINED_RESULT) }
}

/** 一条还活着的保留会话 + 一份可打回的变更快照。 */
async function retained() {
  const { stateDir, project } = tempRoot('wb-review-live-')
  const db = openTestDb(); dbs.push(db)
  const store = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  const runtimes: RetainedRuntime[] = []
  registry.register('claude', { async spawn() { const r = new RetainedRuntime(); runtimes.push(r); return r.session } }, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' })
  services.push(service)
  const task = service.create({ path: project, providerId: 'claude', text: '做点事' })
  await vi.waitFor(() => expect(service.detail(task.id).events.some(e => e.kind === 'text')).toBe(true))
  const artifactId = plant(store, task.id, stateDir, '代码变更-run1.json', serializeGitReview(review([file('src/a.ts'), file('src/b.ts')])))
  return { service, store, id: task.id, artifactId, runtime: runtimes[0]! }
}
const marksOf = (service: WorkbenchService, id: string, artifactId: string) =>
  service.reviewList(id).find(t => t.artifactId === artifactId)!.files.map(f => f.mark?.mark)

describe('returnReviewFiles · 保留会话(评审 2026-09-21 #7)', () => {
  it('答复之后打回:走 submitInput 投给同一条会话,回执 sending,标记在回执之后才落', async () => {
    const { service, id, artifactId, runtime } = await retained()
    runtime.finishTurn()
    await vi.waitFor(() => expect(service.detail(id).task.phase).toBe('replied'))
    const receipt = await service.returnReviewFiles(id, { artifactId, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了' }) as LiveInput
    expect(receipt).toMatchObject({ taskId: id, runId: service.detail(id).runId, status: 'sending' })
    expect(receipt.text).toContain('src/a.ts')
    expect(receipt.text).toContain('这两处判空漏了')
    expect(receipt.text).toContain('+新 src/b.ts')
    expect(runtime.submitted).toBe(1)
    expect(runtime.texts[0]).toBe(receipt.text)
    expect(marksOf(service, id, artifactId)).toEqual(['returned', 'returned'])
    // 会话没有被重开:还是原来那条 run。
    expect(service.detail(id).task.status).toBe('running')
  })

  it('同一笔打回重发 ⇒ 落幂等分支,不会投第二遍', async () => {
    const { service, id, artifactId, runtime } = await retained()
    runtime.finishTurn()
    await vi.waitFor(() => expect(service.detail(id).task.phase).toBe('replied'))
    const input = { artifactId, paths: ['src/a.ts', 'src/b.ts'], comment: '这两处判空漏了' }
    const first = await service.returnReviewFiles(id, input) as LiveInput
    const again = await service.returnReviewFiles(id, input) as LiveInput
    expect(again.id).toBe(first.id)
    expect(runtime.submitted).toBe(1)
    expect(service.detail(id).inputs.filter(i => i.text.startsWith('打回以下改动'))).toHaveLength(1)
    expect(marksOf(service, id, artifactId)).toEqual(['returned', 'returned'])
  })

  it('会话还在写时打回 ⇒ workbench_busy,一条标记都不留', async () => {
    const { service, id, artifactId } = await retained()
    expect(service.detail(id).task.phase).toBe('working')
    expect(() => service.returnReviewFiles(id, { artifactId, paths: ['src/a.ts'], comment: '改' })).toThrow('workbench_busy')
    expect(marksOf(service, id, artifactId)).toEqual([undefined, undefined])
  })

  it('已经结算的任务照旧走 continueTask:回的是任务视图,不是回执', async () => {
    const { service, id, second } = await planted()
    const view = await service.returnReviewFiles(id, { artifactId: second, paths: ['src/a.ts'], comment: '改' })
    expect('phase' in view).toBe(true)
    expect('runId' in view).toBe(false)
    expect(view.id).toBe(id)
    await vi.waitFor(() => expect(service.detail(id).task.status).toBe('completed'))
  })
})

import { describe, expect, it, vi } from 'vitest'
import { openTestDb } from '../../../lib/db'
import { makeWorkbenchStore } from '../../../adapters/store/workbench/store'
import { makeUntilDomain, UNTIL_CHECK_TIMEOUT_MS, type UntilDomains } from './until'
import { untilRequestId } from '../../../adapters/workbench/until'
import type { ScriptExit } from '../script-runner'
import type { Active } from './state'
import type { ServiceCtx } from './ctx'

// 做到条件成立为止(spec 2026-10-20-workbench-until-design §跑的时候)
const exit = (code: number | null, tail = ''): ScriptExit => ({ code, signal: null, timedOut: false, stopped: false, error: null, tail })

function setup(o: { exit?: ScriptExit; maxRounds?: number; retained?: boolean; caps?: object } = {}) {
  const db = openTestDb()
  const store = makeWorkbenchStore(db)
  const t = store.create({ title: 't', path: '/tmp/wt/abc', providerId: 'claude', ownerChatId: 'owner' })
  store.worktrees.record({ taskId: t.id, projectPath: '/tmp/p', repoRoot: '/tmp/p', root: '/tmp/wt/abc', branch: 'cc/abc' })
  store.goals.create(t.id, { command: 'bun run test', maxRounds: o.maxRounds ?? 3 })
  const runsByTask = new Map<string, Active>()
  const running = { identity: 'run-1', taskId: t.id, turnSeq: 1, cancelled: false, task: t } as unknown as Active
  if (o.retained !== false) runsByTask.set(t.id, running)
  const submitInput = vi.fn(async (_id: string, _input: { runId: string; requestId: string; text: string }) => ({}) as never)
  const continueTask = vi.fn((_id: string, _text: string, _options: { inputRequestId: string }) => ({}) as never)
  // 同 service.ts 的 resumeAfterCheck:会话还开着 ⇒ 投补充;收工了 ⇒ 续一轮
  const domains: UntilDomains = {
    view: { isReplied: () => true },
    resume: (id, text, requestId, current) => {
      if (current) return submitInput(id, { runId: current.identity, requestId, text })
      continueTask(id, text, { inputRequestId: requestId })
      return undefined
    },
  }
  const released: string[] = []
  const ctx = {
    store, stateDir: '/tmp/s', now: Date.now, ensureAccepting: () => {},
    state: { runsByTask, stopping: false } as never,
    hub: { touched: () => {}, bumped: () => {}, dispose: () => {} },
    deps: { registry: { get: () => ({ opts: { workbench: o.caps ?? { attended: true } } }) }, holdBusy: (l: string) => () => released.push(l) } as never,
  } as unknown as ServiceCtx
  let result = o.exit ?? exit(0, 'ok')
  const starts: Array<{ cwd: string; script: string; kind: string; timeoutMs?: number }> = []
  const start = vi.fn((input: { cwd: string; script: string; kind: string; timeoutMs?: number }) => { starts.push(input); return { pgid: 1, stop: async () => {}, done: Promise.resolve(result) } })
  const until = makeUntilDomain(ctx, domains, { start: start as never, isUnattended: c => (c as { attended?: boolean }).attended === false })
  const events = () => store.events(t.id).map(e => e.text).filter(Boolean)
  return { ctx, domains, store, t, running, runsByTask, until, submitInput, continueTask, starts, released, events, setExit: (e: ScriptExit) => { result = e } }
}

describe('until domain', () => {
  it('passes ⇒ goal passed, one event, no continuation; ran in the worktree root with the 10-minute timeout', async () => {
    const s = setup()
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.starts).toEqual([expect.objectContaining({ cwd: '/tmp/wt/abc', script: 'bun run test', kind: 'check', timeoutMs: UNTIL_CHECK_TIMEOUT_MS })])
    expect(s.store.goals.get(s.t.id)).toMatchObject({ status: 'passed', rounds: 1, lastExit: 0 })
    expect(s.events().some(x => x.includes('检查通过(第 1 轮)'))).toBe(true)
    expect(s.submitInput).not.toHaveBeenCalled()
    expect(s.released).toEqual([`wt-check:${s.t.id}`])
  })
  it('fails ⇒ continues the retained session with a derived request id and a wrapped tail', async () => {
    const s = setup({ exit: exit(1, 'FAIL x.test.ts') })
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.submitInput).toHaveBeenCalledTimes(1)
    const [id, input] = s.submitInput.mock.calls[0] as unknown as [string, { runId: string; requestId: string; text: string }]
    expect(id).toBe(s.t.id)
    expect(input.runId).toBe('run-1')
    expect(input.requestId).toBe(untilRequestId(s.t.id, 1))
    expect(input.text).toContain('<check_output>\nFAIL x.test.ts\n</check_output>')
    expect(s.store.goals.get(s.t.id)).toMatchObject({ status: 'active', rounds: 1, lastExit: 1 })
  })
  it('the same turn is checked once', async () => {
    const s = setup({ exit: exit(1) })
    s.until.afterTurn(s.running); s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.starts).toHaveLength(1)
  })
  it('fails on the last round ⇒ exhausted, no continuation', async () => {
    const s = setup({ exit: exit(2), maxRounds: 1 })
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.store.goals.get(s.t.id)).toMatchObject({ status: 'exhausted', rounds: 1 })
    expect(s.submitInput).not.toHaveBeenCalled()
    expect(s.events().some(x => x.includes('到上限还没过'))).toBe(true)
  })
  it('owner has a queued input ⇒ this turn is skipped, goal stays active', async () => {
    const s = setup()
    s.store.liveInputs.add({ id: '22222222-2222-4222-8222-222222222222', taskId: s.t.id, runId: 'run-1', text: '先改别的' })
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.starts).toHaveLength(0)
    expect(s.store.goals.get(s.t.id)).toMatchObject({ status: 'active', rounds: 0 })
  })
  it.each([
    ['archived', (s: ReturnType<typeof setup>) => { s.store.update(s.t.id, 'completed'); s.store.setArchived(s.t.id, true) }, '归档'],
    ['worktree removed', (s: ReturnType<typeof setup>) => s.store.worktrees.markRemoved(s.t.id), '独立工作区'],
    ['network suspended', (s: ReturnType<typeof setup>) => { (s.running as { networkSuspended?: object }).networkSuspended = { since: 1 } }, '网络'],
  ])('%s ⇒ stopped with a reason, the command never runs', async (_n, arrange, reason) => {
    const s = setup()
    arrange(s)
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.starts).toHaveLength(0)
    const g = s.store.goals.get(s.t.id)!
    expect(g.status).toBe('stopped')
    expect(g.stopReason).toContain(reason)
  })
  it('unattended executor ⇒ stopped', async () => {
    const s = setup({ caps: { attended: false } })
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.starts).toHaveLength(0)
    expect(s.store.goals.get(s.t.id)!.stopReason).toContain('免审')
  })
  it('a new turn started while checking ⇒ result discarded, nothing sent', async () => {
    const s = setup({ exit: exit(1) })
    s.until.afterTurn(s.running)
    ;(s.running as { turnSeq: number }).turnSeq = 2
    await s.until.idle(s.t.id)
    expect(s.submitInput).not.toHaveBeenCalled()
    expect(s.store.goals.get(s.t.id)).toMatchObject({ status: 'active', rounds: 0 })
  })
  it('settled session ⇒ continueTask; restart confirmation needed ⇒ stopped with a reason', async () => {
    const s = setup({ exit: exit(1), retained: false })
    s.until.afterTurn(s.running)
    await s.until.idle(s.t.id)
    expect(s.continueTask).toHaveBeenCalledWith(s.t.id, expect.stringContaining('<check_output>'), { inputRequestId: untilRequestId(s.t.id, 1) })
    const s2 = setup({ exit: exit(1), retained: false })
    s2.continueTask.mockImplementation(() => { throw new Error('restart_confirmation_required') })
    s2.until.afterTurn(s2.running)
    await s2.until.idle(s2.t.id)
    expect(s2.store.goals.get(s2.t.id)).toMatchObject({ status: 'stopped' })
    expect(s2.store.goals.get(s2.t.id)!.stopReason).toContain('接不上')
  })
  it('stop(reason) ends an active goal once and notes it', () => {
    const s = setup()
    s.until.stop(s.t.id, '这一轮出错了')
    s.until.stop(s.t.id, '又一次')
    expect(s.store.goals.get(s.t.id)).toMatchObject({ status: 'stopped', stopReason: '这一轮出错了' })
    expect(s.events().filter(x => x.includes('停了')).length).toBe(1)
  })
})

describe('until domain · review #419', () => {
  function deferredSetup() {
    const s = setup()
    const gates: Array<{ resolve: (e: ScriptExit) => void; stopped: boolean }> = []
    const start = vi.fn(() => {
      let resolve!: (e: ScriptExit) => void
      const done = new Promise<ScriptExit>(r => { resolve = r })
      const g = { resolve, stopped: false }
      gates.push(g)
      return { pgid: 1, stop: async () => { g.stopped = true; resolve({ ...exit(null), stopped: true }) }, done }
    })
    return { s, gates, start }
  }
  it('a turn that finishes while an older check runs is checked afterwards (never dropped)', async () => {
    const { s, gates, start } = deferredSetup()
    // 用同一个 ctx 重建域,换成可控的 start
    const u = makeUntilDomain(s.ctx, s.domains, { start: start as never, isUnattended: () => false })
    u.afterTurn(s.running)                                   // 第 1 轮做完,检查开跑
    ;(s.running as { turnSeq: number }).turnSeq = 2          // 主人说了一句,第 2 轮也做完了
    u.afterTurn(s.running)                                   // 撞上在跑的检查:记下要补
    expect(start).toHaveBeenCalledTimes(1)
    gates[0]!.resolve(exit(1, 'old'))                        // 第 1 次的结果作废
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    gates[1]!.resolve(exit(1, 'FAIL new'))
    await u.idle(s.t.id)
    await vi.waitFor(() => expect(s.submitInput).toHaveBeenCalledTimes(1))
    expect((s.submitInput.mock.calls[0] as unknown as [string, { text: string }])[1].text).toContain('FAIL new')
    expect(s.store.goals.get(s.t.id)).toMatchObject({ rounds: 1, checkedTurn: 'run-1:2' })
  })
  it('settled path: a newer turn that ended during the check discards the stale result', async () => {
    const { s, gates, start } = deferredSetup()
    s.runsByTask.clear()
    const u = makeUntilDomain(s.ctx, s.domains, { start: start as never, isUnattended: () => false })
    u.afterTurn(s.running)
    const r2 = { ...s.running, identity: 'run-2', turnSeq: 0 } as Active
    u.afterTurn(r2)
    gates[0]!.resolve(exit(1, 'old'))
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(s.continueTask).not.toHaveBeenCalled()
    gates[1]!.resolve(exit(0, 'ok'))
    await vi.waitFor(() => expect(s.store.goals.get(s.t.id)?.status).toBe('passed'))
  })
  it('stop() kills the running check and releases busy', async () => {
    const { s, gates, start } = deferredSetup()
    const u = makeUntilDomain(s.ctx, s.domains, { start: start as never, isUnattended: () => false })
    u.afterTurn(s.running)
    u.stop(s.t.id, '你停下了这件事')
    expect(gates[0]!.stopped).toBe(true)
    await u.idle(s.t.id)
    expect(s.released).toEqual([`wt-check:${s.t.id}`])
    expect(s.submitInput).not.toHaveBeenCalled()
  })
})

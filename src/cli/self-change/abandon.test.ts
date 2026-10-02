import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyRun, describeRuns, formatRunRows, runAbandon, type AbandonDeps } from './abandon'
import { fakeState, memoryStore, testConfig } from './pipeline.fixture'
import type { GitResult } from './git'
import type { SelfChangeState } from './state'

const WORKDIR = '/w'
const HUB = join(WORKDIR, 'repo')
const tree = (id: string): string => join(WORKDIR, 'runs', id)
const NOW = 1_700_000_100_000

interface Harness {
  deps: AbandonDeps
  git: Array<{ args: string[]; cwd: string | undefined }>
  released: number
  store: ReturnType<typeof memoryStore>
}

function harness(opts: {
  rows?: SelfChangeState[]
  exists?: (p: string) => boolean
  git?: (args: string[]) => Partial<GitResult> | undefined
  /** 拿锁结果:缺省拿得到。 */
  lock?: { ok: false; holder: number }
  live?: { pid: number; runId: string | null } | null
} = {}): Harness {
  const store = memoryStore(opts.rows ?? [])
  const h: Harness = {
    store,
    git: [],
    released: 0,
    deps: undefined as unknown as AbandonDeps,
  }
  h.deps = {
    store,
    config: testConfig(),
    git: {
      run(args, o) {
        h.git.push({ args, cwd: o?.cwd })
        const r = opts.git?.(args)
        return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' }
      },
    },
    exists: opts.exists ?? (() => true),
    now: () => NOW,
    lock: () => opts.lock ?? { ok: true, release: () => { h.released += 1 } },
    liveHolder: () => opts.live ?? null,
  }
  return h
}

const removed = (h: Harness): string[] =>
  h.git.filter(g => g.args[0] === 'worktree' && g.args[1] === 'remove').map(g => g.args[3] ?? '')

describe('runAbandon', () => {
  it('被杀的那条(result 永远是 null)⇒ 记成 abandoned,在中枢里删掉它的工作树', () => {
    const h = harness({ rows: [fakeState({ id: 'kill1111', step: 'tests', result: null })] })
    const r = runAbandon(h.deps, 'kill1111')
    expect(r).toMatchObject({ ok: true, code: 'abandoned' })
    const s = h.store.load('kill1111')!
    expect(s.result).toBe('abandoned')
    expect(s.step).toBe('tests')
    expect(s.updatedAt).toBe(NOW)
    expect(s.error).toContain('tests')
    // 和顺手清理同一套:先 prune 再 worktree remove --force,都打在中枢上。
    expect(h.git.map(g => [g.args.join(' '), g.cwd])).toEqual([
      ['worktree prune', HUB],
      [`worktree remove --force ${tree('kill1111')}`, HUB],
    ])
    expect(r.message).toContain(tree('kill1111'))
    // 分支不删:提交还在中枢里,话要说清楚真扔怎么扔。
    expect(r.message).toContain('self/kill1111')
    expect(h.released).toBe(1)
  })

  it('可 --resume 的失败(approval_timeout)⇒ 一样作废,原来的结局写进 error', () => {
    const h = harness({ rows: [fakeState({ id: 'timeo111', step: 'approval', result: 'approval_timeout' })] })
    expect(runAbandon(h.deps, 'timeo111')).toMatchObject({ ok: true, code: 'abandoned' })
    const s = h.store.load('timeo111')!
    expect(s.result).toBe('abandoned')
    expect(s.error).toContain('approval_timeout')
    expect(removed(h)).toEqual([tree('timeo111')])
  })

  it('幂等:已经作废过 ⇒ 不改存盘,工作树还在就再删一次', () => {
    const h = harness({ rows: [fakeState({ id: 'aban1111', result: 'abandoned', error: '原话', updatedAt: 5 })] })
    const r = runAbandon(h.deps, 'aban1111')
    expect(r).toMatchObject({ ok: true, code: 'already_abandoned' })
    expect(h.store.load('aban1111')).toMatchObject({ result: 'abandoned', error: '原话', updatedAt: 5 })
    expect(removed(h)).toEqual([tree('aban1111')])

    // 工作树已经没了 ⇒ 一条 git 都不跑。
    const gone = harness({ rows: [fakeState({ id: 'aban1111', result: 'abandoned' })], exists: () => false })
    expect(runAbandon(gone.deps, 'aban1111')).toMatchObject({ ok: true, code: 'already_abandoned' })
    expect(gone.git).toEqual([])
  })

  it('done / declined 是终局 ⇒ 不改结局,只提前回收工作树', () => {
    for (const result of ['done', 'declined']) {
      const h = harness({ rows: [fakeState({ id: 'fini1111', result })] })
      expect(runAbandon(h.deps, 'fini1111')).toMatchObject({ ok: true, code: 'reclaimed' })
      expect(h.store.load('fini1111')!.result).toBe(result)
      expect(removed(h)).toEqual([tree('fini1111')])
    }
  })

  it('没有这条 ⇒ self_change_not_found,不拿锁不跑 git', () => {
    let locked = 0
    const h = harness()
    h.deps.lock = () => { locked += 1; return { ok: true, release: () => {} } }
    expect(runAbandon(h.deps, 'nope1111')).toMatchObject({ ok: false, code: 'self_change_not_found' })
    expect(locked).toBe(0)
    expect(h.git).toEqual([])
  })

  // 最要紧的一条:一条活着的运行,作废它等于从它脚底下把树抽走。
  it('持锁的就是这条 ⇒ self_change_running,存盘和工作树都不碰', () => {
    const h = harness({
      rows: [fakeState({ id: 'live1111', step: 'approval', result: null })],
      lock: { ok: false, holder: 4242 },
      live: { pid: 4242, runId: 'live1111' },
    })
    const r = runAbandon(h.deps, 'live1111')
    expect(r).toMatchObject({ ok: false, code: 'self_change_running' })
    expect(r.message).toContain('4242')
    expect(h.store.load('live1111')!.result).toBeNull()
    expect(h.git).toEqual([])
  })

  it('老格式的锁分不清在跑哪条 ⇒ 宁可拒绝', () => {
    const h = harness({
      rows: [fakeState({ id: 'kill1111', result: null })],
      lock: { ok: false, holder: 4242 },
      live: { pid: 4242, runId: null },
    })
    expect(runAbandon(h.deps, 'kill1111')).toMatchObject({ ok: false, code: 'self_change_running' })
    expect(h.git).toEqual([])
  })

  it('持锁的是别的一条 ⇒ 照样作废(这条要恢复也得先拿锁,拿不到)', () => {
    const h = harness({
      rows: [fakeState({ id: 'kill1111', result: null })],
      lock: { ok: false, holder: 4242 },
      live: { pid: 4242, runId: 'other111' },
    })
    expect(runAbandon(h.deps, 'kill1111')).toMatchObject({ ok: true, code: 'abandoned' })
    expect(removed(h)).toEqual([tree('kill1111')])
  })

  it('拿锁失败但再看时持有者已经没了 ⇒ 当成在变动,拒绝(让人再跑一次)', () => {
    const h = harness({
      rows: [fakeState({ id: 'kill1111', result: null })],
      lock: { ok: false, holder: 4242 },
      live: null,
    })
    expect(runAbandon(h.deps, 'kill1111')).toMatchObject({ ok: false, code: 'self_change_running' })
  })

  it('worktree remove 失败 ⇒ 仍记作废,但报 reclaim_failed 并教人重跑', () => {
    const h = harness({
      rows: [fakeState({ id: 'kill1111', result: null })],
      git: args => (args[1] === 'remove' ? { code: 128, stderr: 'fatal: 删不动' } : undefined),
    })
    const r = runAbandon(h.deps, 'kill1111')
    expect(r).toMatchObject({ ok: false, code: 'self_change_reclaim_failed' })
    expect(r.message).toContain('fatal: 删不动')
    expect(r.message).toContain('--abandon kill1111')
    expect(h.store.load('kill1111')!.result).toBe('abandoned')
    expect(h.released).toBe(1)
  })

  it('中枢克隆不在了(没法 git)⇒ 报 reclaim_failed,给出手工删的路径', () => {
    const h = harness({
      rows: [fakeState({ id: 'kill1111', result: null })],
      exists: p => p !== HUB,
    })
    const r = runAbandon(h.deps, 'kill1111')
    expect(r).toMatchObject({ ok: false, code: 'self_change_reclaim_failed' })
    expect(r.message).toContain(tree('kill1111'))
    expect(h.git).toEqual([])
  })
})

describe('classifyRun / describeRuns', () => {
  it('五种:在跑 / 被杀 / 可恢复 / 终局 / 已作废', () => {
    expect(classifyRun(fakeState({ id: 'a1', result: null }), { pid: 1, runId: 'a1' })).toBe('running')
    expect(classifyRun(fakeState({ id: 'a1', result: null }), { pid: 1, runId: 'b2' })).toBe('killed')
    expect(classifyRun(fakeState({ id: 'a1', result: null }), null)).toBe('killed')
    // 老格式的锁:分不清 ⇒ 没收场的都当在跑(和 --abandon 同一个保守口径)。
    expect(classifyRun(fakeState({ id: 'a1', result: null }), { pid: 1, runId: null })).toBe('running')
    expect(classifyRun(fakeState({ result: 'merge_conflict' }), null)).toBe('resumable')
    expect(classifyRun(fakeState({ result: 'done' }), null)).toBe('settled')
    expect(classifyRun(fakeState({ result: 'declined' }), null)).toBe('settled')
    expect(classifyRun(fakeState({ result: 'abandoned' }), null)).toBe('abandoned')
  })

  it('每条带上工作树路径(盘上没有就是 null)', () => {
    const rows = describeRuns(
      [fakeState({ id: 'k1', result: null, startedAt: 2 }), fakeState({ id: 'd1', result: 'done', startedAt: 1 })],
      { config: testConfig(), exists: p => p === tree('k1'), live: null },
    )
    expect(rows).toEqual([
      { id: 'k1', step: 'intake', result: null, startedAt: 2, kind: 'killed', tree: tree('k1'), approvalHash: null },
      { id: 'd1', step: 'intake', result: 'done', startedAt: 1, kind: 'settled', tree: null, approvalHash: null },
    ])
  })

  it('人读版:一行一条,末尾汇总占着盘的树,并提示 --abandon', () => {
    const rows = describeRuns(
      [
        fakeState({ id: 'k1', result: null, startedAt: 3 }),
        fakeState({ id: 'r1', result: 'ci_unavailable', startedAt: 2 }),
        fakeState({ id: 'w1', step: 'approval', result: null, startedAt: 1, approval: { hash: 'deadbeefcafe', code: '07', decision: null, askedAt: 1, delivered: true } }),
      ],
      { config: testConfig(), exists: () => true, live: { pid: 9, runId: 'w1' } },
    )
    const text = formatRunRows(rows)
    const lines = text.split('\n')
    expect(lines[0]).toContain('k1')
    expect(lines[0]).toContain('被杀')
    expect(lines[0]).toContain(tree('k1'))
    expect(lines[1]).toContain('可 --resume')
    expect(lines[2]).toContain('等拍板 deadbeef')
    expect(text).toContain('--abandon')
    // 在跑的那条不算「可回收」。
    expect(lines.at(-1)).toContain('2')
  })
})

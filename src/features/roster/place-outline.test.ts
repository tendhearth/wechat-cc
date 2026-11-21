import { afterEach, expect, it, vi } from 'vitest'
import { createProviderRegistry } from '../../app/provider-registry'
import { openTestDb } from '../../lib/db'
import type { CheapEval } from '../../ports/agent-provider'
import { makePlaceOutlines, parseOutline } from './place-outline'
import type { OutlineRef } from './place-outline-input'

const dbs: ReturnType<typeof openTestDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const privateLine = '这句假原话绝不能写进日志'
const modelLine = '这是不能进日志的假输出'
const key = 'p:1234567890123456'
const entry = { kind: 'entry', entryId: 'sample' } as const
const refs = new Map<string, OutlineRef>([['e1', entry]])
const item = (line = modelLine, refs = ['e1']) => ({ line, status: 'active', refs })
const reply = JSON.stringify({ aspects: ['界面', '同步', '审核'].map(name => ({ name, items:[item()] })) })

function fixture() {
  const db = openTestDb()
  dbs.push(db)
  let now = new Date(2026, 10, 21, 23, 59).getTime()
  let enabled = true
  let fingerprint = 'version1'
  const done = vi.fn()
  const log = vi.fn()
  const holdBusy = vi.fn(() => done)
  let owner = 'fixture-owner'
  db.exec(`INSERT INTO threads (id,chat_id,title,facets,created_ts,last_active)
    VALUES ('fixture-thread','fixture-owner','样例','[]','2026-11-21','2026-11-21')`)
  db.query(`INSERT INTO topic_entries (id,thread_id,kind,line,source,created_ts,updated_ts)
    VALUES ('sample','fixture-thread','fact',?,'chat','2026-11-21','2026-11-21')`).run(privateLine)
  const snapshot = () => ({
    owner, pinnedEntries: [], pinnedMatters: [], location: { root: '/fixture', rootOf: (path: string | null) => path },
    input: { fingerprint, prompt: privateLine, refs, counts: { sessions: 0, entries: 1, steps: 0, chars: privateLine.length } },
    items: [{ id: 'e:sample', kind: 'fact' as const, status: 'live', line: privateLine, from: { source: 'chat' as const, at: now } }],
  })
  const open = (evaluator: () => CheapEval | null) => makePlaceOutlines({
    db, now: () => now, enabled: () => enabled, owner: () => owner, load: async () => snapshot(), evaluator, holdBusy, log,
  })
  return { open, snapshot, log, holdBusy, done, db,
    setEnabled: (on: boolean) => { enabled = on },
    change: () => { fingerprint += 'x' },
    changeOwner: () => { owner = 'another-owner' },
    tomorrow: () => { now += 60_000 },
  }
}

it('验证引用、截短正文与名称、裁剪块和叶子并保留正文文本', () => {
  const ascii = '<img onerror=alert(1)>'
  const good = item(ascii + '文'.repeat(50), ['e1', 'e1'])
  const parsed = parseOutline('前文\n```json\n' + JSON.stringify({ aspects: [
    { name: '空块', items: [item('丢掉', ['s99'])] },
    ...Array.from({ length: 9 }, (_, i) => ({ name: `${i}𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷`, items: [
      item('也丢掉', ['e1', 's99']), item('没有引用', []), item('引用过多', ['e1','e1','e1','e1']),
      ...Array.from({ length: 9 }, () => good),
    ] })),
  ] }) + '\n```', refs)!
  expect(parsed).toHaveLength(5)
  expect(parsed.every(aspect => [...aspect.name].length === 8 && aspect.items.length === 8)).toBe(true)
  expect(parsed[0]!.items[0]).toEqual({ id: 'o:0', status: 'active', line: ascii + '文'.repeat(40 - ascii.length), sources:[entry] })
  expect(parseOutline(JSON.stringify({ aspects: Array.from({length: 9}, (_, i) => ({name: String(i), items:[item()]})) }), refs)).toHaveLength(7)
  expect(parseOutline('{invalid}', refs)).toBeNull()
})

it('并发只提交一次，记录本地日，命中同指纹跳过，隔天仍需新指纹', async () => {
  const f = fixture()
  let finish!: (output: string) => void
  const evaluate = vi.fn<CheapEval>(async (_prompt, options) => {
    expect(options?.singleAttempt).toBe(true)
    options?.beforeRequest?.()
    return new Promise(resolve => { finish = resolve })
  })
  const service = f.open(() => evaluate)
  const read = () => service.read(key, f.snapshot())
  expect(read()).toEqual({ state: 'none', canRun: true })
  expect(await Promise.all([service.start(key), service.start(key)])).toEqual(Array(2).fill({ ok: true, state: 'running' }))
  expect(evaluate).toHaveBeenCalledTimes(1)
  expect(f.holdBusy).toHaveBeenCalledWith('place-outline')
  expect(f.done).not.toHaveBeenCalled()
  expect(read()).toMatchObject({ state: 'running', canRun: false })
  finish(reply)
  await vi.waitFor(() => expect(read()).toMatchObject({ state: 'ready', stale: false, aspects: expect.any(Array) }))
  expect(f.done).toHaveBeenCalledTimes(1)
  expect(read().aspects?.[0]?.items[0]?.sources).toEqual([{ kind:'entry' }])
  expect(await service.start(key)).toEqual({ ok:true, state:'ready', unchanged:true })
  f.change()
  expect(read()).toMatchObject({ state:'ready', stale:true, canRun:false })
  expect(await service.start(key)).toBe('outline_quota')
  f.tomorrow()
  expect(read()).toMatchObject({ stale:true, canRun:true })
  expect(await service.start(key)).toEqual({ ok:true, state:'running' })
  expect(evaluate).toHaveBeenCalledTimes(2)
  finish(reply)
  await vi.waitFor(() => expect(read().state).toBe('ready'))
  expect(JSON.stringify(f.log.mock.calls)).not.toContain(privateLine)
  expect(JSON.stringify(f.log.mock.calls)).not.toContain(modelLine)
  f.changeOwner()
  expect(read()).toMatchObject({ state:'failed', error:'stale' })
  expect(read().aspects).toBeUndefined()
})

it.each([
  ['', 'empty', undefined],
  ['{"aspects":[]}', 'empty', undefined],
  ['{"aspects":[{"name":"错引","items":[{"line":"原话","status":"open","refs":["s99"]}]}]}', 'empty', undefined],
  ['{bad', 'failed', 'bad_output'],
] as const)('校验并只用一次额度：%s', async (model, state, error) => {
  const f = fixture()
  const evaluate = vi.fn<CheapEval>(async (_prompt, opts) => { opts?.beforeRequest?.(); return model })
  const service = f.open(() => evaluate)
  await service.start(key)
  await vi.waitFor(() => expect(service.read(key, f.snapshot())).toMatchObject({ state, error, canRun: false }))
  expect(evaluate).toHaveBeenCalledTimes(1)
  if (state === 'empty') expect(await service.start(key)).toEqual({ ok: true, state, unchanged: true })
})

it('没有私密模型或网络守护拒绝时没有派发，也不占用额度', async () => {
  const f = fixture()
  const evaluate = vi.fn<CheapEval>(async () => reply)
  let safe = false
  const registry = createProviderRegistry({ networkGate: { check: async () => ({ safe, source:'bx', detail:'test' }) } })
  const service = f.open(() => registry.getCheapEval({ private: true }))
  await service.start(key)
  await vi.waitFor(() => expect(service.read(key, f.snapshot())).toMatchObject({ state:'failed', error:'no_private_model', canRun:true }))
  registry.register('openai', { cheapEval: evaluate, spawn: async () => { throw Error('unexpected executor') } }, { canResume: () => false })
  expect(service.read(key, f.snapshot())).toMatchObject({ state:'failed', error:'unavailable', canRun:true })
  expect(evaluate).not.toHaveBeenCalled()
  await service.start(key)
  await vi.waitFor(() => expect(service.read(key, f.snapshot())).toMatchObject({ state:'failed', error:'unavailable', canRun:true }))
  expect(evaluate).not.toHaveBeenCalled()
  safe = true
  await service.start(key)
  await vi.waitFor(() => expect(service.read(key, f.snapshot())).toMatchObject({ state:'ready', canRun:false }))
  expect(evaluate).toHaveBeenCalledTimes(1)
})

it.each(['disable', 'toggle', 'input', 'owner'] as const)('落库前变化会丢掉结果：%s', async change => {
  const f = fixture()
  let finish!: (output: string) => void
  const service = f.open(() => async (_prompt, options) => {
    options?.beforeRequest?.()
    return new Promise(resolve => { finish = resolve })
  })
  await service.start(key)
  if (change === 'input') f.change()
  else if (change === 'owner') f.changeOwner()
  else {
    f.setEnabled(false)
    service.invalidate()
    if (change === 'toggle') f.setEnabled(true)
  }
  finish(reply)
  await vi.waitFor(() => expect(service.read(key, f.snapshot())).toMatchObject({ state:'failed', error:'stale', canRun:false }))
  expect(f.db.query('SELECT result_json FROM place_outlines').get()).toEqual({result_json:''})
})

it('重启把 running 恢复成 interrupted，并保留当天额度', () => {
  const f = fixture()
  f.db.query("INSERT INTO place_outlines (place_key,state,fingerprint,call_day,started_ts) VALUES (?,'running','version1','2026-11-21','')").run(key)
  const service = f.open(() => null)
  expect(service.read(key, f.snapshot())).toMatchObject({ state:'failed', error:'interrupted', canRun:false })
})

it('私密请求等待准入期间撤掉条目权限，材料不派发', async () => {
  const f = fixture()
  const evaluate = vi.fn<CheapEval>(async () => reply)
  let allow!: () => void
  const waiting = new Promise<void>(resolve => { allow = resolve })
  const registry = createProviderRegistry({ networkGate: { check: async () => {
    await waiting
    return {safe:true,source:'bx',detail:'test'}
  } } })
  registry.register('openai', {
    cheapEval: evaluate, spawn: async () => { throw Error('unexpected executor') },
  }, { canResume: () => false })
  const service = f.open(() => registry.getCheapEval({ private:true }))
  await service.start(key)
  f.db.query("UPDATE threads SET private=1 WHERE id='fixture-thread'").run()
  allow()
  await vi.waitFor(() => expect(service.read(key, f.snapshot())).toMatchObject({state:'failed',error:'stale',canRun:true}))
  expect(evaluate).not.toHaveBeenCalled()
})

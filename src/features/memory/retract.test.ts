/**
 * 一种收回,一条测试串到底(架构终态 G5,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §5「收回往返」)。
 * 同一串对记忆页删一行、待办「不对」、证据审阅纠正、MCP superseded 各跑一遍:落的是同一种事件,后果一样。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { dropCorrectedLines } from '../../lib/memory-corrections'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { parseMemoryDoc, renderForPrompt } from './curated-doc'
import { makeMemoryWriter, synthesisRetractionsFor, type MemoryWriter } from './memory-export'
import { makeMemoryNightlyRuntime, type MemoryNightlyRuntime } from './nightly-runtime'
import { dropCorrected, readCorrections } from './nightly'
import { retractOnFactStatus, type FactStatusSetter } from './fact-status'

const OWNER = 'owner@im.wechat'
const LINE = '下个月要去杭州出差三天'
let stateDir = '', root = '', now = 0
let db: Db, store: MemoryFactsStore, writer: MemoryWriter, rt: MemoryNightlyRuntime

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'memory-retract-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  now = Date.parse('2026-10-26T10:00:00Z')
  db = openTestDb(); store = makeMemoryFactsStore(db); writer = makeMemoryWriter({ store, stateDir })
  writer.commitMemory(OWNER, parseMemoryDoc(`## 近况\n- ${LINE} <!-- m:aa01 · 2026-10-20 -->\n- 在赶发版 <!-- m:aa02 · 2026-10-20 -->\n`), { actor: 'nightly', ts: now }, '2026-10-20T04:00:00.000Z')
  writeFileSync(join(root, 'profile.md'), `# 主人\n- ${LINE},住西湖边\n- 喜欢跑步\n`)
  writeFileSync(join(root, 'agenda.md'), `- [ ] due:2026-11-03 问问${LINE}顺不顺利\n- [ ] due:2026-11-05 提醒体检\n`)
  rt = makeMemoryNightlyRuntime({
    stateDir, ownerChatId: () => OWNER, config: () => ({ enabled: false, at: '04:00', timezone: 'UTC' }),
    sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => [], projectMemory: () => '' },
    cheapEval: () => null, ownerRecentlyActive: async () => false, now: () => now, newId: (() => { let n = 0; return () => `c0${n++}` })(), log: () => {},
    writer, careGate: () => ({ ok: true }), claim: vi.fn(),
    speech: { say: async () => ({ sent: true }) } as never,
  })
})
afterEach(() => { db.close(); removeTempDir(stateDir) })

const read = (f: string) => readFileSync(join(root, f), 'utf8')

/** 收回之后,这句话在每个出口都没了;返回墓碑 key。 */
async function assertGoneEverywhere(tombKey: string) {
  // 表:墓碑 + 被收回的条目,各一条 retracted 事件
  expect(store.byKey(OWNER, tombKey)!.status).toMatch(/retracted|outdated/)
  expect(store.byKey(OWNER, 'm:aa01')!.status).toMatch(/retracted|outdated/)
  const ev = store.events(OWNER).filter(e => e.action === 'retracted')
  expect(ev.map(e => e.factId)).toEqual(expect.arrayContaining([store.byKey(OWNER, tombKey)!.id, store.byKey(OWNER, 'm:aa01')!.id]))
  // 导出的 memory.md、主人对话的提示词
  expect(read('memory.md')).not.toContain(LINE)
  expect(renderForPrompt(parseMemoryDoc(read('memory.md')))).not.toContain(LINE)
  // 整理想加回 ⇒ 被丢
  const { texts } = readCorrections(writer, OWNER)
  expect(dropCorrected({ add: [{ section: '近况', text: LINE }], update: [], confirm: [], remove: [] } as never, texts).add).toEqual([])
  // 合成产出带它 ⇒ 被滤、记一条 redacted_on_output
  const r = synthesisRetractionsFor(db, stateDir, OWNER)
  const out = dropCorrectedLines(`他${LINE}\n他喜欢跑步`, r.texts())
  expect(out.text).toBe('他喜欢跑步')
  r.redacted('overview', out.hits)
  expect(store.events(OWNER).some(e => e.action === 'redacted_on_output' && e.factId === store.byKey(OWNER, tombKey)!.id)).toBe(true)
  // 清源头、关待办
  expect(read('profile.md')).not.toContain(LINE)
  expect(read('agenda.md')).toMatch(/- \[x\] dropped:\S+ 问问/)
  expect(read('agenda.md')).toContain('- [ ] due:2026-11-05 提醒体检')
  // 收回的话列表里有它;corrections.md(只读导出)也有
  expect(rt.retractions().map(x => x.text)).toContain(LINE)
  expect(read('corrections.md')).toContain(LINE)
}

describe('一种收回:四个入口落同一种事件', () => {
  it('记忆页删一行(逐条纠错)→ 处处消失 → 恢复:那一行回来,删掉的笔记行不回来', async () => {
    await rt.correct('aa01', 'wrong')
    const key = rt.retractions().find(x => x.text === LINE)!.key
    await assertGoneEverywhere(key)
    const res = await rt.restore(key)
    expect(res).toEqual({ restored: ['m:aa01'] })
    expect(read('memory.md')).toContain(LINE)
    expect(store.byKey(OWNER, key)!.status).toBe('superseded')
    expect(rt.retractions().map(x => x.text)).not.toContain(LINE)
    expect(read('corrections.md')).not.toContain(LINE)
    expect(read('profile.md')).not.toContain(LINE)   // 照实说:清掉的笔记行不回来
    expect(store.events(OWNER).find(e => e.action === 'restored' && e.factId === store.byKey(OWNER, key)!.id)!.note).toContain('不会回来')
    expect(await rt.restore(key)).toBeNull()
  })

  it('待办「不对」(set_fact_status rejected)', async () => {
    const facts: FactStatusSetter = { setFactStatus: () => ({ ok: true }) }
    const retract = vi.fn((text: string, verdict: 'wrong' | 'outdated') => rt.retractText(OWNER, text, verdict, '待办'))
    retractOnFactStatus(facts, { factById: () => ({ predicate: '', value: LINE, status: 'active' }), retract }).setFactStatus(7, 'rejected', 1)
    expect(retract).toHaveBeenCalledWith(LINE, 'wrong')
    await retract.mock.results[0]!.value
    await assertGoneEverywhere(rt.retractions().find(x => x.text === LINE)!.key)
    expect(rt.retractions().find(x => x.text === LINE)!.section).toBe('待办')
  })

  it('MCP set_fact_status superseded ⇒ 收回(过时);resolved(已办)不是收回', async () => {
    const facts: FactStatusSetter = { setFactStatus: () => ({ ok: true }) }
    const retract = vi.fn((text: string, verdict: 'wrong' | 'outdated') => rt.retractText(OWNER, text, verdict, '待办'))
    const wrapped = retractOnFactStatus(facts, { factById: () => ({ predicate: '', value: LINE, status: 'active' }), retract })
    wrapped.setFactStatus(7, 'resolved', 1)
    expect(retract).not.toHaveBeenCalled()
    wrapped.setFactStatus(7, 'superseded', 1)
    expect(retract).toHaveBeenCalledWith(LINE, 'outdated')
    await retract.mock.results[0]!.value
    await assertGoneEverywhere(rt.retractions().find(x => x.text === LINE)!.key)
    expect(store.byKey(OWNER, 'm:aa01')!.status).toBe('outdated')
  })

  it('证据审阅纠正一条观察', async () => {
    await rt.retractText(OWNER, LINE, 'wrong', '观察')
    await assertGoneEverywhere(rt.retractions().find(x => x.text === LINE)!.key)
  })

  it('不是主人自己的对话 ⇒ 不收回', async () => {
    expect(await rt.retractText('guest@im.wechat', LINE, 'wrong', '观察')).toBeNull()
    expect(rt.retractions()).toEqual([])
  })
})

describe('收回一个表里没有的 key(数据安全评审第 3 条)', () => {
  it('the real sentence still lands in retractedTexts, so the nightly cannot write it back', async () => {
    const key = writer.retract(OWNER, { key: 'm:gone01' }, { day: '2026-10-26', verdict: 'wrong', section: '近况', text: '刚搬到了滨江' }, { actor: 'owner', ts: now })
    expect(store.byKey(OWNER, key)!.text).toBe('刚搬到了滨江')
    expect(writer.retractedTexts(OWNER).has('刚搬到了滨江')).toBe(true)
    expect([...writer.retractedTexts(OWNER)].some(t => t.startsWith('m:'))).toBe(false)
  })
})

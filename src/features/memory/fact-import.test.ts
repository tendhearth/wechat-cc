/**
 * G3 导入(设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3「数据怎么搬」)。
 * 夹具是 G0 的合成夹具(src/test-support/fixtures/memory/chats/),复制到临时目录再导。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestDb, type Db } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { renderMemoryForPrompt, renderMemoryMd, renderOwnerMd } from '../../domain/memory/render'
import { renderCorrectionsMd } from '../../domain/memory/corrections'
import { importChatMemory, importMemoryOnBoot } from './fact-import'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-support', 'fixtures', 'memory')
const golden = (rel: string) => readFileSync(join(FIXTURES, 'golden', rel), 'utf8')
const STAMP = '2026-10-25T03:00:00.000Z'
const OWNER = 'o9fixture-owner@im.wechat'
/** 金样里被导成「收回」的两行:corrections.md 收回过、整理又写回 memory.md 的那两句(设计稿 §6 列出的变化)。 */
const WRITTEN_BACK = ['- 下周要去杭州出差三天 <!-- m:dead01 · 2026-10-18 -->\n', '- 年糕是狸花猫 <!-- m:dead02 · 2026-10-21 -->\n']

let stateDir = '', root = ''
let db: Db, store: MemoryFactsStore
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'memory-import-'))
  root = join(stateDir, 'memory', OWNER)
  cpSync(join(FIXTURES, 'chats', 'owner'), root, { recursive: true })
  db = openTestDb(); store = makeMemoryFactsStore(db)
})
afterEach(() => { db.close(); removeTempDir(stateDir) })
const run = (now = 1_761_400_000_000) => importChatMemory(store, root, OWNER, now, '2026-10-26')
const eventCount = () => (db.query('SELECT COUNT(*) AS n FROM memory_fact_events').get() as { n: number }).n

describe('importChatMemory', () => {
  it('imports the owner fixture; rendering the table equals G0 except the two written-back retracted lines', () => {
    const r = run()
    expect(r).toMatchObject({ outcome: 'imported', first: true })
    const rows = store.list(OWNER)
    expect(renderMemoryMd(rows, STAMP)).toBe(WRITTEN_BACK.reduce((s, l) => s.replace(l, ''), golden('owner/memory.md')))
    expect(renderOwnerMd(rows)).toBe(golden('owner/owner.md'))
    expect(renderMemoryForPrompt(rows)).not.toContain('年糕是狸花猫')
    expect(store.byKey(OWNER, 'm:dead02')!.status).toBe('retracted')
    expect(store.byKey(OWNER, 'm:dead01')!.status).toBe('retracted')
    // 「爱吃辣」短于 6 个字:不拿来比对,memory.md 里就算有也不会被当成写回
    expect(store.byKey(OWNER, 'm:a1b2c3')!.status).toBe('active')
  })

  it('keeps the 替换 chain and the corrections log byte for byte (verdicts, ids, notes)', () => {
    run()
    expect(store.byKey(OWNER, 'o:k7x9q5')!.replacesKey).toBe('c:77aa01')
    expect(store.byKey(OWNER, 'o:k7x9q2')!.replacesKey).toBe('c:3fa9c1')
    expect(store.byKey(OWNER, 'c:77aa01')).toMatchObject({ text: '周二晚上固定打羽毛球', section: '主人原话', status: 'retracted', seenAt: '2026-10-23' })
    expect(store.byKey(OWNER, 'c:~2')).toMatchObject({ text: '在准备搬家去上海', status: 'outdated' })
    expect(renderCorrectionsMd(store.tombstones(OWNER))).toBe(readFileSync(join(root, 'corrections.md'), 'utf8'))
  })

  it('a second run with the same files does nothing; the originals are kept and copied once as *.imported-<day>', () => {
    run()
    const n = eventCount()
    expect(run()).toEqual({ chatId: OWNER, outcome: 'unchanged' })
    expect(eventCount()).toBe(n)
    for (const f of ['memory.md', 'owner.md', 'corrections.md']) {
      expect(readFileSync(join(root, f), 'utf8')).toBe(readFileSync(join(FIXTURES, 'chats', 'owner', f), 'utf8'))
      expect(readFileSync(join(root, `${f}.imported-2026-10-26`), 'utf8')).toBe(readFileSync(join(root, f), 'utf8'))
    }
  })

  it('files changed by today\'s writers ⇒ the next boot mirrors them (added / updated / gone / new correction), no row deleted', () => {
    run()
    const before = (db.query('SELECT COUNT(*) AS n FROM memory_facts').get() as { n: number }).n
    const mem = readFileSync(join(root, 'memory.md'), 'utf8')
      .replace('- 咖啡只喝美式,不加糖 <!-- m:b0b0b1 · 2026-09-30 -->', '- 咖啡只喝美式,偶尔加奶 <!-- m:b0b0b1 · 2026-10-26 -->')
      .replace('- 小林是大学室友,现在在深圳做硬件 <!-- m:d00d01 · 2026-10-02 -->\n', '')
      .replace('## 近况\n', '## 近况\n- 新的一条 <!-- m:feed01 · 2026-10-26 -->\n')
    writeFileSync(join(root, 'memory.md'), mem)
    appendFileSync(join(root, 'corrections.md'), '- 2026-10-26 主人说这条记错了,整理时不要再写回:[记忆 · c:9e9e01] 在准备 Tendhearth 的第一次发版\n')
    const r = run(1_761_500_000_000)
    expect(r).toMatchObject({ outcome: 'imported', first: false, gone: 1 })
    expect(store.byKey(OWNER, 'm:b0b0b1')).toMatchObject({ text: '咖啡只喝美式,偶尔加奶', seenAt: '2026-10-26', status: 'active' })
    expect(store.byKey(OWNER, 'm:d00d01')!.status).toBe('outdated')
    expect(store.byKey(OWNER, 'm:feed01')!.status).toBe('active')
    expect(store.byKey(OWNER, 'm:e0e0e1')!.status).toBe('retracted')      // 新的收回 ⇒ 那一条也收回
    expect(store.byKey(OWNER, 'c:9e9e01')!.status).toBe('retracted')
    expect((db.query('SELECT COUNT(*) AS n FROM memory_facts').get() as { n: number }).n).toBe(before + 2)
    const upd = store.events(OWNER).find(e => e.factId === store.byKey(OWNER, 'm:b0b0b1')!.id && e.action === 'updated')!
    expect(upd.prevText).toBe('咖啡只喝美式,不加糖')
  })

  it('an appended note under an existing correction becomes one more event on that tombstone', () => {
    run()
    appendFileSync(join(root, 'corrections.md'), '  (CC 又判断 agenda.md 里 1 条待办在跟进这件事,也改成 dropped:问小林)\n')
    run(1_761_500_000_000)
    expect(renderCorrectionsMd(store.tombstones(OWNER))).toBe(readFileSync(join(root, 'corrections.md'), 'utf8'))
  })

  it('a 替换 whose correction is missing from corrections.md gets a placeholder tombstone, not a failed import', () => {
    writeFileSync(join(root, 'owner.md'), readFileSync(join(root, 'owner.md'), 'utf8').replace('替换:77aa01', '替换:0dd0dd'))
    expect(run()).toMatchObject({ outcome: 'imported' })
    expect(store.byKey(OWNER, 'c:0dd0dd')).toMatchObject({ kind: 'placeholder', text: '', status: 'retracted' })
    expect(renderOwnerMd(store.list(OWNER))).toContain('替换:0dd0dd')
  })

  it('a check that does not pass ⇒ nothing is written, no import record, the files are not touched', () => {
    // corrections.md 开头一行认不出 ⇒ 不搬
    writeFileSync(join(root, 'corrections.md'), '随手写在最前面的一行\n' + readFileSync(join(root, 'corrections.md'), 'utf8'))
    expect(run()).toMatchObject({ outcome: 'mismatch', what: 'corrections.md' })
    expect(store.list(OWNER)).toEqual([])
    expect(store.importHash(OWNER)).toBeNull()
    for (const f of ['memory.md', 'owner.md', 'corrections.md']) expect(existsSync(join(root, `${f}.imported-2026-10-26`))).toBe(false)
  })

  it('a mismatch found after mirroring rolls the whole chat back', () => {
    // 两条同编号的原话:表里一个 key 只有一行,渲染不出两行 ⇒ 核对不过,前面插的行全部回滚
    const own = readFileSync(join(root, 'owner.md'), 'utf8')
    writeFileSync(join(root, 'owner.md'), own + '- 同一个编号又出现一次 <!-- o:k7x9q3 · 2026-10-25 · owner -->\n')
    expect(run()).toMatchObject({ outcome: 'mismatch', what: 'owner.md' })
    expect(store.list(OWNER)).toEqual([])
    expect(eventCount()).toBe(0)
  })
})

describe('importMemoryOnBoot', () => {
  it('imports every chat directory that has memory files; BOM and CRLF are fine; empty dirs are skipped', () => {
    cpSync(join(FIXTURES, 'chats', 'guest'), join(stateDir, 'memory', 'o9fixture-guest@im.wechat'), { recursive: true })
    cpSync(join(FIXTURES, 'chats', 'guest'), join(stateDir, 'memory', 'only-notes'), { recursive: true })
    for (const f of ['memory.md', 'owner.md']) removeTempDir(join(stateDir, 'memory', 'only-notes', f))
    const logs: string[] = []
    const out = importMemoryOnBoot({ store, stateDir, now: () => 1_761_400_000_000, log: (_t, l) => logs.push(l) })
    expect(Object.fromEntries(out.map(o => [o.chatId, o.outcome]))).toEqual({ [OWNER]: 'imported', 'o9fixture-guest@im.wechat': 'imported', 'only-notes': 'empty' })
    expect(renderMemoryMd(store.list('o9fixture-guest@im.wechat'), STAMP)).toBe(golden('guest/memory.md'))
    expect(existsSync(join(stateDir, 'memory', OWNER, 'memory.md'))).toBe(true)
    expect(logs.filter(l => l.includes('imported')).length).toBe(2)
  })
})

describe('after import the nightly prompt\'s corrections block and the retracted list come from the table, byte-equal to G0', () => {
  it('readCorrections(table) equals the G0 golden nightly head; retractedTexts equals the G0 list', async () => {
    const { makeMemoryWriter } = await import('./memory-export')
    const { readCorrections, CORRECTIONS_BLOCK } = await import('./nightly')
    run()
    const writer = makeMemoryWriter({ store, stateDir })
    const c = readCorrections(writer, OWNER)
    expect(golden('owner/nightly-head.txt').startsWith(`### ${CORRECTIONS_BLOCK}\n${c.block}\n\n`)).toBe(true)
    expect(JSON.stringify([...c.texts].sort(), null, 2) + '\n').toBe(golden('owner/corrected-texts.json'))
  })
})

describe('G6:readers read the table — after import the prompt sections equal G0 except the listed change', () => {
  it('curated memory = G0 minus the two written-back retracted lines; owner words = G0 byte for byte', async () => {
    const { makeMemoryWriter } = await import('./memory-export')
    const { makeMemoryPromptReads } = await import('./prompt-reads')
    const { makeMemoryFS } = await import('../../adapters/store/memory-fs')
    const { mkdirSync } = await import('node:fs')
    run()
    mkdirSync(join(stateDir, 'companion'), { recursive: true })
    writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ default_chat_id: OWNER }))
    // 磁盘上的文件挪走也照读:读者已经不看文件了
    writeFileSync(join(root, 'memory.md'), '这份文件已经不是源了\n')
    writeFileSync(join(root, 'owner.md'), '这份也不是\n')
    const reads = makeMemoryPromptReads({ stateDir, memory: makeMemoryFS({ rootDir: join(stateDir, 'memory') }), facts: makeMemoryWriter({ store, stateDir }) })
    expect(reads.curatedMemoryFor(OWNER)).toBe(golden('owner/prompt-curated.txt').replace('- 下周要去杭州出差三天\n', '').replace('- 年糕是狸花猫\n', ''))
    expect(reads.ownerMemoryFor(OWNER)).toBe(golden('owner/prompt-owner.txt'))
  })
})

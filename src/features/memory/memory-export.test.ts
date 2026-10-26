/**
 * G4:写者落表、文件变成导出(设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestDb, type Db } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { derivedMemoryStatus } from '../../lib/memory-derived-state'
import { parseOwnerDoc, serializeOwnerDoc } from '../../lib/memory-owner'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { EXPORT_NOTICE, renderMemoryMd } from '../../domain/memory/render'
import { emptyDoc, parseMemoryDoc, renderForPrompt, serializeMemoryDoc } from './curated-doc'
import { importChatMemory, importMemoryOnBoot } from './fact-import'
import { makeMemoryWriter, type MemoryWriter } from './memory-export'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-support', 'fixtures', 'memory')
const OWNER = 'o9fixture-owner@im.wechat'
const by = { actor: 'nightly' as const, ts: 1_761_500_000_000 }
const STAMP = '2026-10-26T04:00:00.000Z'

let stateDir = '', root = ''
let db: Db, store: MemoryFactsStore, writer: MemoryWriter
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'memory-export-'))
  root = join(stateDir, 'memory', OWNER)
  db = openTestDb(); store = makeMemoryFactsStore(db); writer = makeMemoryWriter({ store, stateDir })
})
afterEach(() => { db.close(); removeTempDir(stateDir) })
const file = (f: string) => readFileSync(join(root, f), 'utf8')
const archived = (content: string) => join(stateDir, 'memory-archive', OWNER, `memory.md.kept-${createHash('sha256').update(content).digest('hex').slice(0, 12)}.md`)
const seedFixture = () => { cpSync(join(FIXTURES, 'chats', 'owner'), root, { recursive: true }); expect(importChatMemory(store, root, OWNER, 1, '2026-10-26').outcome).toBe('imported') }

describe('MemoryWriter', () => {
  it('a brand-new chat goes straight to the table; the export carries the generated notice; the next boot import sees nothing new', () => {
    const doc = emptyDoc()
    doc.sections['偏好'].push({ id: 'aa01', text: '只喝美式', seen: '2026-10-26' })
    writer.commitMemory(OWNER, doc, by, STAMP)
    expect(store.byKey(OWNER, 'm:aa01')!.status).toBe('active')
    expect(file('memory.md')).toBe(serializeMemoryDoc(doc, STAMP).replace('<!-- wechat-cc 记忆 · ', `<!-- wechat-cc 记忆 · ${EXPORT_NOTICE} · `))
    // 解析器照旧跳过头部:注入不变
    expect(renderForPrompt(parseMemoryDoc(file('memory.md')))).toBe(renderForPrompt(doc))
    expect(importChatMemory(store, root, OWNER, 2, '2026-10-26')).toEqual({ chatId: OWNER, outcome: 'unchanged' })
  })

  it('an imported chat: a nightly commit lands in the table and is re-exported; written-back retracted lines are gone from the file (listed change)', () => {
    seedFixture()
    const doc = parseMemoryDoc(file('memory.md'))
    doc.sections['身边的人'] = []                                         // 整理删掉了一条
    doc.sections['近况'].push({ id: 'bb02', text: '换了一台显示器', seen: '2026-10-26' })
    writer.commitMemory(OWNER, doc, by, STAMP)
    expect(store.byKey(OWNER, 'm:d00d01')!.status).toBe('outdated')
    expect(store.byKey(OWNER, 'm:bb02')!.status).toBe('active')
    const out = file('memory.md')
    expect(out).toBe(renderMemoryMd(store.list(OWNER), STAMP, { exported: true }))
    expect(out).not.toContain('年糕是狸花猫')
    expect(out).not.toContain('下周要去杭州出差三天')
    expect(out).toContain('换了一台显示器')
  })

  it('retract appends a line in today\'s exact format (with / without id); a later note lands under its own entry', () => {
    seedFixture()
    const before = file('corrections.md')
    const k1 = writer.retract(OWNER, { text: '喜欢喝拿铁' }, { day: '2026-10-26', verdict: 'wrong', section: '偏好', correctionId: 'abc123', text: '喜欢喝拿铁', note: '  (随之从 profile.md 删了 1 行)\n' }, by)
    const k2 = writer.retract(OWNER, { text: '在准备搬家' }, { day: '2026-10-26', verdict: 'outdated', section: '近况', text: '在准备搬家' }, by)
    expect([k1, k2]).toEqual(['c:abc123', 'c:~4'])
    writer.addCorrectionNote(OWNER, k1, '  (CC 又判断 agenda.md 里 1 条待办在跟进这件事,也改成 dropped:问拿铁)\n', by)
    expect(file('corrections.md')).toBe(before
      + '- 2026-10-26 主人说这条记错了,整理时不要再写回:[偏好 · c:abc123] 喜欢喝拿铁\n  (随之从 profile.md 删了 1 行)\n  (CC 又判断 agenda.md 里 1 条待办在跟进这件事,也改成 dropped:问拿铁)\n'
      + '- 2026-10-26 主人说这条已经过时,整理时不要再写回:[近况] 在准备搬家\n')
    expect(store.byKey(OWNER, 'c:~4')!.status).toBe('outdated')
  })

  it('commitOwner: owner.md is exported in today\'s format, removed quotes become outdated, and derived memory goes stale toward hiding', () => {
    seedFixture()
    writeFileSync(join(root, '_overview.md'), 'v1')
    const doc = parseOwnerDoc(file('owner.md'))
    doc.assertions = doc.assertions.filter(a => a.id !== 'k7x9q3')
    doc.assertions.push({ id: 'n3w001', text: '我更喜欢茶', date: '2026-10-26', origin: 'memory' })
    writer.commitOwner(OWNER, doc, { actor: 'owner', ts: by.ts })
    expect(file('owner.md')).toBe(serializeOwnerDoc(doc))
    expect(store.byKey(OWNER, 'o:k7x9q3')!.status).toBe('outdated')
    expect(store.byKey(OWNER, 'o:n3w001')).toMatchObject({ status: 'active', scope: 'owner_only', origin: 'memory' })
    expect(derivedMemoryStatus(root, 'overview')).toBe('retracted')
  })

  it('a chat that did not pass the import check stays on the old path: today\'s bytes, nothing in the table', () => {
    cpSync(join(FIXTURES, 'chats', 'owner'), root, { recursive: true })
    const doc = parseMemoryDoc(file('memory.md'))
    writer.commitMemory(OWNER, doc, by, STAMP)
    expect(file('memory.md')).toBe(serializeMemoryDoc(doc, STAMP))
    writer.retract(OWNER, { text: '随便一句话' }, { day: '2026-10-26', verdict: 'delete', section: '总览', text: '随便一句话' }, by)
    expect(file('corrections.md').endsWith('- 2026-10-26 主人说这条不用记,整理时不要再写回:[总览] 随便一句话\n')).toBe(true)
    expect(store.list(OWNER)).toEqual([])
  })

  it('handEdited looks only at the content hash: a removed header or an old binary\'s rewrite still counts; our own export never does', () => {
    seedFixture()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), by, STAMP)
    expect(writer.handEdited(OWNER)).toBeNull()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), { ...by, ts: by.ts + 1 }, '2026-10-27T04:00:00.000Z')
    expect(writer.handEdited(OWNER)).toBeNull()                          // 自己的导出永远不算手改
    const exported = file('memory.md')
    writeFileSync(join(root, 'memory.md'), exported.replace('- 每天早上七点起床跑步', '- 每天早上六点起床跑步'))
    expect(writer.handEdited(OWNER)).toContain('六点')
    // 删掉头部(连「这是生成的」那句一起)照样认得出
    writeFileSync(join(root, 'memory.md'), exported.split('\n').slice(1).join('\n'))
    expect(writer.handEdited(OWNER)).not.toBeNull()
    // 老版本二进制整份重写(头部换成老格式):有导出记录 ⇒ 也当手改,往保守那边走
    writeFileSync(join(root, 'memory.md'), serializeMemoryDoc(parseMemoryDoc(exported), STAMP))
    expect(writer.handEdited(OWNER)).not.toBeNull()
    expect(importChatMemory(store, root, OWNER, 3, '2026-10-26', { ownerChat: true }).outcome).toBe('hand_edited')
  })

  it('with the header removed, the boot import keeps a copy and does not adopt it', () => {
    seedFixture()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), by, STAMP)
    const edited = file('memory.md').split('\n').slice(1).join('\n').replace('- 咖啡只喝美式,不加糖 <!-- m:b0b0b1 · 2026-09-30 -->\n', '')
    writeFileSync(join(root, 'memory.md'), edited)
    expect(importChatMemory(store, root, OWNER, 3, '2026-10-26', { ownerChat: true }).outcome).toBe('hand_edited')
    expect(store.byKey(OWNER, 'm:b0b0b1')!.status).toBe('active')
    expect(readFileSync(archived(edited), 'utf8')).toBe(edited)
    expect(file('memory.md')).toBe(edited)                               // 文件不动,留给运行时核对
  })

  it('boot with default_chat_id unset: nobody can reconcile, so a hand-edited memory.md is kept and not adopted (no crash)', () => {
    seedFixture()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), by, STAMP)
    const edited = file('memory.md').replace('不加糖', '加一点糖')
    writeFileSync(join(root, 'memory.md'), edited)
    const out = importMemoryOnBoot({ store, stateDir, now: () => by.ts + 5, log: () => {}, beforeChat: (c) => writer.syncStale(c, STAMP, by.ts + 5) })
    expect(out).toEqual([{ chatId: OWNER, outcome: 'hand_edited' }])
    expect(store.byKey(OWNER, 'm:b0b0b1')!.text).toBe('咖啡只喝美式,不加糖')
    expect(existsSync(archived(edited))).toBe(true)
  })

  it('an export that fails after the table commit: the table is ahead, the next boot re-exports it (and a later hand edit is still a hand edit)', () => {
    seedFixture()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), by, STAMP)
    const before = file('memory.md')
    const broken = makeMemoryWriter({ store, stateDir, writeFile: () => { throw new Error('ENOSPC') } })
    const doc = parseMemoryDoc(before)
    doc.sections['近况'].push({ id: 'cc03', text: '刚换了一台显示器', seen: '2026-10-26' })
    expect(() => broken.commitMemory(OWNER, doc, { ...by, ts: by.ts + 1 }, STAMP)).toThrow('ENOSPC')
    expect(store.byKey(OWNER, 'm:cc03')!.status).toBe('active')       // 表已经改了
    expect(file('memory.md')).toBe(before)                              // 文件没写成
    expect(store.exportRecord(OWNER, 'memory.md')!.pending).not.toBeNull()
    expect(writer.handEdited(OWNER)).toBeNull()                         // 不是手改:磁盘还是上一份确认写下的
    // 下次开机:先补写,再导入(指纹没变也不会挡住)
    const out = importMemoryOnBoot({ store, stateDir, now: () => by.ts + 2, log: () => {}, beforeChat: (c) => writer.syncStale(c, STAMP, by.ts + 2) })
    expect(out[0]!.outcome).toBe('unchanged')
    expect(file('memory.md')).toContain('刚换了一台显示器')
    expect(store.exportRecord(OWNER, 'memory.md')).toMatchObject({ pending: null })
  })

  it('nothing on disk is overwritten without a copy: a file we did not write is archived before the export replaces it', () => {
    seedFixture()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), by, STAMP)
    const foreign = file('memory.md').replace('不加糖', '加奶')
    writeFileSync(join(root, 'memory.md'), foreign)
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), { ...by, ts: by.ts + 1 }, STAMP)
    expect(readFileSync(archived(foreign), 'utf8')).toBe(foreign)
  })

  it('the boot import leaves a hand-edited export alone (the nightly runtime reconciles it)', () => {
    seedFixture()
    writer.commitMemory(OWNER, parseMemoryDoc(file('memory.md')), by, STAMP)
    writeFileSync(join(root, 'memory.md'), file('memory.md').replace('不加糖', '加一点糖'))
    expect(importChatMemory(store, root, OWNER, 3, '2026-10-26', { ownerChat: true }).outcome).toBe('hand_edited')
    expect(store.byKey(OWNER, 'm:b0b0b1')!.text).toBe('咖啡只喝美式,不加糖')
    expect(existsSync(join(root, 'memory.md'))).toBe(true)
    // 不是主人的对话没人核对手改 ⇒ 照文件同步(F6 起桌面能整份写别人对话的 memory.md)
    expect(importChatMemory(store, root, OWNER, 4, '2026-10-26').outcome).toBe('imported')
    expect(store.byKey(OWNER, 'm:b0b0b1')!.text).toBe('咖啡只喝美式,加一点糖')
  })
})

/**
 * 开机一次的「文件 → 表」导入(架构终态 G3,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md
 * §3「数据怎么搬」)。按对话逐个、每个对话一个事务;核对不过 ⇒ 这个对话整个回滚、日志写出第一处差异、下次开机再试。
 *
 *  1. 先收回、后加:corrections.md 的每条先成墓碑;memory.md 里正文(规范化、够长)等于某条收回的话的条目 ⇒ 以 `retracted`
 *     导入(今天它们其实还在注入里 —— 见设计稿 §6;表里从一开始就是收回的)。
 *  2. 原样保留:编号、日期、栏、顺序、extra、owner.md 的 `替换:`(指向墓碑;找不到的补占位墓碑)、认不出的行。
 *  3. 核对后才算数:表渲染出的 memory.md / owner.md / corrections.md、两段注入、收回名单,和用今天的解析器 / 序列化器
 *     处理磁盘文件得到的逐字节相等,才记 `memory_import`。
 *
 * 文件**不改名**(和设计稿不同,见 §6):G3 时 daemon 的读者和写者都还在用这些文件(G4 起写者才落表、文件变成导出),改名会让
 * 记忆当场消失。改为第一次导入成功时复制一份 `*.imported-<日期>` 留档,放在 `memory-archive/<chat>/`(1.7.8 之前和原文件放在一起;
 * 主人 10-26 定发版后挪进 memory-archive/、不删 —— 开机时 `importMemoryOnBoot` 把还在原处的挪过去,见 lib/imported-copies)。
 *
 * 指纹(三份文件的总 sha256)没变 ⇒ 什么都不做;变了 ⇒ 再同步一次(G3 时就是镜像:文件还是源)。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../../lib/json-file'
import { ensureArchiveDir, importedCopyName, moveImportedCopies } from '../../lib/imported-copies'
import { readJsonFile } from '../../lib/read-json-file'
import { MEMORY_SECTIONS, factsFromMemoryDoc, factsFromOwnerDoc, type DesiredFact } from '../../domain/memory/facts'
import { type Tombstone, MIN_RETRACTED_CHARS, markWrittenBack, normalizeCorrectionsText, normalizeFactText, placeholderTombstone, renderCorrectionsMd, retractedTextSet, tombstonesFromCorrections } from '../../domain/memory/corrections'
import { renderMemoryForPrompt, renderMemoryMd, renderOwnerForPrompt, renderOwnerMd } from '../../domain/memory/render'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { loadCompanionConfig } from '../../lib/companion-config'
import { parseOwnerDoc, renderOwnerForPrompt as ownerPromptToday, serializeOwnerDoc, type OwnerDoc } from '../../lib/memory-owner'
import { parseMemoryDoc, renderForPrompt, serializeMemoryDoc, type MemoryDoc } from './curated-doc'

export const IMPORTED_FILES = ['memory.md', 'owner.md', 'corrections.md'] as const
type Files = Record<(typeof IMPORTED_FILES)[number], string | null>
/** 核对时 memory.md 头部的生成戳(两边用同一个,只比内容)。 */
const CHECK_STAMP = '1970-01-01T00:00:00.000Z'

export type ImportOutcome =
  | { chatId: string; outcome: 'empty' | 'unchanged' | 'hand_edited' }
  | { chatId: string; outcome: 'imported'; first: boolean; added: number; updated: number; statusChanged: number; gone: number }
  | { chatId: string; outcome: 'mismatch'; what: string; diff: string }

class Mismatch extends Error { constructor(readonly what: string, readonly diff: string) { super(`memory import mismatch: ${what}`) } }

export function readMemoryFiles(root: string): Files {
  const read = (f: string) => { try { return readFileSync(join(root, f), 'utf8') } catch { return null } }
  return { 'memory.md': read('memory.md'), 'owner.md': read('owner.md'), 'corrections.md': read('corrections.md') }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * 记忆归谁:每晚整理、手改核对、主人原话注入都只认这一个对话。一处定义,开机导入和每晚整理运行时(wire.ts)共用 ——
 * 两边认的不是同一个人,手改就会被当成「没人核对」悄悄吞掉(数据安全评审第 1 条)。没配 ⇒ null(那就谁也不是主人)。
 */
export function memoryOwnerChatId(stateDir: string): string | null {
  return loadCompanionConfig(stateDir).default_chat_id ?? null
}

/**
 * 磁盘上这份文件和导出记录对得上吗(只看内容指纹,不看头部那句话 —— 删了头部、整份粘贴覆盖也认得出):
 *  - `no_record`:我们从没导出过它(G4 之前 / 老二进制写的 / 还没搬进表);
 *  - `in_sync`:就是我们最后写下的那份(正要写的那份写成功了也算,顺手把记录补成 done);
 *  - `stale`:磁盘还是上一次确认的那份,但表后来又改了、导出没写成(写文件失败)⇒ 该重新导出;
 *  - `edited`:和我们写过的都不一样 ⇒ 有人在 daemon 之外改过。
 */
export type DiskState = 'no_record' | 'in_sync' | 'stale' | 'edited'
export function diskStateOf(store: MemoryFactsStore, root: string, chatId: string, file: string, ts: number): { state: DiskState; disk: string | null } {
  const rec = store.exportRecord(chatId, file)
  let disk: string | null = null
  try { disk = readFileSync(join(root, file), 'utf8') } catch { disk = null }
  if (!rec) return { state: 'no_record', disk }
  const h = disk === null ? null : sha256(disk)
  if (rec.pending && h === rec.pending) { store.markExportDone(chatId, file, rec.pending, ts); return { state: 'in_sync', disk } }
  if (h === rec.sha256) return { state: rec.pending ? 'stale' : 'in_sync', disk }
  return { state: 'edited', disk }
}

/**
 * 被覆盖 / 被丢开之前的那份磁盘文件存进 `<stateDir>/memory-archive/<chat>/`(同一份内容只存一次)。
 * 规矩:磁盘上任何不是我们自己写下的内容,覆盖之前都先存一份(数据安全评审第 2 条)。返回存档路径。
 */
/** 一个对话的存档目录:`<stateDir>/memory-archive/<chat>/`(root 是 `<stateDir>/memory/<chat>`)。 */
export function memoryArchiveDir(root: string, chatId: string): string {
  return join(dirname(dirname(root)), 'memory-archive', chatId)
}

export function archiveMemoryFile(root: string, chatId: string, file: string, content: string, reason: string): string {
  void reason   // 只给读代码的人看;文件名按内容指纹,同一份内容不管为什么存都只存一次
  const dir = ensureArchiveDir(memoryArchiveDir(root, chatId))
  const p = join(dir, `${file}.kept-${sha256(content).slice(0, 12)}.md`)
  if (!existsSync(p)) writeFileAtomic(p, content, { mode: 0o600 })
  return p
}

/** 还没搬进表的对话:直接从磁盘上的 corrections.md 读出墓碑(读不出 ⇒ 空)。只给导出器的旧路径分支用。 */
export function fileTombstones(root: string, chatId: string): Tombstone[] {
  const raw = readMemoryFiles(root)['corrections.md']
  return raw === null ? [] : tombstonesFromCorrections(chatId, raw) ?? []
}

/** 三份文件的总指纹(不存在也算进去)。三份都不存在 ⇒ null。 */
export function filesHash(files: Files): string | null {
  if (IMPORTED_FILES.every(f => files[f] === null)) return null
  const h = createHash('sha256')
  for (const f of IMPORTED_FILES) h.update(f).update('\0').update(files[f] === null ? '\u0001absent' : files[f]!).update('\0')
  return h.digest('hex')
}

/** 第一处不同的行(日志用)。 */
function firstDiff(want: string, got: string): string {
  const a = want.split('\n'), b = got.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `line ${i + 1}: want ${JSON.stringify(a[i] ?? null)} got ${JSON.stringify(b[i] ?? null)}`
  return 'equal'
}
const check = (what: string, want: string, got: string) => { if (want !== got) throw new Mismatch(what, firstDiff(want, got)) }

/** 去掉正文等于某条收回的话的条目(导入成 retracted 的那些):核对时「今天的代码该看到的那份」。和 markWrittenBack 同一条规则。 */
function withoutRetracted(doc: MemoryDoc, retracted: ReadonlySet<string>): { doc: MemoryDoc } {
  const next: MemoryDoc = { sections: { ...doc.sections }, extra: doc.extra }
  for (const s of MEMORY_SECTIONS) {
    next.sections[s] = doc.sections[s].filter(e => {
      const n = normalizeFactText(e.text)
      return !([...n].length >= MIN_RETRACTED_CHARS && retracted.has(n))
    })
  }
  return { doc: next }
}

/**
 * 一个对话的磁盘文件 → 表(一个事务)。`now` 毫秒;`day` 是留档文件名里的日期。
 * 只在 daemon 的串行处调(开机、memory 模块之前);抛错 = 程序错,核对不过不抛、返回 mismatch。
 */
export function importChatMemory(store: MemoryFactsStore, root: string, chatId: string, now: number, day: string, opts: { ownerChat?: boolean; ownerUnknown?: boolean } = {}): ImportOutcome {
  const files = readMemoryFiles(root)
  const hash = filesHash(files)
  if (!hash) return { chatId, outcome: 'empty' }
  const prior = store.importHash(chatId)
  if (prior === hash) return { chatId, outcome: 'unchanged' }
  // G4 起:我们导出过、磁盘却和我们写过的都不一样 ⇒ 有人在 daemon 之外改过(只看指纹;头部删了、整份覆盖都算)。
  // 先存档(不论后面怎么处理,都不让它被悄悄覆盖)。memory.md:主人的对话 —— 或者还没配主人、谁也认不出 —— 不当成源同步,
  // 交给每晚整理运行时的 reconcileHandEdit 按记忆编辑那张比对表变成更正 / 原话(主人 10-26 定);别的对话没人核对,照文件同步。
  // owner.md / corrections.md:存档后照文件同步(主人原话本来就是主人写的;corrections.md 认不出的核对不过就不搬)。
  for (const f of IMPORTED_FILES) {
    const st = diskStateOf(store, root, chatId, f, now)
    if (st.state !== 'edited' || st.disk === null) continue
    archiveMemoryFile(root, chatId, f, st.disk, 'hand-edit')
    if (f === 'memory.md' && (opts.ownerChat || opts.ownerUnknown)) return { chatId, outcome: 'hand_edited' }
  }

  const fileTombstones = files['corrections.md'] === null ? [] : tombstonesFromCorrections(chatId, files['corrections.md'])
  if (!fileTombstones) return { chatId, outcome: 'mismatch', what: 'corrections.md', diff: 'unrecognized lines before the first entry' }
  try {
    const res = store.atomically(() => {
      const known = store.tombstones(chatId)
      const retracted = retractedTextSet([...known, ...fileTombstones])
      const memDoc = files['memory.md'] === null ? null : parseMemoryDoc(files['memory.md'])
      const ownerDoc: OwnerDoc | null = files['owner.md'] === null ? null : parseOwnerDoc(files['owner.md'])
      const kept = memDoc ? withoutRetracted(memDoc, retracted) : null
      const memRows: DesiredFact[] = memDoc ? markWrittenBack(factsFromMemoryDoc(chatId, memDoc, 'import'), retracted) : []
      const ownRows: DesiredFact[] = ownerDoc ? factsFromOwnerDoc(chatId, ownerDoc) : []
      const haveKeys = new Set([...known.map(t => t.key), ...fileTombstones.map(t => t.key)])
      const placeholders = [...new Set(ownRows.flatMap(r => (r.replacesKey && !haveKeys.has(r.replacesKey) ? [r.replacesKey] : [])))]
        .map((key, i) => placeholderTombstone(chatId, key, fileTombstones.length + known.length + i))
      // corrections.md 只追加:文件里第 i 条就是表里 ord = i 的那条;占位墓碑排在后面
      const desired: DesiredFact[] = [...fileTombstones, ...placeholders, ...memRows, ...ownRows]
      const counts = store.mirror(chatId, desired, {
        by: { actor: 'import', ts: now },
        goneIf: key => (memDoc !== null && (key.startsWith('m:') || key.startsWith('u:') || key.startsWith('x:memory:')))
          || (ownerDoc !== null && (key.startsWith('o:') || key.startsWith('x:owner:'))),
      })

      // 核对:表渲染出来的,和今天的代码处理磁盘文件得到的,逐字节相等
      const rows = store.list(chatId)
      if (kept) {
        check('memory.md', serializeMemoryDoc(kept.doc, CHECK_STAMP), renderMemoryMd(rows, CHECK_STAMP))
        check('memory prompt', renderForPrompt(kept.doc), renderMemoryForPrompt(rows))
      }
      if (ownerDoc) {
        check('owner.md', serializeOwnerDoc(ownerDoc), renderOwnerMd(rows))
        check('owner prompt', ownerPromptToday(ownerDoc), renderOwnerForPrompt(rows))
      }
      const tomb = store.tombstones(chatId).filter(t => t.status === 'retracted' || t.status === 'outdated')
      if (files['corrections.md'] !== null) {
        check('corrections.md', normalizeCorrectionsText(files['corrections.md']), renderCorrectionsMd(tomb))
        check('retracted texts', [...retractedTextSet(fileTombstones)].sort().join('\n'), [...retractedTextSet(tomb.filter(t => fileTombstones.some(f => f.key === t.key)))].sort().join('\n'))
      }
      store.setImportHash(chatId, hash, now)
      return counts
    })
    if (prior === null) {
      for (const f of IMPORTED_FILES) {
        if (files[f] === null) continue
        try {
          const dst = join(ensureArchiveDir(memoryArchiveDir(root, chatId)), importedCopyName(f, day))
          if (!existsSync(dst)) copyFileSync(join(root, f), dst)
        } catch { /* 留档是附带的 */ }
      }
    }
    return { chatId, outcome: 'imported', first: prior === null, ...res }
  } catch (e) {
    if (e instanceof Mismatch) return { chatId, outcome: 'mismatch', what: e.what, diff: e.diff }
    throw e
  }
}

/** 旧的生成物围栏文件(架构终态 G8 起围栏在主库;这个文件名只许出现在导入里,scripts/memory-retract.guard.test.ts 旁的守卫钉住)。 */
const DERIVED_STATE_FILE = '.derived-state.json'

/**
 * 开机一次:把一个对话旧的生成物围栏(`.derived-state.json`)和磁盘上的生成物(`_overview.md` / `_profile.json`)放进主库
 * (架构终态 G8)。表里已经有这个对话的围栏 ⇒ 什么都不做。没有旧文件 ⇒ 生成物算新的(和以前没有那个文件时一样);
 * 旧文件坏了 ⇒ 两样都按「收回」过期(藏起来,等重新生成),和以前读坏了的围栏一样往保守那边走。旧文件不删。
 */
export function importDerivedState(store: MemoryFactsStore, root: string, chatId: string, now: number): boolean {
  let fresh = { overview: true, profile: true }, retracted = { overview: false, profile: false }
  const p = join(root, DERIVED_STATE_FILE)
  if (existsSync(p)) {
    try {
      const st = readJsonFile(p) as { version?: number; revision?: string; overview?: string | null; profile?: string | null; retracted?: { overview?: boolean; profile?: boolean } }
      if (st.version !== 1 || typeof st.revision !== 'string' || !st.revision) throw new Error('bad')
      fresh = { overview: st.overview === st.revision, profile: st.profile === st.revision }
      retracted = { overview: !fresh.overview && (st.retracted?.overview ?? true), profile: !fresh.profile && (st.retracted?.profile ?? true) }
    } catch {
      fresh = { overview: false, profile: false }; retracted = { overview: true, profile: true }
    }
  }
  const bodies: Partial<Record<'overview' | 'profile', { body: string; at: number }>> = {}
  for (const [kind, file] of [['overview', '_overview.md'], ['profile', '_profile.json']] as const) {
    try { bodies[kind] = { body: readFileSync(join(root, file), 'utf8'), at: Math.floor(statSync(join(root, file)).mtimeMs) } } catch { /* 没有就不缓存 */ }
  }
  return store.importFence(chatId, { fresh, retracted, bodies }, now)
}

/** 开机:`<stateDir>/memory/` 下每个有这三份文件之一的对话各导一次。一个对话出错不影响别的。 */
export function importMemoryOnBoot(d: {
  store: MemoryFactsStore; stateDir: string; now: () => number; log: (tag: string, line: string) => void
  /** 每个对话导入之前先跑(memory-export 的 syncStale:上次导出没写成的先补写),避免「表比文件新」被指纹没变挡住。 */
  beforeChat?: (chatId: string) => void
}): ImportOutcome[] {
  const base = join(d.stateDir, 'memory')
  let names: string[] = []
  try { names = readdirSync(base).filter(n => !n.startsWith('.') && statSync(join(base, n)).isDirectory()) } catch { return [] }
  const nowMs = d.now(), day = new Date(nowMs).toISOString().slice(0, 10)
  const owner = memoryOwnerChatId(d.stateDir)
  const out: ImportOutcome[] = []
  for (const chatId of names) {
    try {
      try { moveImportedCopies(join(base, chatId), memoryArchiveDir(join(base, chatId), chatId), IMPORTED_FILES, line => d.log('MEMORY_IMPORT', `${chatId}: ${line}`)) } catch (e) { d.log('MEMORY_IMPORT', `${chatId}: moving old *.imported-* copies failed: ${e instanceof Error ? e.message : String(e)}`) }
      try { importDerivedState(d.store, join(base, chatId), chatId, nowMs) } catch (e) { d.log('MEMORY_IMPORT', `${chatId}: derived-state import failed: ${e instanceof Error ? e.message : String(e)}`) }
      try { d.beforeChat?.(chatId) } catch (e) { d.log('MEMORY_IMPORT', `${chatId}: re-export before import failed: ${e instanceof Error ? e.message : String(e)}`) }
      const r = importChatMemory(d.store, join(base, chatId), chatId, nowMs, day, { ownerChat: chatId === owner, ownerUnknown: owner === null })
      out.push(r)
      if (r.outcome === 'imported') d.log('MEMORY_IMPORT', `${chatId}: ${r.first ? 'imported' : 'resynced'} (+${r.added} ~${r.updated} status ${r.statusChanged} gone ${r.gone})`)
      else if (r.outcome === 'hand_edited') d.log('MEMORY_IMPORT', `${chatId}: memory.md was edited outside the daemon — kept a copy in memory-archive/, not adopted; ${owner ? 'the nightly runtime turns it into corrections / owner words' : 'no owner chat configured, left as is'}`)
      else if (r.outcome === 'mismatch') d.log('MEMORY_IMPORT', `${chatId}: NOT imported — ${r.what} differs (${r.diff}); stays on the file path, retried next boot`)
    } catch (e) {
      d.log('MEMORY_IMPORT', `${chatId}: import failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}


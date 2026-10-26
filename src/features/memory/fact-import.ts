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
 * 记忆当场消失。改为第一次导入成功时复制一份 `*.imported-<日期>` 留档(主人 10-26 定:留到下一个小版本发版,再挪进 memory-archive/,不删)。
 *
 * 指纹(三份文件的总 sha256)没变 ⇒ 什么都不做;变了 ⇒ 再同步一次(G3 时就是镜像:文件还是源)。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_SECTIONS, factsFromMemoryDoc, factsFromOwnerDoc, type DesiredFact } from '../../domain/memory/facts'
import { MIN_RETRACTED_CHARS, markWrittenBack, normalizeCorrectionsText, normalizeFactText, placeholderTombstone, renderCorrectionsMd, retractedTextSet, tombstonesFromCorrections } from '../../domain/memory/corrections'
import { EXPORT_NOTICE, renderMemoryForPrompt, renderMemoryMd, renderOwnerForPrompt, renderOwnerMd } from '../../domain/memory/render'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { correctedTexts } from '../../lib/memory-corrections'
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
export function importChatMemory(store: MemoryFactsStore, root: string, chatId: string, now: number, day: string): ImportOutcome {
  const files = readMemoryFiles(root)
  const hash = filesHash(files)
  if (!hash) return { chatId, outcome: 'empty' }
  const prior = store.importHash(chatId)
  if (prior === hash) return { chatId, outcome: 'unchanged' }
  // G4 起:磁盘上的 memory.md 和最后一次导出不一样、头部还带着「这是生成的」⇒ 是主人手改的,不当成源同步;
  // 交给每晚整理运行时的 reconcileHandEdit 按记忆编辑那张比对表变成更正 / 原话(主人 10-26 定)。
  const lastExport = store.exportHash(chatId, 'memory.md')
  if (lastExport && files['memory.md'] !== null && files['memory.md'].includes(EXPORT_NOTICE)
    && createHash('sha256').update(files['memory.md']).digest('hex') !== lastExport) return { chatId, outcome: 'hand_edited' }

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
        check('retracted texts', [...correctedTexts(root)].sort().join('\n'), [...retractedTextSet(tomb)].sort().join('\n'))
      }
      store.setImportHash(chatId, hash, now)
      return counts
    })
    if (prior === null) {
      for (const f of IMPORTED_FILES) {
        const src = join(root, f), dst = `${src}.imported-${day}`
        if (files[f] !== null && !existsSync(dst)) { try { copyFileSync(src, dst) } catch { /* 留档是附带的 */ } }
      }
    }
    return { chatId, outcome: 'imported', first: prior === null, ...res }
  } catch (e) {
    if (e instanceof Mismatch) return { chatId, outcome: 'mismatch', what: e.what, diff: e.diff }
    throw e
  }
}

/** 开机:`<stateDir>/memory/` 下每个有这三份文件之一的对话各导一次。一个对话出错不影响别的。 */
export function importMemoryOnBoot(d: { store: MemoryFactsStore; stateDir: string; now: () => number; log: (tag: string, line: string) => void }): ImportOutcome[] {
  const base = join(d.stateDir, 'memory')
  let names: string[] = []
  try { names = readdirSync(base).filter(n => !n.startsWith('.') && statSync(join(base, n)).isDirectory()) } catch { return [] }
  const nowMs = d.now(), day = new Date(nowMs).toISOString().slice(0, 10)
  const out: ImportOutcome[] = []
  for (const chatId of names) {
    try {
      const r = importChatMemory(d.store, join(base, chatId), chatId, nowMs, day)
      out.push(r)
      if (r.outcome === 'imported') d.log('MEMORY_IMPORT', `${chatId}: ${r.first ? 'imported' : 'resynced'} (+${r.added} ~${r.updated} status ${r.statusChanged} gone ${r.gone})`)
      else if (r.outcome === 'mismatch') d.log('MEMORY_IMPORT', `${chatId}: NOT imported — ${r.what} differs (${r.diff}); stays on the file path, retried next boot`)
    } catch (e) {
      d.log('MEMORY_IMPORT', `${chatId}: import failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}


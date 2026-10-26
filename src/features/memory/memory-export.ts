/**
 * memory.md / owner.md / corrections.md 唯一的写者(架构终态 G4,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.2 / §3)。
 *
 * 写者(每晚整理、逐条纠错、记忆编辑、从别的助手导入、CC 后来又关掉待办)不再自己写文件:把「改完的那份文档」交给这里,
 * 这里先落表(店面 `mirror`,一个事务,每处变化一条事件),再从表**导出**文件(原子写),记下导出的指纹。
 * 读者 G4 时还不动 —— 它们读到的文件就是导出(G6 才换成读表)。scripts/memory-file-writers.guard.test.ts 守:
 * 往这三份文件写只许在本文件。
 *
 * 还没搬进表的对话(G3 核对不过、留在旧路径的)照旧按今天的格式写文件,下次开机再试着导入;对话里一份文件都还没有 ⇒ 直接走表。
 *
 * 导出的 memory.md 头部带「这是生成的」(主人 10-26 定),只是写给人看的。认手改**只看内容指纹**(数据安全评审第 1 条):
 * 我们导出过、磁盘却和我们写过的都不一样 ⇒ 手改(删了头部、整份粘贴覆盖也算;老二进制回滚后写的也当手改,往保守那边走)。
 * 导出两步记账(先记「正要写的」、写成功再记「已写」),写文件失败时下次开机看得出表比文件新(`syncStale`)。
 * **磁盘上任何不是我们自己写下的内容,覆盖之前都先存进 memory-archive/**(`writeOut` 里兜底,评审第 2 条)。
 * 手改的处理在 nightly-runtime 的 reconcileHandEdit。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../lib/json-file'
import { invalidateDerivedMemory } from '../../lib/memory-derived-state'
import { serializeOwnerDoc, type OwnerDoc } from '../../lib/memory-owner'
import { factsFromMemoryDoc, factsFromOwnerDoc, type DesiredFact, type FactEventActor, type FactSource } from '../../domain/memory/facts'
import { correctionLine, markWrittenBack, renderCorrectionsMd, retractedTextSet, type Verdict } from '../../domain/memory/corrections'
import { renderMemoryMd, renderOwnerMd } from '../../domain/memory/render'
import type { MemoryFactsStore } from '../../ports/memory-facts'
import { serializeMemoryDoc, type MemoryDoc } from './curated-doc'
import { IMPORTED_FILES, archiveMemoryFile, diskStateOf, filesHash, readMemoryFiles } from './fact-import'

export interface WriteBy { actor: FactEventActor; ts: number }
export interface NewCorrection { day: string; verdict: Verdict; section: string; correctionId?: string | null; text: string; note?: string }

export interface MemoryWriter {
  /** 一个对话的 memory.md 改成这份(整理、纠错、编辑、导入调)。`stampIso` 写进头部的「最近整理」。 */
  commitMemory(chatId: string, doc: MemoryDoc, by: WriteBy, stampIso: string): void
  /** owner.md 改成这份(只有记忆编辑调)。主人原话是源 ⇒ 生成物往藏的方向过期。 */
  commitOwner(chatId: string, doc: OwnerDoc, by: WriteBy): void
  /** 记一条收回的话(墓碑 + 导出 corrections.md)。返回它的 key(之后追加说明用)。 */
  addCorrection(chatId: string, c: NewCorrection, by: WriteBy): string
  /** 在那一条收回底下追加一段说明(`  (…)\n`)。 */
  addCorrectionNote(chatId: string, key: string, note: string, by: WriteBy): void
  /** 磁盘上的 memory.md 被手改过(内容和我们写过的都不一样)⇒ 它的内容;否则 null。 */
  handEdited(chatId: string): string | null
  /** 上次导出没写成(表比文件新)的那几份,照表重新导出;手改过的不碰(交给手改核对)。 */
  syncStale(chatId: string, stampIso: string, ts: number): void
  /** 存一份磁盘上现在的 memory.md 进 memory-archive/(手改核对在覆盖之前调)。没有文件 ⇒ null。 */
  archiveDisk(chatId: string, reason: string): string | null
  /** 这个对话由表管吗(导入过,或者一份文件都还没有)。 */
  isOnTable(chatId: string): boolean
  /** 表里的样子渲染出来的 memory.md(不带导出那一句,和今天的序列化同格式);没搬进表 ⇒ null。 */
  tableMemoryMd(chatId: string, stampIso: string): string | null
  /** 把表里的样子重新导出成 memory.md(手改被拒时用)。 */
  reexportMemory(chatId: string, stampIso: string, ts: number): void
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sourceOf = (actor: FactEventActor): FactSource => (actor === 'owner' ? 'review' : actor === 'import' ? 'import' : 'nightly')

export function makeMemoryWriter(d: {
  store: MemoryFactsStore; stateDir: string
  /** 测试用:换掉写文件(模拟写到一半失败)。 */
  writeFile?: (path: string, body: string) => void
}): MemoryWriter {
  const writeFile = d.writeFile ?? ((p: string, body: string) => writeFileAtomic(p, body, { mode: 0o600 }))
  const { store } = d
  const rootOf = (chatId: string) => {
    if (!chatId || chatId.includes('..') || chatId.includes('/') || chatId.includes('\\')) throw new Error(`memory-export: bad chat id ${JSON.stringify(chatId)}`)
    return join(d.stateDir, 'memory', chatId)
  }
  /** 这个对话由表管吗:导入过,或者一份文件都还没有(新对话直接从表开始)。 */
  const onTable = (chatId: string) => store.importHash(chatId) !== null || filesHash(readMemoryFiles(rootOf(chatId))) === null
  const writeOut = (chatId: string, file: string, body: string, ts: number) => {
    const root = rootOf(chatId)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const h = sha(body)
    // 兜底:磁盘上这份不是我们写下的(没记录时是导入前的原文件 / 别人写的;有记录时是手改)⇒ 覆盖之前先存一份
    const rec = store.exportRecord(chatId, file)
    let disk: string | null = null
    try { disk = readFileSync(join(root, file), 'utf8') } catch { disk = null }
    if (disk !== null) {
      const dh = sha(disk)
      if (dh !== h && dh !== rec?.sha256 && dh !== rec?.pending) archiveMemoryFile(root, chatId, file, disk, rec ? 'overwritten' : 'before-first-export')
    }
    store.markExportPending(chatId, file, h, ts)
    writeFile(join(root, file), body)
    store.markExportDone(chatId, file, h, ts)
    // 文件是我们刚写的 ⇒ 下次开机的导入看到的就是它,不再同步
    const fh = filesHash(readMemoryFiles(root))
    if (fh) store.setImportHash(chatId, fh, ts)
  }
  const activeTombstones = (chatId: string) => store.tombstones(chatId).filter(t => t.status === 'retracted' || t.status === 'outdated')
  const exportMemory = (chatId: string, stampIso: string, ts: number) =>
    writeOut(chatId, 'memory.md', renderMemoryMd(store.list(chatId), stampIso, { exported: true }), ts)
  const exportCorrections = (chatId: string, ts: number) => writeOut(chatId, 'corrections.md', renderCorrectionsMd(activeTombstones(chatId)), ts)

  return {
    commitMemory(chatId, doc, by, stampIso) {
      if (!onTable(chatId)) { writeFileAtomic(join(rootOf(chatId), 'memory.md'), serializeMemoryDoc(doc, stampIso)); return }
      store.atomically(() => {
        const retracted = retractedTextSet(activeTombstones(chatId))
        const desired: DesiredFact[] = markWrittenBack(factsFromMemoryDoc(chatId, doc, sourceOf(by.actor)), retracted)
        store.mirror(chatId, desired, { by, goneIf: k => k.startsWith('m:') || k.startsWith('u:') || k.startsWith('x:memory:') })
      })
      exportMemory(chatId, stampIso, by.ts)
    },
    commitOwner(chatId, doc, by) {
      const root = rootOf(chatId)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      invalidateDerivedMemory(root, 'retracted')
      if (!onTable(chatId)) { writeFileAtomic(join(root, 'owner.md'), serializeOwnerDoc(doc), { mode: 0o600 }); return }
      store.atomically(() => {
        store.mirror(chatId, factsFromOwnerDoc(chatId, doc), { by, goneIf: k => k.startsWith('o:') || k.startsWith('x:owner:') })
      })
      writeOut(chatId, 'owner.md', renderOwnerMd(store.list(chatId)), by.ts)
    },
    addCorrection(chatId, c, by) {
      const note = c.note ?? ''
      if (!onTable(chatId)) {
        const key = c.correctionId ? `c:${c.correctionId}` : 'c:~legacy'
        appendFileSync(join(rootOf(chatId), 'corrections.md'), `${correctionLine({ key, section: c.section, text: c.text, seenAt: c.day, verdict: c.verdict })}\n${note}`)
        return key
      }
      const key = store.atomically(() => {
        const all = store.tombstones(chatId)
        const k = c.correctionId ? `c:${c.correctionId}` : `c:~${all.filter(t => t.key.startsWith('c:~')).length + 1}`
        const ord = all.reduce((m, t) => Math.max(m, t.ord + 1), 0)
        store.mirror(chatId, [{
          chatId, key: k, doc: 'memory', subject: 'owner', section: c.section, ord, text: c.text,
          status: c.verdict === 'outdated' ? 'outdated' : 'retracted', source: 'review', seenAt: c.day, verdict: c.verdict, notes: note ? [note] : [],
        }], { by, goneIf: () => false })
        return k
      })
      exportCorrections(chatId, by.ts)
      return key
    },
    addCorrectionNote(chatId, key, note, by) {
      if (!onTable(chatId)) { appendFileSync(join(rootOf(chatId), 'corrections.md'), note); return }
      if (store.addNote(chatId, key, note, by)) exportCorrections(chatId, by.ts)
    },
    handEdited(chatId) {
      const st = diskStateOf(store, rootOf(chatId), chatId, 'memory.md', Date.now())
      return st.state === 'edited' ? st.disk ?? '' : null
    },
    syncStale(chatId, stampIso, ts) {
      if (!onTable(chatId)) return
      const root = rootOf(chatId)
      for (const file of IMPORTED_FILES) {
        if (diskStateOf(store, root, chatId, file, ts).state !== 'stale') continue
        if (file === 'memory.md') exportMemory(chatId, stampIso, ts)
        else if (file === 'owner.md') writeOut(chatId, 'owner.md', renderOwnerMd(store.list(chatId)), ts)
        else exportCorrections(chatId, ts)
      }
    },
    archiveDisk(chatId, reason) {
      const root = rootOf(chatId)
      let disk: string
      try { disk = readFileSync(join(root, 'memory.md'), 'utf8') } catch { return null }
      return archiveMemoryFile(root, chatId, 'memory.md', disk, reason)
    },
    isOnTable: (chatId) => onTable(chatId),
    tableMemoryMd(chatId, stampIso) {
      return onTable(chatId) ? renderMemoryMd(store.list(chatId), stampIso) : null
    },
    reexportMemory(chatId, stampIso, ts) {
      if (onTable(chatId)) exportMemory(chatId, stampIso, ts)
    },
  }
}

/**
 * 每晚记忆整理的运行时:15 分钟一次 tick(该跑就跑一次整理、再看看待发通知),
 * 「整理记忆」的立即运行,以及给微信(文本)与手机(结构)的只读视图。
 */
import { agendaDropPrompt, dropAgendaItems, dropCorrectedAgenda, normalizeMemoryText, openAgendaItems, parseAgendaDropAnswer, purgeCorrectedFromSources } from '../../lib/memory-corrections'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import { readSources, writeSources } from './sources'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_CAP_CHARS, MEMORY_FILENAME, SECTIONS, assignMissingIds, docChars, parseDue, parseMemoryDoc, serializeMemoryDoc, type Section } from './curated-doc'
import { DISPLAY_ORDER, dueLabel, formatWeChatMemory, splitPerson, spokenTime, stripDue, viewChanges, type ViewChange } from './memory-text'
import type { RetractRef } from '../../ports/memory-facts'
import type { Retraction } from './memory-export'
import { MEMORY_LOG_FILE, ownerMemoryRoot, readCorrections, readNightlyState, runMemoryNightly, writeNightlyState, type NightlyRunDeps } from './nightly'
import type { NightlyRunResult } from './nightly-notify'
import { MAX_ENTRY_CHARS, type AppliedOp } from './nightly-ops'
import { localParts, noticeTiming } from './nightly-schedule'
import { writeFileAtomic } from '../../lib/json-file'
import { OWNER_FILENAME, readOwnerDoc, type AssertionOrigin } from '../../lib/memory-owner'
import { BULK_CORRECTIONS, baseHashOf, keyGeneratedLines, overviewTextLines, ownerLines, planEdit, type EditLine, type EditableMemoryPath, type Replaces, type ViewLine } from '../../lib/memory-edit'

export interface NoticeDeps {
  /** 这一种自己的节奏(companion/calibration shouldSpeak memory:冷却 / 无回复暂停 / care)。 */
  careGate(chatId: string, nowIso: string): { ok: true } | { ok: false; reason: string }
  claim(chatId: string, nowIso: string): void
  /** CC 主动开口唯一的门(第三批 3a):别烦我、免打扰、两条路都送不到由它判;往哪儿送(微信 / App)由它背后的 proactive-channel 定。 */
  speech: import('../../daemon/speech/policy').SpeechPolicy
}
export interface CuratedItem {
  /** 这条是从哪几句聊天里来的(时间 + 摘一段;10-20 起每晚整理才记,老条目为空)。 */
  sources: Array<{ ts: string; excerpt: string; kind?: 'import' }>
  id: string | null
  text: string
  display: string
  due: string | null
  due_label: string | null
  person: { name: string; rel: string } | null
  changed: boolean
}
export interface CuratedView {
  updated_at: string | null
  when_label: string | null
  mood: 'changed' | 'steady' | 'first'
  failures: number
  changes: ViewChange[]
  sections: Array<{ name: Section; items: CuratedItem[] }>
}
export interface MemoryNightlyRuntime {
  tick(): Promise<void>
  runNow(): Promise<NightlyRunResult>
  readCurated(): string | null
  curatedView(): CuratedView
  /** 主人逐条纠错(2026-10-06,步骤 A):不对 / 过时 / 删掉。立刻从 memory.md 拿掉,并在 profile.md 记一行
   *  (当天的会话经「今天的草稿」就看得到;当晚整理把它当素材,不再写回)。过时的另抄进归档。 */
  correct(id: string, verdict: MemoryVerdict): Promise<{ text: string }>
  /** 从别的助手导入(2026-10-20,第二轮对标 #7):主人点过头的那几条写进记忆,出处记成「从 X 导入」。
   *  与每晚整理同一条串行链;重复的、主人纠正过的、太长的、超出总长的都跳过。 */
  importEntries(items: ReadonlyArray<{ section: Section; text: string }>, label: string): Promise<ImportResult>
  /** 记忆编辑的底稿(设计稿 2026-10-23 记忆改了就算数 §3):主人原话在前,生成的行在后,每行带键。 */
  view(path: EditableMemoryPath): MemoryView
  /**
   * 一种收回的另外几个入口(G5):待办「不对」、证据审阅的纠正 / 过期、MCP 的 superseded。只给一句话:找得到同样的记忆条目 / 原话
   * 就一起收回,找不到也留下收回的记录;清源头、关待办和逐条纠错一样(含后台问便宜模型)。只认主人自己的对话。
   */
  retractText(chatId: string, text: string, verdict: MemoryVerdict, section: string): Promise<{ key: string } | null>
  /** 撤销一次收回(主人 10-26 第 3 条):那一行回到记忆里;之前随之删掉的笔记行不会回来。 */
  restore(key: string): Promise<{ restored: string[] } | null>
  /** 收回的话(主人 10-26 第 2 条:记忆页上的 corrections.md 换成这张列表)。 */
  retractions(): Retraction[]
  /** 记忆编辑(§4):按键比对,删 / 改 ⇒ 更正,加 / 改写 ⇒ 主人原话。与每晚整理同一条串行链。 */
  edit(req: { path: EditableMemoryPath; baseHash: string; lines: readonly EditLine[]; confirmBulk?: boolean }): Promise<MemoryEditResult>
}
/** chatId = 这份记忆属于哪个对话(主人的,default_chat_id);桌面只在打开的正是它时才用逐行编辑。 */
export interface MemoryView { chatId: string; path: EditableMemoryPath; baseHash: string; generatedAt: string | null; stale: boolean; lines: ViewLine[] }
export type MemoryEditResult =
  | { ok: true; corrections: Array<{ id: string; text: string }>; assertions: Array<{ id: string; text: string; replaces?: Replaces }>; regenerate: 'queued' | 'not_needed' }
  | Exclude<ReturnType<typeof planEdit>, { ok: true }>
  | { ok: false; code: 'memory_changed' }
export interface ImportResult { added: number; skipped: { duplicate: number; corrected: number; invalid: number; cap: number } }
export type MemoryVerdict = 'wrong' | 'outdated' | 'delete'

const CHANGED_WINDOW_MS = 36 * 3_600_000

export async function deliverPendingNotice(deps: NightlyRunDeps & NoticeDeps): Promise<'none' | 'sent' | 'waiting' | 'expired' | 'dropped'> {
  const state = readNightlyState(deps.stateDir)
  const pending = state.pendingNotice
  const owner = deps.ownerChatId()
  if (!pending || !owner) return 'none'
  const nowMs = deps.now()
  const clear = () => writeNightlyState(deps.stateDir, { ...readNightlyState(deps.stateDir), pendingNotice: null })
  const timing = noticeTiming({ nowMs, tz: deps.config().timezone, createdAtMs: pending.createdAtMs })
  if (timing === 'expire') { clear(); deps.log('MEMORY_NIGHTLY', 'notice expired unsent'); return 'expired' }
  if (timing === 'wait') return 'waiting'
  const nowIso = new Date(nowMs).toISOString()
  const gate = deps.careGate(owner, nowIso)
  // 冷却没到 ⇒ 晚点再说(通知留着,24 小时过了自己作废);别的拒绝原因交给门,由它判 drop
  if (!gate.ok && gate.reason === 'memory_cooldown') return 'waiting'
  const outcome = await deps.speech.say({ kind: 'memory_notice', chatId: owner, nowMs, perKind: gate }, async (turn) => {
    deps.claim(owner, nowIso)   // 先登记再发:至多一次,不重试轰炸
    clear()
    const r = await turn.sendText(owner, pending.text)
    if (r.error) deps.log('MEMORY_NIGHTLY', `notice send failed (not retried): ${r.error}`)
  })
  // 免打扰 / 两条路都送不到 ⇒ 往后推(通知留着);别烦我 / 无回复暂停 ⇒ 这一份不发了
  if ('defer' in outcome) return 'waiting'
  if ('drop' in outcome) {
    clear()
    deps.log('MEMORY_NIGHTLY', `notice dropped: ${outcome.reason}`)
    return 'dropped'
  }
  return 'sent'
}

function lastLog(root: string): { at: string; ops: AppliedOp[] } | null {
  const p = join(root, MEMORY_LOG_FILE)
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').trim().split('\n')
  try { return JSON.parse(lines[lines.length - 1]!) as { at: string; ops: AppliedOp[] } } catch { return null }
}

const AGENDA_EVAL_TIMEOUT_MS = 60_000

export function makeMemoryNightlyRuntime(deps: NightlyRunDeps & NoticeDeps): MemoryNightlyRuntime {
  async function dropAgendaByModel(c: Done): Promise<void> {
    const items = openAgendaItems(c.root)
    if (items.length === 0) return
    const evalFn = deps.cheapEval()
    if (!evalFn) return
    let raw: string
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      raw = await Promise.race([
        evalFn(agendaDropPrompt(c.text, items)),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), AGENDA_EVAL_TIMEOUT_MS) }),
      ])
    } catch (err) {
      deps.log('MEMORY_NIGHTLY', isNetworkUnprotectedError(err) ? 'agenda model drop skipped — network unprotected' : `agenda model drop skipped: ${err instanceof Error ? err.message : String(err)}`)
      return
    } finally { if (timer) clearTimeout(timer) }
    const picks = parseAgendaDropAnswer(raw, items.length).map(n => items[n - 1]!)
    const n = dropAgendaItems(c.root, picks, c.day, c.archive, `${c.stamp}-model`)
    if (!n) return
    // 主人看得到:在更正记录里补一行,说清是 CC 判断的。这一行不能带「] 」—— 更正记录按它认「被更正的原话」,
    // 待办原文里有的话会被当成又一条更正(换成全角)。
    const named = picks.map(p => p.text.replace(/\]/g, '］')).join(';')
    deps.writer.addCorrectionNote(c.chatId, c.key, `  (CC 又判断 agenda.md 里 ${n} 条待办在跟进这件事,也改成 dropped:${named})\n`, { actor: 'cc', ts: deps.now() })
    deps.log('MEMORY_NIGHTLY', `agenda model drop: ${n}`)
  }

  /** 一条更正落下之后,后台再问便宜模型关待办要的东西;key = 那条收回在表里的 key(说明追加在它底下)。 */
  type Done = { text: string; root: string; chatId: string; key: string; day: string; archive: string; stamp: string }
  /** 从 memory.md 的文档里拿掉一条(按编号)。 */
  function takeEntry(doc: ReturnType<typeof parseMemoryDoc>, id: string): { section: Section; text: string } | null {
    for (const name of SECTIONS) {
      const i = doc.sections[name].findIndex(e => e.id === id)
      if (i >= 0) { const text = doc.sections[name][i]!.text; doc.sections[name].splice(i, 1); return { section: name, text } }
    }
    return null
  }
  /** 没编号的一行(还没补编号的条目 / 栏外):按规范化文字拿掉第一处。 */
  function takeLineByText(doc: ReturnType<typeof parseMemoryDoc>, text: string): boolean {
    const n = normalizeMemoryText(text)
    for (const name of SECTIONS) {
      const i = doc.sections[name].findIndex(e => !e.id && normalizeMemoryText(e.text) === n)
      if (i >= 0) { doc.sections[name].splice(i, 1); return true }
    }
    const j = doc.extra.findIndex(l => normalizeMemoryText(l.replace(/^(?:[-*+]|\d+[.)])\s+/, '')) === n)
    if (j >= 0) { doc.extra.splice(j, 1); return true }
    return false
  }
  /**
   * 一条更正落下之后的那几步(调用方已经在串行链上,memory.md 已经改好或不用改):生成物过期、清源头、关待办、
   * 记进 corrections.md。correctionId 记在段名里(`[总览 · c:<id>]`)—— 更正记录按「] 」认原话,段名里不能有「] 」。
   */
  /**
   * 一种收回(架构终态 G5,设计稿 §2.3):逐条纠错、记忆编辑、待办「不对」、证据审阅、MCP 的 superseded 都走这里。
   * 副作用(生成物过期、清源头、关待办)是收回的后果,回执写进墓碑的说明;收回本身是表里的一行墓碑 + 被收回的行(`ref`)。
   */
  function recordCorrection(r: string, section: string, text: string, verdict: MemoryVerdict, o: { entryId?: string; correctionId?: string; ref?: RetractRef; actor?: 'owner' | 'judge'; nowMs: number }): Done {
    const nowMs = o.nowMs, day = localParts(nowMs, deps.config().timezone).day
    // 主人纠正 / 标过期 ⇒ 'retracted':旧总览里可能正好有这句,藏起来等重新生成(3e 记忆第 2 步)。
    deps.writer.fence(deps.ownerChatId()!).invalidate('retracted')
    // 清源头(3b (a)):CC 的笔记 / 偏好 / notes/ 里含这句的行也删掉,不然下次合成又学回来(主人以为 CC 忘了,其实只是暂时没说)。
    // 每个改动的文件先快照进 memory-archive,能找回;删了哪几个文件几行记在这一条底下,主人看得到。
    const owner = deps.ownerChatId()
    const purgeArchive = join(deps.stateDir, 'memory-archive', owner ?? 'unknown', 'corrections')
    let purged: Array<{ file: string; lines: number }> = []
    try { purged = purgeCorrectedFromSources(r, text, purgeArchive, `${day}-${nowMs}`) }
    catch (err) { deps.log('MEMORY_NIGHTLY', `correction purge failed (memory.md already updated): ${err instanceof Error ? err.message : String(err)}`) }
    // 跟进计划里照抄了这句的待办也关掉(不删,标 dropped),免得到点 CC 又问起主人撤掉的事。
    let agendaDropped = 0
    try { agendaDropped = dropCorrectedAgenda(r, text, day, purgeArchive, `${day}-${nowMs}`) }
    catch (err) { deps.log('MEMORY_NIGHTLY', `agenda drop failed: ${err instanceof Error ? err.message : String(err)}`) }
    const parts = [...purged.map(p => `${p.file} 删了 ${p.lines} 行`), ...(agendaDropped ? [`agenda.md 里 ${agendaDropped} 条待办改成 dropped`] : [])]
    const purgeNote = parts.length ? `  (随之从 ${parts.join('、')};原文件在 memory-archive/${owner ?? 'unknown'}/corrections/)\n` : ''
    // memory.md 改好了才记:失败了 memory.md 没动,也不留一行假的纠正。落表 + 导出。
    const chatId = owner ?? ''
    const ref: RetractRef = o.ref ?? (o.entryId ? { key: `m:${o.entryId}` } : { text })
    const key = deps.writer.retract(chatId, ref, { day, verdict, section, correctionId: o.correctionId ?? null, text, note: purgeNote }, { actor: o.actor ?? 'owner', ts: nowMs })
    if (o.entryId) {
      const src = readSources(r)
      if (src[o.entryId]) { delete src[o.entryId]; try { writeSources(r, src) } catch { /* 出处是附带的 */ } }
    }
    if (verdict === 'outdated' && owner) {
      const archiveDir = join(deps.stateDir, 'memory-archive', owner)
      mkdirSync(archiveDir, { recursive: true })
      appendFileSync(join(archiveDir, 'memory-expired.md'), `- ${day} [${section}] ${text}(owner_outdated)\n`)
    }
    deps.log('MEMORY_NIGHTLY', `owner ${verdict} ${o.entryId ?? o.correctionId ?? ''}`)
    return { text, root: r, chatId, key, day, archive: purgeArchive, stamp: `${day}-${nowMs}` }
  }
  /** `memoryOverride`:拿这份当 memory.md(手改核对时用表里的样子,不用磁盘上被改过的那份)。 */
  function buildView(path: EditableMemoryPath, memoryOverride?: string): MemoryView {
    const r = root(), chatId = deps.ownerChatId()
    if (!r || !chatId) throw new Error('no_owner')
    // G6:memory.md / owner.md 从表里读(经导出器;没搬进表的对话照旧读文件)。_overview.md 到 G8 才进表,这里照旧读文件。
    const viewSource = (name: string): string => {
      if (name === 'memory.md') return memoryOverride ?? deps.writer.memoryMd(chatId) ?? ''
      if (name === 'owner.md') return deps.writer.ownerMd(chatId)
      try { return readFileSync(join(r, name), 'utf8') } catch { return '' }
    }
    const file = viewSource(path), ownerRaw = path === 'owner.md' ? file : viewSource('owner.md')
    const owner = ownerLines(deps.writer.ownerDoc(chatId), id => deps.writer.correctionText(chatId, id))
    let generated: ViewLine[] = []
    let generatedAt: string | null = null
    if (path === '_overview.md') {
      generated = keyGeneratedLines(overviewTextLines(file))
      generatedAt = /生成 · (\d{4}-\d{2}-\d{2}T[^ ]+) -->/.exec(file)?.[1] ?? null
    } else if (path === 'memory.md') {
      generated = memoryViewLines(file)
    }
    return { chatId, path, baseHash: baseHashOf(file, ownerRaw), generatedAt, stale: path === '_overview.md' && deps.writer.fence(chatId).isStale('overview'), lines: [...owner, ...generated] }
  }

  /** memory.md 里能编辑的行(带键):条目按编号,栏外的按文字。 */
  function memoryViewLines(file: string): ViewLine[] {
    const doc = parseMemoryDoc(file)
    const entries = SECTIONS.flatMap(n => doc.sections[n])
    const extra = doc.extra.map(l => l.trim()).filter(l => l && !/^#{1,6}\s/.test(l) && !l.startsWith('<!--')).map(l => l.replace(/^(?:[-*+]|\d+[.)])\s+/, ''))
    return keyGeneratedLines([...entries.map(e => e.text), ...extra], [...entries.map(e => e.id), ...extra.map(() => null)])
  }

  /**
   * 落一份编辑计划(记忆页的编辑、和手改 memory.md 的核对共用):更正逐条记(清源头 / 关待办 / 收回),memory.md 里那几行拿掉,
   * 新的主人原话进 owner.md。`doc` = 编辑之前的 memory.md。
   */
  function applyPlan(r: string, path: EditableMemoryPath, plan: import('../../lib/memory-edit').EditPlan, doc: ReturnType<typeof parseMemoryDoc> | null, nowMs: number):
    { corrections: Array<{ id: string; text: string }>; assertions: Array<{ id: string; text: string; replaces?: Replaces }>; done: Done[]; docChanged: boolean } {
    const day = localParts(nowMs, deps.config().timezone).day
    const origin: AssertionOrigin = path === '_overview.md' ? 'overview' : path === 'memory.md' ? 'memory' : 'owner'
    let docChanged = false
    const done: Done[] = []
    // 顺序是有意的:先过期、再逐条记更正(清源头 / 关待办 / 收回),最后才写 memory.md / owner.md。
    // 中途失败 ⇒ 「已经更正、文件还没改」:被更正的话已经进了清单,出口过滤和整理都会挡住它,不会被说出去 —— 宁可这样,
    // 不要反过来(文件改了、更正没记,下次整理又从别处学回来)。
    deps.writer.fence(deps.ownerChatId()!).invalidate('retracted')
    const corrections: Array<{ id: string; text: string }> = []
    for (const c of plan.corrections) {
      const cid = deps.newId()
      let section = c.assertionId ? '你写的' : origin === 'overview' ? '总览' : '记忆'
      const entryId = c.lineKey?.startsWith('m:') ? c.lineKey.slice(2) : null
      if (entryId && doc) {
        const hit = takeEntry(doc, entryId)
        if (hit) { section = hit.section; docChanged = true }
      } else if (doc && origin === 'memory' && c.lineKey) {
        // 没编号的那几行(栏外 / 还没补编号的条目)按文字拿掉一行
        docChanged = takeLineByText(doc, c.text) || docChanged
      }
      const ref: RetractRef = c.assertionId ? { key: `o:${c.assertionId}` } : c.lineKey?.startsWith('m:') ? { key: c.lineKey } : { text: c.text }
      done.push(recordCorrection(r, section, c.text, 'wrong', { correctionId: cid, ref, nowMs }))
      corrections.push({ id: cid, text: c.text })
    }
    if (doc && docChanged) deps.writer.commitMemory(deps.ownerChatId()!, doc, { actor: 'owner', ts: nowMs }, new Date(nowMs).toISOString())
    const ownerDoc = deps.writer.ownerDoc(deps.ownerChatId()!)
    const removed = new Set(plan.removedAssertionIds)
    ownerDoc.assertions = ownerDoc.assertions.filter(a => !removed.has(a.id))
    const assertions: Array<{ id: string; text: string; replaces?: Replaces }> = []
    for (const a of plan.assertions) {
      const id = deps.newId()
      const rep = a.replacesIndex !== undefined ? corrections[a.replacesIndex] : undefined
      ownerDoc.assertions.push({ id, text: a.text, date: day, origin, ...(rep ? { replaces: rep.id } : {}) })
      assertions.push({ id, text: a.text, ...(rep ? { replaces: { correctionId: rep.id, text: rep.text } } : {}) })
    }
    if (removed.size || assertions.length) deps.writer.commitOwner(deps.ownerChatId()!, ownerDoc, { actor: 'owner', ts: nowMs })
    return { corrections, assertions, done, docChanged }
  }

  /** 后台问便宜模型关换了说法的待办;一次最多问 BULK_CORRECTIONS 次。 */
  function dropAgendaInBackground(done: readonly Done[]): void {
    for (const d of done.slice(0, BULK_CORRECTIONS)) {
      void serial(() => dropAgendaByModel(d)).catch(err => deps.log('MEMORY_NIGHTLY', `agenda model drop failed: ${err instanceof Error ? err.message : String(err)}`))
    }
    if (done.length > BULK_CORRECTIONS) deps.log('MEMORY_NIGHTLY', `agenda model drop: skipped ${done.length - BULK_CORRECTIONS} of a bulk edit (verbatim drop still ran)`)
  }

  /** 比较用:去掉头部注释、行尾空白和空行。只差这些 ⇒ 不算手改了什么。 */
  const normalizeForCompare = (md: string) => md.replace(/^\uFEFF/, '').split('\n').map(l => l.trimEnd()).filter(l => l && !l.startsWith('<!-- wechat-cc 记忆')).join('\n')

  /**
   * 每个读写 memory.md 的入口先过这里(数据安全评审第 1 条:不只是每晚那一拍):
   *  1. 上次导出没写成(表比文件新)⇒ 照表补写;
   *  2. 主人用编辑器直接改了导出的 memory.md(主人 10-26 定,设计稿 §4 第 4 条)—— 只看内容指纹,删了头部、整份覆盖都认得出:
   *     不悄悄覆盖,也不悄悄采纳。和表里的样子有实质差别 ⇒ **先存一份进 memory-archive/**,再按记忆编辑那张比对表
   *     (表里的样子 → 磁盘上的样子)变成更正 / 原话、落表、重新导出,微信里告诉主人一次;比对表看不出的改动(挪栏、改尾注 …)
   *     或者多到要主人确认的,不照办,导出照表里的样子,告诉主人原样存在哪儿。只差空白 / 头部 ⇒ 照表重新导出,不打扰。
   * 导出写下以后指纹就对上了,同一次手改只会处理、通知一次。
   */
  function syncDisk(): void {
    const owner = deps.ownerChatId(), r = root()
    if (!owner || !r) return
    const nowMs = deps.now(), nowIso = new Date(nowMs).toISOString()
    deps.writer.syncStale(owner, nowIso, nowMs)
    const disk = deps.writer.handEdited(owner)
    if (disk === null) return
    const tableMd = deps.writer.tableMemoryMd(owner, nowIso)
    if (tableMd === null) return
    if (normalizeForCompare(disk) === normalizeForCompare(tableMd)) { deps.writer.reexportMemory(owner, nowIso, nowMs); return }
    deps.writer.archiveDisk(owner, 'hand-edit')
    const before = buildView('memory.md', tableMd)
    const lines: EditLine[] = [
      ...before.lines.filter(l => l.origin === 'owner').map(l => ({ text: l.text, assertionId: l.assertionId! })),
      ...memoryViewLines(disk).map(l => ({ text: l.text, lineKey: l.lineKey! })),
    ]
    const planned = planEdit(before.lines, lines, { confirmBulk: false })
    let notice: string
    if (planned.ok && (planned.plan.corrections.length || planned.plan.assertions.length)) {
      const res = applyPlan(r, 'memory.md', planned.plan, parseMemoryDoc(tableMd), nowMs)
      deps.writer.reexportMemory(owner, nowIso, nowMs)
      dropAgendaInBackground(res.done)
      notice = `你直接在编辑器里改了 memory.md。那份是生成的,改那里本来不算数 —— 这次我照记忆页的规矩记下了:${res.corrections.length} 条当作记错了、${res.assertions.length} 条记成你说的(改之前那份存在 memory-archive/${owner}/ 里)。以后改记忆请到记忆页。`
      deps.log('MEMORY_NIGHTLY', `hand edit of memory.md reconciled: ${res.corrections.length} corrections, ${res.assertions.length} assertions; kept a copy`)
    } else {
      deps.writer.reexportMemory(owner, nowIso, nowMs)
      notice = planned.ok
        ? `你直接在编辑器里改了 memory.md,改的是位置 / 格式这类我照记忆页的规矩认不出来的东西,所以没有照办(原样存在 memory-archive/${owner}/ 里)。memory.md 是生成的,要改记忆请到记忆页。`
        : `你直接在编辑器里改了 memory.md,改动太多,我没有自动照办(原样存在 memory-archive/${owner}/ 里)。memory.md 是生成的,要改记忆请到记忆页。`
      deps.log('MEMORY_NIGHTLY', `hand edit of memory.md not applied (${planned.ok ? 'not_line_level' : planned.code}); kept a copy, re-exported`)
    }
    writeNightlyState(deps.stateDir, { ...readNightlyState(deps.stateDir), pendingNotice: { text: notice, createdAtMs: nowMs } })
  }
  const syncDiskSafely = () => { try { syncDisk() } catch (err) { deps.log('MEMORY_NIGHTLY', `hand-edit check failed: ${err instanceof Error ? err.message : String(err)}`) } }

  const root = (): string | null => {
    const owner = deps.ownerChatId()
    return owner ? ownerMemoryRoot(deps.stateDir, owner) : null
  }
  const readDoc = () => {
    const r = root(), owner = deps.ownerChatId()
    const doc = r && owner ? deps.writer.memoryDoc(owner) : null
    return r && doc ? { root: r, doc } : null
  }
  // tick() and runNow() (CLI, /v1/memory/nightly/run, 微信「整理记忆」) share
  // one chain: a call waits for any in-flight run, so this process never has
  // two runMemoryNightly in parallel (they'd race on memory.md and state).
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  // A skip reason like disabled / failed_today would otherwise log every
  // 15-min tick (~96 lines/day). Log it only when it changes.
  let lastSkipReason: string | null = null
  return {
    tick: () => serial(async () => {
      syncDiskSafely()
      const r = await runMemoryNightly(deps, { force: false })
      if (r.status === 'skipped') {
        if (r.reason !== 'not_due' && r.reason !== lastSkipReason) deps.log('MEMORY_NIGHTLY', `tick: skipped (${r.reason})`)
        lastSkipReason = r.reason
      } else {
        lastSkipReason = null
        deps.log('MEMORY_NIGHTLY', `tick: ${r.status}${r.status === 'written' ? '' : ` (${r.reason})`}`)
      }
      await deliverPendingNotice(deps)
    }),
    runNow: () => serial(() => { syncDiskSafely(); return runMemoryNightly(deps, { force: true }) }),
    // 与每晚整理同一条串行链:不会和它同时改 memory.md
    correct: async (id, verdict) => {
      const done = await serial(async () => {
      syncDiskSafely()
      const got = readDoc()
      if (!got) throw new Error('memory_not_found')
      const hit = takeEntry(got.doc, id)
      if (!hit) throw new Error('memory_entry_not_found')
      const nowMs = deps.now()
      // 先让生成物过期再改源:中途崩了,宁可总览多藏一会儿,也不把撤掉的话留在外面
      deps.writer.fence(deps.ownerChatId()!).invalidate('retracted')
      deps.writer.commitMemory(deps.ownerChatId()!, got.doc, { actor: 'owner', ts: nowMs }, new Date(nowMs).toISOString())
      return recordCorrection(got.root, hit.section, hit.text, verdict, { entryId: id, nowMs })
      })
      // 逐字匹配是底线;CC 自己换了说法的待办(「关心杭州之行」对「下周去杭州出差」)再问一次便宜模型。
      // 放在后台、排在同一条串行链上:主人点「不对」不用等模型;模型只能从开着的待办里挑,只会多关、不会少关;
      // 没模型 / 网络不安全 / 超时 / 出错 ⇒ 就停在逐字那一步,不重试。
      void serial(() => dropAgendaByModel(done)).catch(err => deps.log('MEMORY_NIGHTLY', `agenda model drop failed: ${err instanceof Error ? err.message : String(err)}`))
      return { text: done.text }
    },
    view: (path) => { syncDiskSafely(); return buildView(path) },
    retractText: async (chatId, text, verdict, section) => {
      const owner = deps.ownerChatId()
      if (!owner || chatId !== owner || !text.trim()) return null
      const done = await serial(async () => {
        syncDiskSafely()
        const r = root()
        if (!r) return null
        return recordCorrection(r, section, text.trim(), verdict, { ref: { text: text.trim() }, nowMs: deps.now() })
      })
      if (!done) return null
      dropAgendaInBackground([done])
      return { key: done.key }
    },
    restore: (key) => serial(async () => {
      syncDiskSafely()
      const owner = deps.ownerChatId()
      if (!owner) return null
      const res = deps.writer.restore(owner, key, { actor: 'owner', ts: deps.now() })
      if (res) deps.log('MEMORY_NIGHTLY', `owner restored ${key}: ${res.restored.length} line(s) back`)
      return res
    }),
    retractions: () => {
      const owner = deps.ownerChatId()
      return owner ? deps.writer.retractions(owner) : []
    },
    edit: async (req) => {
      const out = await serial(async (): Promise<{ result: MemoryEditResult; done: Done[] }> => {
        syncDiskSafely()
        const r = root()
        if (!r) throw new Error('no_owner')
        const before = buildView(req.path)
        if (before.baseHash !== req.baseHash) return { result: { ok: false, code: 'memory_changed' }, done: [] }
        const planned = planEdit(before.lines, req.lines, { confirmBulk: req.confirmBulk })
        if (!planned.ok) return { result: planned, done: [] }
        const { plan } = planned
        if (!plan.corrections.length && !plan.assertions.length) return { result: { ok: true, corrections: [], assertions: [], regenerate: 'not_needed' }, done: [] }
        const nowMs = deps.now()
        // 记忆里的条目:先从 memory.md 拿掉(和逐条纠错同一个动作),再记更正
        const doc = deps.writer.memoryDoc(deps.ownerChatId()!)
        const { corrections, assertions, done } = applyPlan(r, req.path, plan, doc, nowMs)
        deps.log('MEMORY_NIGHTLY', `owner edit ${req.path}: ${corrections.length} corrections, ${assertions.length} assertions`)
        // 'queued' = 总览已过期、在下一次定时整理(或主人点「整理记忆」)时重新生成;这里不额外调模型(3e 的懒过期)。
        return { result: { ok: true, corrections, assertions, regenerate: 'queued' }, done }
      })
      // 和逐条纠错一样在后台问便宜模型关换了说法的待办;一次编辑最多问 BULK_CORRECTIONS 次(主人确认过的大批删除不跟着翻倍花钱)。
      dropAgendaInBackground(out.done)
      return out.result
    },
    importEntries: (items, label) => serial(async (): Promise<ImportResult> => {
      syncDiskSafely()
      const r = root()
      if (!r) throw new Error('no_owner')
      mkdirSync(r, { recursive: true })
      const nowMs = deps.now(), nowIso = new Date(nowMs).toISOString(), day = localParts(nowMs, deps.config().timezone).day
      const doc = assignMissingIds(deps.writer.memoryDoc(deps.ownerChatId()!) ?? parseMemoryDoc(''), deps.newId, day)
      const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
      const have = new Set(SECTIONS.flatMap(s => doc.sections[s].map(e => norm(e.text))))
      const rejected = readCorrections(deps.writer, deps.ownerChatId()!).texts
      const skipped = { duplicate: 0, corrected: 0, invalid: 0, cap: 0 }
      const added: Array<{ id: string; section: Section; text: string }> = []
      for (const it of items) {
        const text = norm(it.text)
        // 再守一道:一行、不带 memory.md 的注释语法 / 尖括号(评审 #440)
        if (!SECTIONS.includes(it.section) || !text || [...text].length > MAX_ENTRY_CHARS || /[<>]|-->|<!--/.test(text)) { skipped.invalid++; continue }
        if (have.has(text)) { skipped.duplicate++; continue }
        if (rejected.has(text)) { skipped.corrected++; continue }
        const id = deps.newId()
        doc.sections[it.section].push({ id, text, seen: day })
        if (docChars(doc) > MEMORY_CAP_CHARS) { doc.sections[it.section].pop(); skipped.cap++; continue }
        have.add(text); added.push({ id, section: it.section, text })
      }
      if (added.length) {
        deps.writer.fence(deps.ownerChatId()!).invalidate('added')  // 导入只加不删
        deps.writer.commitMemory(deps.ownerChatId()!, doc, { actor: 'import', ts: nowMs }, nowIso)
        // 「CC 做过的事」里的记忆那一行读这份日志;出处标成导入(手机「CC 眼中的你」显示「从 X 导入」)
        try { appendFileSync(join(r, MEMORY_LOG_FILE), JSON.stringify({ at: nowIso, ops: added.map(a => ({ kind: 'add', ...a })), source: 'import' }) + '\n') } catch { /* 日志是附带的 */ }
        try {
          const src = readSources(r)
          const excerpt = `从 ${label.replace(/[\r\n]+/g, ' ').slice(0, 40)} 导入`
          for (const a of added) src[a.id] = [{ id: 'import', ts: nowIso, excerpt, kind: 'import' }]
          writeSources(r, src)
        } catch { /* 出处是附带的 */ }
      }
      deps.log('MEMORY_NIGHTLY', `import: added ${added.length}, skipped ${JSON.stringify(skipped)}`)
      return { added: added.length, skipped }
    }),
    readCurated() {
      syncDiskSafely()
      const got = readDoc()
      if (!got) return null
      const state = readNightlyState(deps.stateDir)
      const tz = deps.config().timezone
      const log = lastLog(got.root)
      const fresh = !!log && deps.now() - Date.parse(log.at) < CHANGED_WINDOW_MS
      return formatWeChatMemory({
        doc: got.doc,
        whenLabel: state.lastRunIso ? spokenTime(Date.parse(state.lastRunIso), tz, deps.now()) : null,
        changes: fresh ? viewChanges(log!.ops) : [],
        failures: state.failures,
        today: localParts(deps.now(), tz).day,
      })
    },
    curatedView() {
      syncDiskSafely()
      const state = readNightlyState(deps.stateDir)
      const got = readDoc()
      if (!got) return { updated_at: null, when_label: null, mood: 'first', failures: state.failures, changes: [], sections: [] }
      const tz = deps.config().timezone
      const today = localParts(deps.now(), tz).day
      const log = lastLog(got.root)
      const fresh = !!log && deps.now() - Date.parse(log.at) < CHANGED_WINDOW_MS
      const changes: ViewChange[] = fresh ? viewChanges(log!.ops) : []
      const changed = new Set(fresh ? log!.ops.filter(o => o.kind === 'add' || o.kind === 'update').map(o => o.id) : [])
      const src = readSources(got.root)
      return {
        updated_at: state.lastRunIso,
        when_label: state.lastRunIso ? spokenTime(Date.parse(state.lastRunIso), tz, deps.now()) : null,
        mood: changes.length ? 'changed' : 'steady',
        failures: state.failures,
        changes,
        sections: DISPLAY_ORDER.filter(name => got.doc.sections[name].length).map(name => ({
          name,
          items: got.doc.sections[name].map((e): CuratedItem => {
            const due = parseDue(e.text.replace(/[\uff08]/, '(').replace(/[\uff09]/, ')'))
            return {
              id: e.id, text: e.text, display: stripDue(e.text), due,
              sources: (e.id ? src[e.id] ?? [] : []).map(r => ({ ts: r.ts, excerpt: r.excerpt, ...(r.kind ? { kind: r.kind } : {}) })),
              due_label: due ? dueLabel(due, today) : null,
              person: name === '身边的人' ? splitPerson(e.text) : null,
              changed: !!e.id && changed.has(e.id),
            }
          }),
        })),
      }
    },
  }
}

/**
 * 每晚记忆整理的运行时:15 分钟一次 tick(该跑就跑一次整理、再看看待发通知),
 * 「整理记忆」的立即运行,以及给微信(文本)与手机(结构)的只读视图。
 */
import { purgeCorrectedFromSources } from '../../lib/memory-corrections'
import { invalidateDerivedMemory } from '../../lib/memory-derived-state'
import { readSources, writeSources } from './sources'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_CAP_CHARS, MEMORY_FILENAME, SECTIONS, assignMissingIds, docChars, parseDue, parseMemoryDoc, serializeMemoryDoc, type Section } from './curated-doc'
import { DISPLAY_ORDER, dueLabel, formatWeChatMemory, splitPerson, spokenTime, stripDue, viewChanges, type ViewChange } from './memory-text'
import { CORRECTIONS_FILENAME, MEMORY_LOG_FILE, ownerMemoryRoot, readCorrections, readNightlyState, runMemoryNightly, writeNightlyState, type NightlyRunDeps } from './nightly'
import type { NightlyRunResult } from './nightly-notify'
import { MAX_ENTRY_CHARS, type AppliedOp } from './nightly-ops'
import { localParts, noticeTiming } from './nightly-schedule'
import { writeFileAtomic } from '../../lib/json-file'

export interface NoticeDeps {
  /** 这一种自己的节奏(companion/calibration shouldSpeak memory:冷却 / 无回复暂停 / care)。 */
  careGate(chatId: string, nowIso: string): { ok: true } | { ok: false; reason: string }
  claim(chatId: string, nowIso: string): void
  /** CC 主动开口唯一的门(第三批 3a):别烦我、免打扰、两条路都送不到由它判;往哪儿送(微信 / App)由它背后的 proactive-channel 定。 */
  speech: import('../speech/policy').SpeechPolicy
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
}
export interface ImportResult { added: number; skipped: { duplicate: number; corrected: number; invalid: number; cap: number } }
export type MemoryVerdict = 'wrong' | 'outdated' | 'delete'
const VERDICT_LINE: Record<MemoryVerdict, string> = {
  wrong: '主人说这条记错了,整理时不要再写回',
  outdated: '主人说这条已经过时,整理时不要再写回',
  delete: '主人说这条不用记,整理时不要再写回',
}

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

export function makeMemoryNightlyRuntime(deps: NightlyRunDeps & NoticeDeps): MemoryNightlyRuntime {
  const root = (): string | null => {
    const owner = deps.ownerChatId()
    return owner ? ownerMemoryRoot(deps.stateDir, owner) : null
  }
  const readDoc = () => {
    const r = root()
    const p = r ? join(r, MEMORY_FILENAME) : null
    return r && p && existsSync(p) ? { root: r, doc: parseMemoryDoc(readFileSync(p, 'utf8')) } : null
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
    runNow: () => serial(() => runMemoryNightly(deps, { force: true })),
    // 与每晚整理同一条串行链:不会和它同时改 memory.md
    correct: (id, verdict) => serial(async () => {
      const got = readDoc()
      if (!got) throw new Error('memory_not_found')
      let hit: { section: Section; text: string } | null = null
      for (const name of SECTIONS) {
        const i = got.doc.sections[name].findIndex(e => e.id === id)
        if (i >= 0) { hit = { section: name, text: got.doc.sections[name][i]!.text }; got.doc.sections[name].splice(i, 1); break }
      }
      if (!hit) throw new Error('memory_entry_not_found')
      const src = readSources(got.root)
      const nowMs = deps.now(), nowIso = new Date(nowMs).toISOString(), day = localParts(nowMs, deps.config().timezone).day
      const memPath = join(got.root, MEMORY_FILENAME)
      // 主人纠正 / 标过期 ⇒ 'retracted':旧总览里可能正好有这句,藏起来等重新生成(3e 记忆第 2 步)。
      invalidateDerivedMemory(got.root, 'retracted')
      writeFileAtomic(memPath, serializeMemoryDoc(got.doc, nowIso))
      // 清源头(3b (a)):CC 的笔记 / 偏好 / notes/ 里含这句的行也删掉,不然下次合成又学回来(主人以为 CC 忘了,其实只是暂时没说)。
      // 每个改动的文件先快照进 memory-archive,能找回;删了哪几个文件几行记在这一条底下,主人看得到。
      const owner = deps.ownerChatId()
      const purgeArchive = join(deps.stateDir, 'memory-archive', owner ?? 'unknown', 'corrections')
      let purged: Array<{ file: string; lines: number }> = []
      try { purged = purgeCorrectedFromSources(got.root, hit.text, purgeArchive, `${day}-${nowMs}`) }
      catch (err) { deps.log('MEMORY_NIGHTLY', `correction purge failed (memory.md already updated): ${err instanceof Error ? err.message : String(err)}`) }
      const purgeNote = purged.length ? `  (随之从 ${purged.map(p => `${p.file} 删了 ${p.lines} 行`).join('、')};原文件在 memory-archive/${owner ?? 'unknown'}/corrections/)\n` : ''
      // 改名成功后才记:失败了 memory.md 没动,也不留一行假的纠正
      appendFileSync(join(got.root, CORRECTIONS_FILENAME), `- ${day} ${VERDICT_LINE[verdict]}:[${hit.section}] ${hit.text}\n${purgeNote}`)
      if (src[id]) { delete src[id]; try { writeSources(got.root, src) } catch { /* 出处是附带的 */ } }
      if (verdict === 'outdated') {
        if (owner) {
          const archiveDir = join(deps.stateDir, 'memory-archive', owner)
          mkdirSync(archiveDir, { recursive: true })
          appendFileSync(join(archiveDir, 'memory-expired.md'), `- ${day} [${hit.section}] ${hit.text}(owner_outdated)\n`)
        }
      }
      deps.log('MEMORY_NIGHTLY', `owner ${verdict} ${id}`)
      return { text: hit.text }
    }),
    importEntries: (items, label) => serial(async (): Promise<ImportResult> => {
      const r = root()
      if (!r) throw new Error('no_owner')
      mkdirSync(r, { recursive: true })
      const memPath = join(r, MEMORY_FILENAME)
      const nowMs = deps.now(), nowIso = new Date(nowMs).toISOString(), day = localParts(nowMs, deps.config().timezone).day
      const doc = assignMissingIds(parseMemoryDoc(existsSync(memPath) ? readFileSync(memPath, 'utf8') : ''), deps.newId, day)
      const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
      const have = new Set(SECTIONS.flatMap(s => doc.sections[s].map(e => norm(e.text))))
      const rejected = readCorrections(r).texts
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
        invalidateDerivedMemory(r, 'added')  // 导入只加不删
        writeFileAtomic(memPath, serializeMemoryDoc(doc, nowIso))
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

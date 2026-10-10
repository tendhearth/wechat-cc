/**
 * 每晚记忆整理的运行时:15 分钟一次 tick(该跑就跑一次整理、再看看待发通知),
 * 「整理记忆」的立即运行,以及给微信(文本)与手机(结构)的只读视图。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_FILENAME, SECTIONS, parseDue, parseMemoryDoc, serializeMemoryDoc, type Section } from './curated-doc'
import { DISPLAY_ORDER, dueLabel, formatWeChatMemory, splitPerson, spokenTime, stripDue, viewChanges, type ViewChange } from './memory-text'
import { CORRECTIONS_FILENAME, MEMORY_LOG_FILE, ownerMemoryRoot, readNightlyState, runMemoryNightly, writeNightlyState, type NightlyRunDeps } from './nightly'
import type { NightlyRunResult } from './nightly-notify'
import type { AppliedOp } from './nightly-ops'
import { localParts, noticeTiming } from './nightly-schedule'

export interface NoticeDeps {
  careGate(chatId: string, nowIso: string): { ok: true } | { ok: false; reason: string }
  claim(chatId: string, nowIso: string): void
  wechatSuspended(): boolean
  send(chatId: string, text: string): Promise<{ error?: string }>
}
export interface CuratedItem {
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
}
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
  if (timing === 'wait' || deps.wechatSuspended()) return 'waiting'
  const nowIso = new Date(nowMs).toISOString()
  const gate = deps.careGate(owner, nowIso)
  if (!gate.ok) {
    if (gate.reason === 'memory_cooldown') return 'waiting'
    clear()
    deps.log('MEMORY_NIGHTLY', `notice dropped: ${gate.reason}`)
    return 'dropped'
  }
  deps.claim(owner, nowIso)   // 先登记再发:至多一次,不重试轰炸
  clear()
  const r = await deps.send(owner, pending.text)
  if (r.error) deps.log('MEMORY_NIGHTLY', `notice send failed (not retried): ${r.error}`)
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
      const nowMs = deps.now(), nowIso = new Date(nowMs).toISOString(), day = localParts(nowMs, deps.config().timezone).day
      const memPath = join(got.root, MEMORY_FILENAME), tmp = `${memPath}.tmp-${process.pid}`
      writeFileSync(tmp, serializeMemoryDoc(got.doc, nowIso))
      renameSync(tmp, memPath)
      // 改名成功后才记:失败了 memory.md 没动,也不留一行假的纠正
      appendFileSync(join(got.root, CORRECTIONS_FILENAME), `- ${day} ${VERDICT_LINE[verdict]}:[${hit.section}] ${hit.text}\n`)
      if (verdict === 'outdated') {
        const owner = deps.ownerChatId()
        if (owner) {
          const archiveDir = join(deps.stateDir, 'memory-archive', owner)
          mkdirSync(archiveDir, { recursive: true })
          appendFileSync(join(archiveDir, 'memory-expired.md'), `- ${day} [${hit.section}] ${hit.text}(owner_outdated)\n`)
        }
      }
      deps.log('MEMORY_NIGHTLY', `owner ${verdict} ${id}`)
      return { text: hit.text }
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

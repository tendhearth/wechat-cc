/**
 * 跑一次每晚记忆整理(spec 2026-09-25-memory-nightly-design §2)。
 * 素材 → 指纹(没新东西不调模型)→ 便宜模型出改动清单 → 程序校验执行 → 修订检查(主人正在改就作废)
 * → 备份旧版、原子写、追加日志、更新状态。任何失败都不写文件;同一天不再自动重试。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { MEMORY_FILENAME, assignMissingIds, parseMemoryDoc, serializeMemoryDoc } from './curated-doc'
import { applyNightly, parseOps } from './nightly-ops'
import { composeNotice, noticeItems, type NightlyRunResult } from './nightly-notify'
import { isDue, localParts } from './nightly-schedule'

export interface NightlySources {
  observationsSince(sinceIso: string | null): Promise<string[]>
  milestonesSince(sinceIso: string | null): Promise<string[]>
  messagesSince(sinceIso: string | null): Promise<string[]>
  projectMemory(): string
}
export interface NightlyConfig { enabled: boolean; at: string; timezone: string }
export interface NightlyState {
  lastRunDay: string | null
  lastRunIso: string | null
  fingerprint: string | null
  failures: number
  lastFailDay: string | null
  firstRunDone: boolean
  pendingNotice: { text: string; createdAtMs: number } | null
}
export interface NightlyRunDeps {
  stateDir: string
  ownerChatId: () => string | null
  config: () => NightlyConfig
  sources: NightlySources
  cheapEval: () => ((p: string) => Promise<string>) | null
  ownerRecentlyActive: () => Promise<boolean>
  now: () => number
  newId: () => string
  log: (tag: string, line: string) => void
}

export const MEMORY_LOG_FILE = 'memory-log.jsonl'
const STATE_FILE = 'memory-nightly.json'
const BLOCK_CAP = 6000
const EVAL_TIMEOUT_MS = 5 * 60_000
const DEFAULT_STATE: NightlyState = { lastRunDay: null, lastRunIso: null, fingerprint: null, failures: 0, lastFailDay: null, firstRunDone: false, pendingNotice: null }

export function readNightlyState(stateDir: string): NightlyState {
  try { return { ...DEFAULT_STATE, ...(readJsonFile<Partial<NightlyState>>(join(stateDir, 'companion', STATE_FILE))) } }
  catch { return { ...DEFAULT_STATE } }
}

export function writeNightlyState(stateDir: string, s: NightlyState): void {
  const dir = join(stateDir, 'companion')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${STATE_FILE}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, join(dir, STATE_FILE))
}

/** Only the fields a run owns. pendingNotice is deliberately absent — see mergeRunState. */
type RunOwnedFields = Partial<Pick<NightlyState, 'lastRunDay' | 'lastRunIso' | 'fingerprint' | 'failures' | 'lastFailDay' | 'firstRunDone'>>

/**
 * Re-read the state right before writing and merge only this run's fields.
 * A run spans a model call of up to minutes; meanwhile a delivery may have
 * cleared pendingNotice, or another run may have succeeded. Writing back the
 * snapshot read at the start would resurrect a sent notice or overwrite a
 * newer success. pendingNotice is written only when this run sets a new one.
 */
function mergeRunState(stateDir: string, fields: RunOwnedFields, newNotice?: NightlyState['pendingNotice']): void {
  const cur = readNightlyState(stateDir)
  writeNightlyState(stateDir, { ...cur, ...fields, ...(newNotice ? { pendingNotice: newNotice } : {}) })
}

export function ownerMemoryRoot(stateDir: string, owner: string): string | null {
  if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) return null
  return join(stateDir, 'memory', owner)
}

const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')

export const MATERIAL_BUDGET = 30_000
const CHAT_BLOCK = '这段时间的聊天'

/**
 * 素材有一个总预算(MATERIAL_BUDGET 字),按优先级往里装:profile → (首次)_overview → 聊天尾部
 * → 观察 → 里程碑 → agenda → knowledge → 本机 Claude 记忆 → notes(新改的在前)。每块仍各自封顶
 * BLOCK_CAP;预算不够时最后一块截到剩余额度(聊天留尾、其余留头),之后的块不再装。否则笔记一多,
 * 提示词无限长,便宜模型一拒就天天失败。
 */
export async function gatherMaterial(root: string, sources: NightlySources, sinceIso: string | null, firstRun: boolean): Promise<{ text: string; truncated: boolean }> {
  const blocks: Array<[string, string]> = [['CC 白天的草稿 profile.md', readIf(join(root, 'profile.md'))]]
  if (firstRun) blocks.push(['旧的整体理解 _overview.md', readIf(join(root, '_overview.md'))])
  // Chat keeps the TAIL (newest messages) — sinceIso only advances, so the
  // oldest text is the part a previous night's tidy already covered.
  blocks.push([CHAT_BLOCK, (await sources.messagesSince(sinceIso)).join('\n')])
  blocks.push(['观察', (await sources.observationsSince(sinceIso)).join('\n')])
  blocks.push(['里程碑', (await sources.milestonesSince(sinceIso)).join('\n')])
  blocks.push(['待办 agenda.md', readIf(join(root, 'agenda.md'))])
  blocks.push(['从聊天提炼的待办与联系人 knowledge.md', readIf(join(root, 'knowledge.md'))])
  blocks.push(['本机 Claude 记忆', sources.projectMemory()])
  const notes = join(root, 'notes')
  if (existsSync(notes)) {
    const files = readdirSync(notes).filter(f => f.endsWith('.md')).map(f => {
      let mtime = 0
      try { mtime = statSync(join(notes, f)).mtimeMs } catch { /* vanished mid-read */ }
      return { f, mtime }
    })
    files.sort((a, b) => b.mtime - a.mtime || a.f.localeCompare(b.f))
    for (const { f } of files) blocks.push([`笔记 notes/${f}`, readIf(join(notes, f))])
  }
  let left = MATERIAL_BUDGET
  let truncated = false
  const out: string[] = []
  for (const [k, v] of blocks) {
    if (!v.trim()) continue
    if (left <= 0) { truncated = true; break }
    const capped = k === CHAT_BLOCK ? v.slice(-BLOCK_CAP) : v.slice(0, BLOCK_CAP)
    const body = capped.length > left ? (k === CHAT_BLOCK ? capped.slice(-left) : capped.slice(0, left)) : capped
    if (body.length < capped.length) truncated = true
    left -= body.length
    out.push(`### ${k}\n${body}`)
  }
  return { text: out.join('\n\n'), truncated }
}

export function buildNightlyPrompt(a: { today: string; current: string; material: string }): string {
  return [
    `你在为主人整理一份长期记忆(今天是 ${a.today})。这份记忆每次对话都会被读,只留经得起时间的东西。`,
    '五栏:关于你(稳定事实)/ 偏好(做事方式、喜恶)/ 承诺(谁答应了谁什么;有期限就在正文写「(期限 YYYY-MM-DD)」)/ 身边的人(重要的人与关系)/ 近况(有时效的状态)。',
    '规则:',
    '- 只根据下面的素材改,不要编造;素材里主人说某条不对,就改掉或删掉它。',
    '- 仍然成立的条目放进 confirm;合并措辞、补充细节用 update 且 reversal=false;意思被推翻才 reversal=true。',
    '- 删除必须写原因;只有确定不再成立才删。',
    '- 单条不超过 200 字,全文不超过 3000 字;宁可合并,不要堆砌。',
    '只输出一个 JSON 对象,不要任何别的文字。四个键都必须出现,没有就给空数组:',
    '{"add":[{"section":"承诺","text":"…"}],"update":[{"id":"7f3a","text":"…","reversal":false}],"confirm":["91c2"],"remove":[{"id":"4d7c","reason":"…"}]}',
    '',
    '## 当前记忆(每条尾注里的 m:xxxx 是编号)',
    a.current,
    '',
    '## 新素材',
    a.material || '(无)',
  ].join('\n')
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export async function runMemoryNightly(deps: NightlyRunDeps, opts: { force: boolean }): Promise<NightlyRunResult> {
  const owner = deps.ownerChatId()
  const root = owner ? ownerMemoryRoot(deps.stateDir, owner) : null
  if (!owner || !root) return { status: 'skipped', reason: 'no_owner' }
  const cfg = deps.config()
  if (!opts.force && !cfg.enabled) return { status: 'skipped', reason: 'disabled' }
  const state = readNightlyState(deps.stateDir)
  const nowMs = deps.now()
  const { day } = localParts(nowMs, cfg.timezone)
  if (!opts.force) {
    if (!isDue({ nowMs, tz: cfg.timezone, at: cfg.at, lastRunDay: state.lastRunDay })) return { status: 'skipped', reason: 'not_due' }
    if (state.lastFailDay === day) return { status: 'skipped', reason: 'failed_today' }
    if (await deps.ownerRecentlyActive()) return { status: 'skipped', reason: 'owner_busy' }
  }

  mkdirSync(root, { recursive: true })
  const memPath = join(root, MEMORY_FILENAME)
  const firstRun = !existsSync(memPath)
  const currentText = readIf(memPath)
  const { text: material, truncated } = await gatherMaterial(root, deps.sources, state.lastRunIso, firstRun)
  if (truncated) deps.log('MEMORY_NIGHTLY', `material over budget (${MATERIAL_BUDGET} chars) — lower-priority blocks dropped/truncated`)
  const fingerprint = createHash('sha256').update(material).digest('hex')
  if (!firstRun && fingerprint === state.fingerprint) {
    mergeRunState(deps.stateDir, { lastRunDay: day })
    return { status: 'skipped', reason: 'no_new_material' }
  }

  const fail = (reason: string): NightlyRunResult => {
    const failures = readNightlyState(deps.stateDir).failures + 1
    mergeRunState(deps.stateDir, { failures, lastFailDay: day })
    deps.log('MEMORY_NIGHTLY', `failed (${reason}); ${failures} in a row`)
    if (failures >= 3) deps.log('MEMORY_NIGHTLY', `ALERT: ${failures} consecutive failures — memory.md may be stale`)
    return { status: 'failed', reason }
  }

  const evalFn = deps.cheapEval()
  if (!evalFn) return fail('no_cheap_eval')
  const doc = assignMissingIds(parseMemoryDoc(currentText), deps.newId, day)
  let raw: string
  try {
    raw = await withTimeout(evalFn(buildNightlyPrompt({ today: day, current: serializeMemoryDoc(doc, ''), material })), EVAL_TIMEOUT_MS)
  } catch (e) {
    return fail(`eval_error:${e instanceof Error ? e.message : String(e)}`)
  }
  const ops = parseOps(raw)
  if (!ops) return fail('bad_json')
  const res = applyNightly(doc, ops, { today: day, newId: deps.newId })
  if (!res.ok) return fail(res.reason)

  if (readIf(memPath) !== currentText) {
    deps.log('MEMORY_NIGHTLY', 'memory.md changed during the run — dropped, will retry')
    return { status: 'skipped', reason: 'owner_edited' }
  }
  const nowIso = new Date(nowMs).toISOString()
  const archiveDir = join(deps.stateDir, 'memory-archive', owner)
  // Write phase: backup copy, tmp write, rename, log append. Any fs error
  // here must go through fail() — an uncaught throw would skip lastFailDay
  // (⇒ the scheduler retries the model every tick, a forbidden retry storm)
  // and, if it happened after a partial write, could leave state stale.
  try {
    if (!firstRun) {
      const archivePath = join(archiveDir, `memory.md.${day}.md`)
      mkdirSync(archiveDir, { recursive: true })
      // Only the FIRST backup of a day is worth keeping — a later same-day
      // run (e.g. owner forces 整理记忆 after the 04:00 tidy already ran)
      // must not overwrite it with that later run's own (already-tidied)
      // pre-write content.
      if (!existsSync(archivePath)) copyFileSync(memPath, archivePath)
    }
    const tmp = `${memPath}.tmp-${process.pid}`
    writeFileSync(tmp, serializeMemoryDoc(res.doc, nowIso))
    renameSync(tmp, memPath)

    // Only append expired-entry lines AFTER the rename succeeded — otherwise
    // a failure further down (or on a later retry re-expiring the same
    // entries) would double-append them.
    const expired = res.applied.filter(a => a.kind === 'expire')
    if (expired.length) {
      mkdirSync(archiveDir, { recursive: true })
      appendFileSync(join(archiveDir, 'memory-expired.md'), expired.map(a => `- ${day} [${a.section}] ${a.text}(${a.kind === 'expire' ? a.reason : ''})`).join('\n') + '\n')
    }
    appendFileSync(join(root, MEMORY_LOG_FILE), JSON.stringify({ at: nowIso, ops: res.applied }) + '\n')
  } catch (e) {
    return fail(`write_error:${e instanceof Error ? e.message : String(e)}`)
  }

  const notice = composeNotice(noticeItems(res.applied), !state.firstRunDone)
  mergeRunState(deps.stateDir, {
    lastRunDay: day,
    lastRunIso: nowIso,
    fingerprint,
    failures: 0,
    lastFailDay: null,
    firstRunDone: true,
  }, !opts.force && notice ? { text: notice, createdAtMs: nowMs } : null)
  deps.log('MEMORY_NIGHTLY', `written: ${res.applied.length} change(s)`)
  return { status: 'written', applied: res.applied, notice }
}

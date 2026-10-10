/**
 * 跑一次每晚记忆整理(spec 2026-09-25-memory-nightly-design §2)。
 * 素材 → 指纹(没新东西不调模型)→ 便宜模型出改动清单 → 程序校验执行 → 修订检查(主人正在改就作废)
 * → 备份旧版、原子写、追加日志、更新状态。任何失败都不写文件;同一天不再自动重试。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { isNetworkUnprotectedError } from '../../lib/network-gate'
import { MEMORY_FILENAME, assignMissingIds, parseMemoryDoc, serializeMemoryDoc } from './curated-doc'
import { applyNightly, parseOps, type NightlyOps } from './nightly-ops'
import { composeNotice, noticeItems, type NightlyRunResult } from './nightly-notify'
import { isDue, localParts } from './nightly-schedule'
import { TODAY_DRAFT_FILENAME, consumeDraft } from './today-draft'

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

/**
 * 主人纠正过的条目(2026-10-10):「记错了 / 过时了 / 不用记」各记一行,只归 daemon 写(会话写会被拒)。
 * 原先追加在 profile.md 末尾:profile 一长就被素材截断砍掉、CC 整个重写 profile 也会把它抹掉 ⇒ 第二晚又被写回。
 * 现在单独一个文件,整理时放在素材最前面、不占预算;写回的逐字相同条目在代码里直接丢掉,不全靠模型听话。
 */
export const CORRECTIONS_FILENAME = 'corrections.md'
export const CORRECTIONS_BLOCK = '主人纠正过的条目 corrections.md(这些内容一律不要再 add 或 update 回记忆)'
const CORRECTIONS_CAP = 3000
const normalizeEntry = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** 纠正记录:给模型看的尾部(最新的在后,封顶)+ 全部纠正过的正文(代码里拦逐字写回)。 */
export function readCorrections(root: string): { block: string; texts: Set<string> } {
  const raw = readIf(join(root, CORRECTIONS_FILENAME))
  const texts = new Set<string>()
  for (const line of raw.split('\n')) {
    const m = /\] (.+)$/.exec(line)
    if (m) texts.add(normalizeEntry(m[1]!))
  }
  return { block: raw.trim().slice(-CORRECTIONS_CAP), texts }
}
/** 去掉模型写回的、主人纠正过的条目(逐字比较,空白归一)。 */
export function dropCorrected(ops: NightlyOps, texts: ReadonlySet<string>): NightlyOps {
  if (!texts.size) return ops
  return { ...ops, add: ops.add.filter(a => !texts.has(normalizeEntry(a.text))), update: ops.update.filter(u => !texts.has(normalizeEntry(u.text))) }
}

export const DRAFT_BLOCK = '今天的草稿 today-draft.md(白天 CC 刚记下的新情况,优先整理进来)'

/**
 * 整理读过草稿后,去掉读过的那几行(整理途中新记的留着)。草稿是辅助素材:清理失败只记日志,
 * 不让整次整理失败 —— 留着的行明晚再读一次而已。
 */
function consumeDraftFile(root: string, consumed: string, log: NightlyRunDeps['log']): void {
  if (!consumed.trim()) return
  const p = join(root, TODAY_DRAFT_FILENAME)
  try {
    const rest = consumeDraft(readIf(p), consumed)
    if (rest) {
      const tmp = `${p}.tmp-${process.pid}`
      writeFileSync(tmp, rest)
      renameSync(tmp, p)
    } else rmSync(p, { force: true })
  } catch (e) {
    log('MEMORY_NIGHTLY', `today-draft cleanup failed (kept for tomorrow): ${e instanceof Error ? e.message : String(e)}`)
  }
}

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
    '- 「主人纠正过的条目」里的内容,哪怕别的素材里还提到,也不要再写回记忆(不 add、不 update 成它)。',
    '- 仍然成立的条目放进 confirm;合并措辞、补充细节用 update 且 reversal=false;意思被推翻才 reversal=true。',
    '- 删除必须写原因;只有确定不再成立才删。',
    '- 每条只写一件事:一个人一条,一个偏好一条。',
    '- 欠别人的、别人欠主人的、约好的事放进「承诺」,有日期就在正文写「(期限 YYYY-MM-DD)」。',
    '- 当前记忆里一条写了好几件事时,把它拆开:用 update 把原条目改成其中一件(reversal=false),其余用 add。',
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
  const { text: rest, truncated } = await gatherMaterial(root, deps.sources, state.lastRunIso, firstRun)
  if (truncated) deps.log('MEMORY_NIGHTLY', `material over budget (${MATERIAL_BUDGET} chars) — lower-priority blocks dropped/truncated`)
  // 今天的草稿(同日失忆修复,2026-10-01):放最前面,不占素材预算(本身封顶 600 字)。它的每一行都
  // 来自 profile.md 的新增,profile 变了指纹自然会变 —— 所以指纹不算草稿,否则清掉草稿第二晚就会
  // 白白多调一次模型。
  const draft = readIf(join(root, TODAY_DRAFT_FILENAME))
  const corrections = readCorrections(root)
  const material = [
    corrections.block ? `### ${CORRECTIONS_BLOCK}\n${corrections.block}` : '',
    draft.trim() ? `### ${DRAFT_BLOCK}\n${draft.trim()}` : '',
    rest,
  ].filter(Boolean).join('\n\n')
  const fingerprint = createHash('sha256').update(rest).digest('hex')
  if (!firstRun && fingerprint === state.fingerprint) {
    mergeRunState(deps.stateDir, { lastRunDay: day })
    consumeDraftFile(root, draft, deps.log)
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
    // 守护 v2:评估要用的接口需要保护、此刻网络不安全 —— 不算失败、不记 failed_today,下一拍再看。
    if (isNetworkUnprotectedError(e)) {
      deps.log('MEMORY_NIGHTLY', 'skipped — the eval needs a protected provider and the network is unprotected')
      return { status: 'skipped', reason: 'network_unprotected' }
    }
    return fail(`eval_error:${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = parseOps(raw)
  if (!parsed) return fail('bad_json')
  const ops = dropCorrected(parsed, corrections.texts)
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

  consumeDraftFile(root, draft, deps.log)

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

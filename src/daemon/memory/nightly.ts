/**
 * 跑一次每晚记忆整理(spec 2026-09-25-memory-nightly-design §2)。
 * 素材 → 指纹(没新东西不调模型)→ 便宜模型出改动清单 → 程序校验执行 → 修订检查(主人正在改就作废)
 * → 备份旧版、原子写、追加日志、更新状态。任何失败都不写文件;同一天不再自动重试。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
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
  try { return { ...DEFAULT_STATE, ...(JSON.parse(readFileSync(join(stateDir, 'companion', STATE_FILE), 'utf8')) as Partial<NightlyState>) } }
  catch { return { ...DEFAULT_STATE } }
}

export function writeNightlyState(stateDir: string, s: NightlyState): void {
  const dir = join(stateDir, 'companion')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${STATE_FILE}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, join(dir, STATE_FILE))
}

export function ownerMemoryRoot(stateDir: string, owner: string): string | null {
  if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) return null
  return join(stateDir, 'memory', owner)
}

const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')

export async function gatherMaterial(root: string, sources: NightlySources, sinceIso: string | null, firstRun: boolean): Promise<string> {
  const blocks: Array<[string, string]> = [
    ['CC 白天的草稿 profile.md', readIf(join(root, 'profile.md'))],
    ['待办 agenda.md', readIf(join(root, 'agenda.md'))],
    ['从聊天提炼的待办与联系人 knowledge.md', readIf(join(root, 'knowledge.md'))],
  ]
  const notes = join(root, 'notes')
  if (existsSync(notes)) {
    for (const f of readdirSync(notes).filter(f => f.endsWith('.md')).sort()) blocks.push([`笔记 notes/${f}`, readIf(join(notes, f))])
  }
  if (firstRun) blocks.push(['旧的整体理解 _overview.md', readIf(join(root, '_overview.md'))])
  blocks.push(['观察', (await sources.observationsSince(sinceIso)).join('\n')])
  blocks.push(['里程碑', (await sources.milestonesSince(sinceIso)).join('\n')])
  blocks.push(['这段时间的聊天', (await sources.messagesSince(sinceIso)).join('\n')])
  blocks.push(['本机 Claude 记忆', sources.projectMemory()])
  return blocks.filter(([, v]) => v.trim()).map(([k, v]) => `### ${k}\n${v.slice(0, BLOCK_CAP)}`).join('\n\n')
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
  const material = await gatherMaterial(root, deps.sources, state.lastRunIso, firstRun)
  const fingerprint = createHash('sha256').update(material).digest('hex')
  if (!firstRun && fingerprint === state.fingerprint) {
    writeNightlyState(deps.stateDir, { ...state, lastRunDay: day })
    return { status: 'skipped', reason: 'no_new_material' }
  }

  const fail = (reason: string): NightlyRunResult => {
    const failures = state.failures + 1
    writeNightlyState(deps.stateDir, { ...state, failures, lastFailDay: day })
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
  if (!firstRun) {
    const archiveDir = join(deps.stateDir, 'memory-archive', owner)
    mkdirSync(archiveDir, { recursive: true })
    copyFileSync(memPath, join(archiveDir, `memory.md.${day}.md`))
  }
  const expired = res.applied.filter(a => a.kind === 'expire')
  if (expired.length) {
    const archiveDir = join(deps.stateDir, 'memory-archive', owner)
    mkdirSync(archiveDir, { recursive: true })
    appendFileSync(join(archiveDir, 'memory-expired.md'), expired.map(a => `- ${day} [${a.section}] ${a.text}(${a.kind === 'expire' ? a.reason : ''})`).join('\n') + '\n')
  }
  const tmp = `${memPath}.tmp-${process.pid}`
  writeFileSync(tmp, serializeMemoryDoc(res.doc, nowIso))
  renameSync(tmp, memPath)
  appendFileSync(join(root, MEMORY_LOG_FILE), JSON.stringify({ at: nowIso, ops: res.applied }) + '\n')

  const notice = composeNotice(noticeItems(res.applied), !state.firstRunDone)
  writeNightlyState(deps.stateDir, {
    ...state,
    lastRunDay: day,
    lastRunIso: nowIso,
    fingerprint,
    failures: 0,
    lastFailDay: null,
    firstRunDone: true,
    pendingNotice: !opts.force && notice ? { text: notice, createdAtMs: nowMs } : state.pendingNotice,
  })
  deps.log('MEMORY_NIGHTLY', `written: ${res.applied.length} change(s)`)
  return { status: 'written', applied: res.applied, notice }
}

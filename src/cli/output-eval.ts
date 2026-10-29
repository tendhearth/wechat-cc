/**
 * `wechat-cc eval run` / `eval diff` —— AI 输出回归评测的 CLI 一半(设计稿 docs/design/2026-10-29-output-eval.md)。
 *
 * 读 `<STATE_DIR>/eval/samples/*.json`,每条调一次 daemon 的 `POST /v1/eval/run`(operator 凭据,同 selftest),
 * 按硬规则判、要打分的再调同一条路由的 `{ kind: 'judge' }`(生产的便宜模型),结果写
 * `<STATE_DIR>/eval/runs/<时间>/report.json + report.md`,并和上一次比出「上次过、这次不过」。
 * 判法、报告样子都是纯规则(src/domain/output-eval.ts);这里只做 I/O。依赖注入,测试不碰真 daemon、真 STATE_DIR。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'
import { writeFileAtomic, writeJsonAtomic } from '../lib/json-file'
import {
  checkRule, diffRuns, effectiveRules, judgePrompt, parseJudgeAnswer, parseSample, renderReportMd, sampleStatus, summarize,
  type EvalOutput, type EvalSample, type RunDiff, type RunReport, type SampleResult,
} from '../domain/output-eval'

export const EVAL_EXIT = { ok: 0, failed: 1, noDaemon: 2 } as const

export interface EvalCliDeps {
  /** `<STATE_DIR>/eval`:samples/ 在里面,runs/ 写在里面。 */
  evalDir: string
  fetch: typeof globalThis.fetch
  readApiInfo: () => { baseUrl: string; token: string; operatorToken: string } | null
  now: () => number
  log: (line: string) => void
}

export interface EvalRunResult { report: RunReport; diff: RunDiff; dir: string }

/** daemon 侧轮次看门狗缺省 120s;客户端要比它晚放弃,好拿到可读的 ok:false 而不是一个断开的连接。 */
const TURN_DEFAULT_MS = 120_000
const FETCH_MARGIN_MS = 60_000
const JUDGE_TIMEOUT_MS = 60_000

const runsDir = (evalDir: string) => join(evalDir, 'runs')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface ApiResult { status: number; json: any }

async function post(deps: EvalCliDeps, api: { baseUrl: string; operatorToken: string }, body: unknown, timeoutMs: number): Promise<ApiResult> {
  try {
    const res = await deps.fetch(`${api.baseUrl}/v1/eval/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let json: any = null
    try { json = await res.json() } catch { /* 没有 body */ }
    return { status: res.status, json }
  } catch (err) {
    return { status: 0, json: { error: errMsg(err) } }
  }
}

const httpError = (r: ApiResult): string => {
  const parts = [`http_${r.status}`]
  if (typeof r.json?.error === 'string' && r.json.error) parts.push(r.json.error)
  if (typeof r.json?.detail === 'string' && r.json.detail) parts.push(r.json.detail)
  return parts.join(' ')
}

/** 健康探测用 file token(operator 令牌够不着 /v1/health)。 */
async function healthy(deps: EvalCliDeps, api: { baseUrl: string; token: string }): Promise<boolean> {
  try {
    const res = await deps.fetch(`${api.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${api.token}` }, signal: AbortSignal.timeout(10_000) })
    return res.ok
  } catch { return false }
}

type Loaded = { fileId: string; sample: EvalSample } | { fileId: string; error: string }

function loadSamples(evalDir: string): Loaded[] {
  const dir = join(evalDir, 'samples')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map((f): Loaded => {
    const fileId = f.slice(0, -'.json'.length)
    let raw: unknown
    try { raw = readJsonFile(join(dir, f)) } catch (e) { return { fileId, error: `样本文件读不了:${errMsg(e)}` } }
    const p = parseSample(raw, fileId)
    return p.ok ? { fileId, sample: p.sample } : { fileId, error: `样本写错了:${p.error}` }
  })
}

/** 给裁判看的「这一轮的输入」:回复 / 指称是那句话,早报是素材。 */
function judgeInput(s: EvalSample): string {
  if (s.kind === 'brief') return `每天早上的早报。素材:\n${JSON.stringify(s.input.material, null, 2)}`
  return String(s.input.text ?? '')
}

function judgeOutput(o: EvalOutput): string | null {
  if (o.kind === 'reference') return JSON.stringify(o.resolution)
  if (o.silent) return null
  return o.bubbles.length ? o.bubbles.join('\n\n') : o.finalText
}

function toOutput(kind: EvalSample['kind'], body: any): EvalOutput {
  if (kind === 'reference') return { kind: 'reference', resolution: body?.resolution ?? { kind: 'none' } }
  return { kind, finalText: String(body?.finalText ?? ''), bubbles: Array.isArray(body?.bubbles) ? body.bubbles.map(String) : [], silent: body?.silent === true }
}

async function runSample(deps: EvalCliDeps, api: { baseUrl: string; operatorToken: string }, s: EvalSample, providerId: string | undefined): Promise<SampleResult> {
  const startedAt = deps.now()
  const base = { id: s.id, kind: s.kind, ...(s.note !== undefined ? { note: s.note } : {}) }
  // kind 放在展开之后:样本 input 里写的 kind 不能把这一条换成别的操作(Codex 评审)
  const body = { ...s.input, kind: s.kind, ...(providerId && s.kind !== 'reference' ? { providerId } : {}) }
  const turnMs = typeof s.input.timeoutMs === 'number' ? s.input.timeoutMs : TURN_DEFAULT_MS
  const r = await post(deps, api, body, turnMs + FETCH_MARGIN_MS)
  const ran = typeof r.json?.providerId === 'string' ? { providerId: r.json.providerId as string } : {}
  const done = (x: Omit<SampleResult, 'id' | 'kind' | 'durationMs' | 'note' | 'status'>): SampleResult => ({
    ...base, ...ran, ...x,
    status: sampleStatus({ ...(x.error !== undefined ? { error: x.error } : {}), rules: x.rules, ...(x.judge ? { judge: x.judge.verdict } : {}) }),
    durationMs: deps.now() - startedAt,
  })
  if (r.status !== 200) return done({ rules: [], error: httpError(r) })
  if (r.json?.ok !== true) {
    const e = typeof r.json?.error === 'string' ? r.json.error : 'ok:false'
    return done({ rules: [], error: typeof r.json?.errorCode === 'string' ? `${e} (${r.json.errorCode})` : e, output: toOutput(s.kind, r.json) })
  }
  const output = toOutput(s.kind, r.json)
  const rules = effectiveRules(s).map(rule => checkRule(rule, output))
  if (!s.judge) return done({ rules, output })
  const j = await post(deps, api, { kind: 'judge', prompt: judgePrompt({ input: judgeInput(s), output: judgeOutput(output), criterion: s.judge }) }, JUDGE_TIMEOUT_MS)
  let judge: SampleResult['judge']
  if (j.status !== 200) judge = { criterion: s.judge, verdict: 'error', error: httpError(j) }
  else if (j.json?.ok !== true || typeof j.json.answer !== 'string') judge = { criterion: s.judge, verdict: 'error', error: String(j.json?.error ?? 'ok:false') }
  else judge = { criterion: s.judge, verdict: parseJudgeAnswer(j.json.answer), answer: j.json.answer.trim() }
  return done({ rules, output, judge })
}

/** `2026-10-29T04-00-01Z`:按字典序就是时间序;同一秒再跑一次加 `-2`。 */
function newRunId(evalDir: string, nowMs: number): string {
  const base = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
  let id = base
  for (let n = 2; existsSync(join(runsDir(evalDir), id)); n++) id = `${base}-${n}`
  return id
}

function readReport(evalDir: string, runId: string): RunReport | null {
  try { return readJsonFile<RunReport>(join(runsDir(evalDir), runId, 'report.json')) } catch { return null }
}

/** 读得出 report.json 的那些运行,老的在前。 */
export function listRuns(evalDir: string): string[] {
  if (!existsSync(runsDir(evalDir))) return []
  return readdirSync(runsDir(evalDir)).filter(id => existsSync(join(runsDir(evalDir), id, 'report.json'))).sort()
}

export async function runEval(deps: EvalCliDeps, opts: { only?: string[]; providerId?: string }): Promise<EvalRunResult> {
  const api = deps.readApiInfo()
  if (!api || !(await healthy(deps, api))) throw new Error('daemon_not_running')
  let loaded = loadSamples(deps.evalDir)
  if (opts.only?.length) {
    const want = new Set(opts.only)
    loaded = loaded.filter(l => want.has('sample' in l ? l.sample.id : l.fileId))
  }
  if (!loaded.length) throw new Error('no_samples')
  const startedAt = deps.now()
  const prevId = listRuns(deps.evalDir).at(-1)
  const results: SampleResult[] = []
  for (const l of loaded) {
    if ('error' in l) { results.push({ id: l.fileId, kind: 'reply', status: 'error', rules: [], error: l.error, durationMs: 0 }); continue }
    deps.log(`跑 ${l.sample.id}(${l.sample.kind})`)
    results.push(await runSample(deps, api, l.sample, opts.providerId))
  }
  const runId = newRunId(deps.evalDir, startedAt)
  const report: RunReport = {
    runId, startedAt: new Date(startedAt).toISOString(), durationMs: deps.now() - startedAt,
    ...(opts.providerId ? { providerId: opts.providerId } : {}),
    results, summary: summarize(results),
  }
  const diff = diffRuns(prevId ? readReport(deps.evalDir, prevId) : null, report)
  const dir = join(runsDir(deps.evalDir), runId)
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(join(dir, 'report.json'), report)
  writeFileAtomic(join(dir, 'report.md'), renderReportMd(report, diff))
  return { report, diff, dir }
}

/** `eval diff`:缺省比最近两次;给了就比那两次。找不到 ⇒ null。 */
export async function diffLatest(evalDir: string, a?: string, b?: string): Promise<RunDiff | null> {
  let from = a
  let to = b
  if (!from || !to) {
    const runs = listRuns(evalDir)
    if (runs.length < 2) return null
    from = runs[runs.length - 2]
    to = runs[runs.length - 1]
  }
  const prev = readReport(evalDir, from!)
  const cur = readReport(evalDir, to!)
  if (!prev || !cur) return null
  return diffRuns(prev, cur)
}

export function exitCodeFor(report: RunReport): number {
  return report.summary.pass === report.summary.total ? EVAL_EXIT.ok : EVAL_EXIT.failed
}

const MARK: Record<SampleResult['status'], string> = { pass: '✓', fail: '✗', error: '!' }

export function formatRunSummary(r: EvalRunResult): string {
  const lines = r.report.results.map(x => {
    const why = x.error ?? x.rules.find(y => !y.ok)?.rule ?? (x.judge?.verdict === 'fail' ? `裁判 0:${x.judge.criterion}` : '')
    const unclear = x.judge?.verdict === 'unclear' ? '(裁判拿不准)' : x.judge?.verdict === 'error' ? '(裁判没跑成)' : ''
    return `${MARK[x.status]} ${x.id}${why ? ` — ${why}` : ''}${unclear}`
  })
  const s = r.report.summary
  lines.push('', `${s.pass} 过 / ${s.fail} 不过 / ${s.error} 出错(共 ${s.total} 条)${s.judgeUnclear ? `;裁判拿不准 ${s.judgeUnclear} 条` : ''}${s.judgeError ? `;裁判没跑成 ${s.judgeError} 条` : ''}`)
  lines.push(formatDiff(r.diff))
  lines.push(`报告:${join(r.dir, 'report.md')}`)
  return lines.join('\n')
}

export function formatDiff(d: RunDiff): string {
  if (d.from === null) return '第一次跑,这次是基线。'
  const out = [`对比 ${d.from} → ${d.to}:回归 ${d.regressions.length}${d.regressions.length ? `(${d.regressions.join(', ')})` : ''}`]
  if (d.fixed.length) out.push(`修好 ${d.fixed.length}(${d.fixed.join(', ')})`)
  if (d.added.length) out.push(`新样本 ${d.added.length}(${d.added.join(', ')})`)
  if (d.missing.length) out.push(`这次没跑 ${d.missing.length}(${d.missing.join(', ')})`)
  return out.join('\n')
}

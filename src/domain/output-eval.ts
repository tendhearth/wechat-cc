/**
 * AI 输出回归评测的纯规则(设计稿 docs/design/2026-10-29-output-eval.md)。
 *
 * 被测的那一下在 daemon 里跑(features/output-eval,用生产的提示词 / 模型 / 便宜模型);这里只管跑完之后的事:
 *  - 样本文件长什么样、哪里写错了(parseSample);
 *  - 硬规则怎么判(checkRule;reply / brief 自动带 noThink);
 *  - 便宜模型打分的提示词与怎么读它的回答(judgePrompt / parseJudgeAnswer:单独一个 0 / 1 才算数,别的记 judge_unclear,
 *    不算过也不算不过);
 *  - 一条样本的结论、一次运行的汇总、两次运行比出「上次过、这次不过」(diffRuns),以及 report.md 的样子。
 * 纯函数、零 I/O:CLI(src/cli/output-eval.ts)读样本、调路由、写报告。
 */

export type EvalKind = 'reply' | 'brief' | 'reference'
export const EVAL_KINDS: readonly EvalKind[] = ['reply', 'brief', 'reference']

export type EvalRule =
  | { noThink: true }
  | { maxChars: number }
  | { maxBubbles: number }
  | { contains: string }
  | { notContains: string }
  | { matches: string }
  | { silent: boolean }
  | { lastLine: string }
  | { lines: [number, number] }
  | { resolves: { kind: string; taskId?: string; via?: string } }

export interface EvalSample {
  id: string
  kind: EvalKind
  /** 为什么收这条(只给人看)。 */
  note?: string
  /** 原样交给 daemon 的那一份(各类别的形状见设计稿「样本格式」;daemon 路由再核一遍)。 */
  input: Record<string, unknown>
  rules?: EvalRule[]
  /** 便宜模型按这句打 0 / 1;不写不打。 */
  judge?: string
}

/** daemon 跑完交回来、规则要看的那部分。 */
export type EvalOutput =
  | { kind: 'reply' | 'brief'; finalText: string; bubbles: string[]; silent: boolean }
  | { kind: 'reference'; resolution: { kind: string; taskId?: string; via?: string } }

export interface RuleResult { rule: string; ok: boolean; detail?: string }
export type JudgeVerdict = 'pass' | 'fail' | 'unclear' | 'error'
export type SampleStatus = 'pass' | 'fail' | 'error'

export interface SampleResult {
  id: string
  kind: EvalKind
  note?: string
  status: SampleStatus
  rules: RuleResult[]
  judge?: { criterion: string; verdict: JudgeVerdict; answer?: string; error?: string }
  output?: EvalOutput
  /** 跑不起来 / 跑出错(daemon 回的错、轮次超时、样本文件写错)。 */
  error?: string
  providerId?: string
  durationMs: number
}

export interface RunSummary { total: number; pass: number; fail: number; error: number; judgeUnclear: number }

export interface RunReport {
  runId: string
  startedAt: string
  durationMs: number
  providerId?: string
  results: SampleResult[]
  summary: RunSummary
}

export interface RunDiff {
  /** 上一次的 runId;没有上一次 ⇒ null(这次是基线)。 */
  from: string | null
  to: string
  /** 上一次过、这一次不过(不过或出错)。 */
  regressions: string[]
  /** 上一次不过、这一次过。 */
  fixed: string[]
  /** 这一次有、上一次没有。 */
  added: string[]
  /** 上一次有、这一次没有。 */
  missing: string[]
}

// ─── 样本 ─────────────────────────────────────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function parseRule(raw: unknown, n: number): Parsed<EvalRule> {
  const bad: Parsed<EvalRule> = { ok: false, error: `第 ${n} 条规则不认得:${JSON.stringify(raw)}` }
  if (!isObj(raw)) return bad
  const keys = Object.keys(raw)
  if (keys.length !== 1) return bad
  const k = keys[0]!
  const v = raw[k]
  switch (k) {
    case 'noThink': return v === true ? { ok: true, value: { noThink: true } } : bad
    case 'maxChars': return isCount(v) ? { ok: true, value: { maxChars: v } } : bad
    case 'maxBubbles': return isCount(v) ? { ok: true, value: { maxBubbles: v } } : bad
    case 'contains': return isNonEmptyStr(v) ? { ok: true, value: { contains: v } } : bad
    case 'notContains': return isNonEmptyStr(v) ? { ok: true, value: { notContains: v } } : bad
    case 'lastLine': return isNonEmptyStr(v) ? { ok: true, value: { lastLine: v } } : bad
    case 'silent': return typeof v === 'boolean' ? { ok: true, value: { silent: v } } : bad
    case 'matches': {
      if (!isNonEmptyStr(v)) return bad
      try { new RegExp(v) } catch (e) { return { ok: false, error: `第 ${n} 条规则的正则不合法:${e instanceof Error ? e.message : String(e)}` } }
      return { ok: true, value: { matches: v } }
    }
    case 'lines': {
      if (!Array.isArray(v) || v.length !== 2 || !isCount(v[0]) || !isCount(v[1]) || v[0] > v[1]) return bad
      return { ok: true, value: { lines: [v[0], v[1]] } }
    }
    case 'resolves': {
      if (!isObj(v) || !isNonEmptyStr(v.kind)) return bad
      if (v.taskId !== undefined && !isNonEmptyStr(v.taskId)) return bad
      if (v.via !== undefined && !isNonEmptyStr(v.via)) return bad
      return { ok: true, value: { resolves: { kind: v.kind, ...(v.taskId !== undefined ? { taskId: v.taskId as string } : {}), ...(v.via !== undefined ? { via: v.via as string } : {}) } } }
    }
    default: return bad
  }
}

function inputError(kind: EvalKind, input: Record<string, unknown>): string | null {
  if (kind === 'reply') {
    if (!isNonEmptyStr(input.text)) return 'reply 的 input.text 要是非空字符串'
    if (input.tier !== undefined && input.tier !== 'admin' && input.tier !== 'trusted') return 'reply 的 input.tier 只能是 admin / trusted'
    return null
  }
  if (kind === 'brief') {
    if (!isObj(input.material)) return 'brief 的 input.material 要是对象'
    if (input.asks !== undefined && !Array.isArray(input.asks)) return 'brief 的 input.asks 要是数组'
    return null
  }
  if (!isNonEmptyStr(input.text)) return 'reference 的 input.text 要是非空字符串'
  if (!Array.isArray(input.candidates)) return 'reference 的 input.candidates 要是数组'
  return null
}

/** 读一条样本(文件内容已 JSON.parse)。`fileId` 是去掉 .json 的文件名,id 缺省用它。 */
export function parseSample(raw: unknown, fileId: string): { ok: true; sample: EvalSample } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: '样本要是一个 JSON 对象' }
  const id = raw.id === undefined ? fileId : raw.id
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return { ok: false, error: 'id 只能是字母、数字、- 和 _' }
  if (typeof raw.kind !== 'string' || !(EVAL_KINDS as readonly string[]).includes(raw.kind)) return { ok: false, error: 'kind 只能是 reply / brief / reference' }
  const kind = raw.kind as EvalKind
  if (!isObj(raw.input)) return { ok: false, error: 'input 要是对象' }
  const ie = inputError(kind, raw.input)
  if (ie) return { ok: false, error: ie }
  if (raw.note !== undefined && typeof raw.note !== 'string') return { ok: false, error: 'note 要是字符串' }
  if (raw.judge !== undefined && !isNonEmptyStr(raw.judge)) return { ok: false, error: 'judge 要是非空字符串' }
  let rules: EvalRule[] | undefined
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) return { ok: false, error: 'rules 要是数组' }
    rules = []
    for (let i = 0; i < raw.rules.length; i++) {
      const r = parseRule(raw.rules[i], i + 1)
      if (!r.ok) return r
      rules.push(r.value)
    }
  }
  return {
    ok: true,
    sample: {
      id, kind, input: raw.input,
      ...(raw.note !== undefined ? { note: raw.note as string } : {}),
      ...(rules ? { rules } : {}),
      ...(raw.judge !== undefined ? { judge: raw.judge as string } : {}),
    },
  }
}

/** 这条样本实际要判的规则:reply / brief 自动带 noThink(写过就不重复),放在最前面。 */
export function effectiveRules(s: EvalSample): EvalRule[] {
  const rules = s.rules ?? []
  if (s.kind === 'reference' || rules.some(r => 'noThink' in r)) return [...rules]
  return [{ noThink: true }, ...rules]
}

// ─── 硬规则 ───────────────────────────────────────────────────────────────

const THINK_TAG = /<\/?think>/i
const THINK_LEAD = /^\s*思考过程/

function ruleLabel(r: EvalRule): string {
  if ('noThink' in r) return 'noThink'
  if ('maxChars' in r) return `maxChars ${r.maxChars}`
  if ('maxBubbles' in r) return `maxBubbles ${r.maxBubbles}`
  if ('contains' in r) return `contains 「${r.contains}」`
  if ('notContains' in r) return `notContains 「${r.notContains}」`
  if ('matches' in r) return `matches /${r.matches}/`
  if ('silent' in r) return `silent ${r.silent}`
  if ('lastLine' in r) return `lastLine 「${r.lastLine}」`
  if ('lines' in r) return `lines ${r.lines[0]}–${r.lines[1]}`
  return `resolves ${r.resolves.kind}${r.resolves.taskId ? ` ${r.resolves.taskId}` : ''}${r.resolves.via ? ` via ${r.resolves.via}` : ''}`
}

const nonEmptyLines = (t: string): string[] => t.split('\n').map(l => l.trim()).filter(l => l !== '')

export function checkRule(r: EvalRule, out: EvalOutput): RuleResult {
  const rule = ruleLabel(r)
  if ('resolves' in r) {
    if (out.kind !== 'reference') return { rule, ok: false, detail: '这条规则只用于 reference' }
    const got = out.resolution
    const ok = got.kind === r.resolves.kind
      && (r.resolves.taskId === undefined || got.taskId === r.resolves.taskId)
      && (r.resolves.via === undefined || got.via === r.resolves.via)
    return { rule, ok, detail: `得到 ${got.kind}${got.taskId ? ` ${got.taskId}` : ''}${got.via ? ` via ${got.via}` : ''}` }
  }
  if (out.kind === 'reference') return { rule, ok: false, detail: '这条规则只用于 reply / brief' }
  const t = out.finalText
  if ('noThink' in r) {
    const hit = THINK_TAG.test(t) || THINK_LEAD.test(t)
    return hit ? { rule, ok: false, detail: '最终文字里有思维链' } : { rule, ok: true }
  }
  if ('maxChars' in r) { const n = [...t].length; return { rule, ok: n <= r.maxChars, detail: `${n} 字` } }
  if ('maxBubbles' in r) { const n = out.bubbles.length; return { rule, ok: n <= r.maxBubbles, detail: `${n} 条` } }
  if ('contains' in r) return { rule, ok: t.includes(r.contains) }
  if ('notContains' in r) return { rule, ok: !t.includes(r.notContains) }
  if ('matches' in r) return { rule, ok: new RegExp(r.matches).test(t) }
  if ('silent' in r) return { rule, ok: out.silent === r.silent, detail: out.silent ? '静默(NO_REPLY)' : '有回复' }
  if ('lastLine' in r) {
    const lines = nonEmptyLines(t)
    const last = lines[lines.length - 1] ?? ''
    return { rule, ok: last === r.lastLine.trim(), detail: `最后一行「${last}」` }
  }
  const n = nonEmptyLines(t).length
  return { rule, ok: n >= r.lines[0] && n <= r.lines[1], detail: `${n} 行` }
}

// ─── 便宜模型打分 ─────────────────────────────────────────────────────────

/** 固定的评分提示词。output 为 null ⇒ 模型这一轮选择了静默。 */
export function judgePrompt(o: { input: string; output: string | null; criterion: string }): string {
  return [
    '你在核对一个 AI 助手这一轮的输出符不符合一条标准。只看这条标准,不评别的。',
    '符合回 1,不符合回 0。只回一个数字,不要解释。',
    '',
    `标准:${o.criterion}`,
    '',
    '这一轮的输入:',
    `<input>\n${o.input}\n</input>`,
    '',
    '助手的输出:',
    `<output>\n${o.output ?? '(没有回复:模型选择了 NO_REPLY)'}\n</output>`,
    '',
    '数字:',
  ].join('\n')
}

/** 单独一个数字、且是 0 或 1 才算数(同 makeCheapJudge 的读法);别的一律 unclear。 */
export function parseJudgeAnswer(answer: string): 'pass' | 'fail' | 'unclear' {
  const numbers = answer.match(/\d+/g) ?? []
  if (numbers.length !== 1) return 'unclear'
  if (numbers[0] === '1') return 'pass'
  if (numbers[0] === '0') return 'fail'
  return 'unclear'
}

// ─── 结论 / 汇总 / 比较 ───────────────────────────────────────────────────

/** 跑出错 ⇒ error;任何一条硬规则不过,或裁判回 0 ⇒ fail;裁判 unclear / 出错 不算过也不算不过。 */
export function sampleStatus(o: { error?: string; rules: RuleResult[]; judge?: JudgeVerdict }): SampleStatus {
  if (o.error !== undefined) return 'error'
  if (o.rules.some(r => !r.ok)) return 'fail'
  if (o.judge === 'fail') return 'fail'
  return 'pass'
}

export function summarize(results: readonly SampleResult[]): RunSummary {
  return {
    total: results.length,
    pass: results.filter(r => r.status === 'pass').length,
    fail: results.filter(r => r.status === 'fail').length,
    error: results.filter(r => r.status === 'error').length,
    judgeUnclear: results.filter(r => r.judge?.verdict === 'unclear').length,
  }
}

/** 「回归」= 上一次过、这一次不过;没有上一次 ⇒ 这次是基线,全部算新样本。 */
export function diffRuns(prev: RunReport | null, cur: RunReport): RunDiff {
  const before = new Map((prev?.results ?? []).map(r => [r.id, r.status]))
  const now = new Set(cur.results.map(r => r.id))
  const regressions: string[] = []
  const fixed: string[] = []
  const added: string[] = []
  for (const r of cur.results) {
    const was = before.get(r.id)
    if (was === undefined) added.push(r.id)
    else if (was === 'pass' && r.status !== 'pass') regressions.push(r.id)
    else if (was !== 'pass' && r.status === 'pass') fixed.push(r.id)
  }
  const missing = (prev?.results ?? []).map(r => r.id).filter(id => !now.has(id))
  return { from: prev?.runId ?? null, to: cur.runId, regressions, fixed, added, missing }
}

// ─── report.md ────────────────────────────────────────────────────────────

const FENCE = '````'

function outputText(o: EvalOutput | undefined): string | null {
  if (!o) return null
  if (o.kind === 'reference') return JSON.stringify(o.resolution)
  if (o.silent) return '(NO_REPLY)'
  return o.bubbles.length > 1 ? o.bubbles.join('\n\n—— 下一条 ——\n\n') : o.finalText
}

const STATUS_WORD: Record<SampleStatus, string> = { pass: '过', fail: '不过', error: '出错' }

export function renderReportMd(report: RunReport, diff: RunDiff): string {
  const s = report.summary
  const out: string[] = [
    `# 输出评测 ${report.runId}`,
    '',
    `开始于 ${report.startedAt} · 用时 ${Math.round(report.durationMs / 1000)}s${report.providerId ? ` · 执行者 ${report.providerId}` : ''}`,
    '',
    `${s.pass} 过 / ${s.fail} 不过 / ${s.error} 出错(共 ${s.total} 条)`,
    '',
  ]
  if (diff.from === null) {
    out.push('第一次跑,这次是基线(没有可比的上一次)。', '')
  } else {
    out.push(`## 回归(上次过、这次不过):${diff.regressions.length}`, '', `对比 ${diff.from}。`, '')
    for (const id of diff.regressions) out.push(`- ${id}`)
    if (diff.regressions.length) out.push('')
    if (diff.fixed.length) out.push(`## 修好的(上次不过、这次过):${diff.fixed.length}`, '', ...diff.fixed.map(id => `- ${id}`), '')
    if (diff.added.length) out.push(`## 新样本:${diff.added.length}`, '', ...diff.added.map(id => `- ${id}`), '')
    if (diff.missing.length) out.push(`## 这次没跑的(上次有):${diff.missing.length}`, '', ...diff.missing.map(id => `- ${id}`), '')
  }
  const bad = report.results.filter(r => r.status !== 'pass')
  if (bad.length) {
    out.push(`## 不过 / 出错:${bad.length}`, '')
    for (const r of bad) {
      out.push(`### ${r.id} — ${STATUS_WORD[r.status]}(${r.kind}${r.providerId ? ` · ${r.providerId}` : ''})`, '')
      if (r.note) out.push(`> ${r.note}`, '')
      if (r.error) out.push(`出错:${r.error}`, '')
      for (const x of r.rules) out.push(`- ${x.ok ? '✓' : '✗'} ${x.rule}${x.detail ? ` — ${x.detail}` : ''}`)
      if (r.judge) out.push(`- 裁判 ${r.judge.verdict}:${r.judge.criterion}${r.judge.answer !== undefined ? ` — 「${r.judge.answer}」` : ''}${r.judge.error ? ` — ${r.judge.error}` : ''}`)
      const text = outputText(r.output)
      if (text !== null) out.push('', FENCE, text, FENCE)
      out.push('')
    }
  }
  const unclear = report.results.filter(r => r.judge?.verdict === 'unclear')
  if (unclear.length) {
    out.push(`## 裁判拿不准(judge_unclear):${unclear.length}`, '', '不算过也不算不过;去看原文。', '')
    for (const r of unclear) out.push(`- ${r.id} — 「${r.judge!.answer ?? ''}」`)
    out.push('')
  }
  return out.join('\n')
}

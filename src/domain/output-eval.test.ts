import { describe, it, expect } from 'vitest'
import {
  parseSample, effectiveRules, checkRule, judgePrompt, parseJudgeAnswer, sampleStatus, diffRuns, renderReportMd, summarize,
  type EvalOutput, type EvalSample, type RunReport, type SampleResult,
} from './output-eval'

const reply = (o: Partial<Extract<EvalOutput, { kind: 'reply' | 'brief' }>> = {}): EvalOutput => ({
  kind: 'reply', finalText: '早,今天想先做哪件?', bubbles: ['早,今天想先做哪件?'], silent: false, ...o,
})

describe('parseSample', () => {
  it('reply:收下合法的一条', () => {
    const r = parseSample({ id: 'a', kind: 'reply', input: { text: '早' }, rules: [{ maxChars: 40 }], judge: '像熟人' }, 'a')
    expect(r).toEqual({ ok: true, sample: { id: 'a', kind: 'reply', input: { text: '早' }, rules: [{ maxChars: 40 }], judge: '像熟人' } })
  })
  it('id 缺省用文件名;id 和文件名都得是安全的名字', () => {
    expect(parseSample({ kind: 'reply', input: { text: '早' } }, 'from-file')).toMatchObject({ ok: true, sample: { id: 'from-file' } })
    expect(parseSample({ id: '../x', kind: 'reply', input: { text: '早' } }, 'f')).toEqual({ ok: false, error: 'id 只能是字母、数字、- 和 _' })
    // 回归比较按 id 对:两份文件写了同一个 id,上一次的结果会被合成一条、回归丢掉(Codex 评审)。id 跟文件名走 ⇒ 天然不重
    expect(parseSample({ id: 'a', kind: 'reply', input: { text: '早' } }, 'a-copy')).toEqual({ ok: false, error: 'id 要和文件名一致(a-copy)' })
  })
  it('kind 不认得、input 不对 ⇒ 拒并说明', () => {
    expect(parseSample({ id: 'a', kind: 'chat', input: {} }, 'a')).toEqual({ ok: false, error: 'kind 只能是 reply / brief / reference' })
    expect(parseSample({ id: 'a', kind: 'reply', input: {} }, 'a')).toEqual({ ok: false, error: 'reply 的 input.text 要是非空字符串' })
    expect(parseSample({ id: 'a', kind: 'reply', input: { text: '早', tier: 'guest' } }, 'a')).toEqual({ ok: false, error: 'reply 的 input.tier 只能是 admin / trusted' })
    expect(parseSample({ id: 'a', kind: 'brief', input: {} }, 'a')).toEqual({ ok: false, error: 'brief 的 input.material 要是对象' })
    expect(parseSample({ id: 'a', kind: 'reference', input: { text: 'x' } }, 'a')).toEqual({ ok: false, error: 'reference 的 input.candidates 要是数组' })
  })
  it('规则:不认得的键、坏正则、lines 不是 [min,max] ⇒ 拒', () => {
    expect(parseSample({ id: 'a', kind: 'reply', input: { text: '早' }, rules: [{ wat: 1 }] }, 'a')).toEqual({ ok: false, error: '第 1 条规则不认得:{"wat":1}' })
    expect(parseSample({ id: 'a', kind: 'reply', input: { text: '早' }, rules: [{ matches: '(' }] }, 'a')).toMatchObject({ ok: false, error: expect.stringContaining('第 1 条规则的正则不合法') })
    expect(parseSample({ id: 'a', kind: 'brief', input: { material: {} }, rules: [{ lines: [5, 3] }] }, 'a')).toEqual({ ok: false, error: '第 1 条规则不认得:{"lines":[5,3]}' })
  })
  it('judge 只能是非空字符串', () => {
    expect(parseSample({ id: 'a', kind: 'reply', input: { text: '早' }, judge: '' }, 'a')).toEqual({ ok: false, error: 'judge 要是非空字符串' })
  })
})

describe('effectiveRules:reply / brief 自动带 noThink', () => {
  it('reply 自动加,reference 不加,写过的不重复', () => {
    const s = (kind: EvalSample['kind'], rules: EvalSample['rules']): EvalSample => ({ id: 'x', kind, input: {}, rules })
    expect(effectiveRules(s('reply', [{ maxChars: 5 }]))).toEqual([{ noThink: true }, { maxChars: 5 }])
    expect(effectiveRules(s('brief', []))).toEqual([{ noThink: true }])
    expect(effectiveRules(s('reply', [{ noThink: true }]))).toEqual([{ noThink: true }])
    expect(effectiveRules(s('reference', [{ resolves: { kind: 'none' } }]))).toEqual([{ resolves: { kind: 'none' } }])
  })
})

describe('checkRule', () => {
  it('noThink:<think> / </think> / 「思考过程」开头 都算不过', () => {
    expect(checkRule({ noThink: true }, reply()).ok).toBe(true)
    expect(checkRule({ noThink: true }, reply({ finalText: '<think>嗯</think>早' })).ok).toBe(false)
    expect(checkRule({ noThink: true }, reply({ finalText: '好的</think>早' })).ok).toBe(false)
    expect(checkRule({ noThink: true }, reply({ finalText: '  思考过程:先想想\n早' })).ok).toBe(false)
    expect(checkRule({ noThink: true }, reply({ finalText: '我的思考过程是这样的' })).ok).toBe(true)
  })
  it('maxChars 按字符数(不是字节)', () => {
    expect(checkRule({ maxChars: 3 }, reply({ finalText: '早上好' }))).toEqual({ rule: 'maxChars 3', ok: true, detail: '3 字' })
    expect(checkRule({ maxChars: 2 }, reply({ finalText: '早上好' }))).toEqual({ rule: 'maxChars 2', ok: false, detail: '3 字' })
  })
  it('maxBubbles', () => {
    expect(checkRule({ maxBubbles: 1 }, reply({ bubbles: ['a', 'b'] }))).toEqual({ rule: 'maxBubbles 1', ok: false, detail: '2 条' })
  })
  it('contains / notContains / matches', () => {
    expect(checkRule({ contains: '早' }, reply()).ok).toBe(true)
    expect(checkRule({ contains: '晚' }, reply()).ok).toBe(false)
    expect(checkRule({ notContains: '作为AI' }, reply()).ok).toBe(true)
    expect(checkRule({ notContains: '早' }, reply()).ok).toBe(false)
    expect(checkRule({ matches: '^早' }, reply()).ok).toBe(true)
    expect(checkRule({ matches: '^晚' }, reply()).ok).toBe(false)
  })
  it('silent', () => {
    expect(checkRule({ silent: true }, reply({ silent: true, finalText: '', bubbles: [] })).ok).toBe(true)
    expect(checkRule({ silent: false }, reply({ silent: true, finalText: '', bubbles: [] })).ok).toBe(false)
  })
  it('lastLine:最后一个非空行(去首尾空白)相等', () => {
    expect(checkRule({ lastLine: '就这些。' }, reply({ finalText: '1. a\n2. b\n就这些。\n' })).ok).toBe(true)
    expect(checkRule({ lastLine: '就这些。' }, reply({ finalText: '就这些。\n还有一件' })).ok).toBe(false)
  })
  it('lines:非空行数在 [min, max] 里', () => {
    expect(checkRule({ lines: [2, 3] }, reply({ finalText: 'a\n\nb\nc' }))).toEqual({ rule: 'lines 2–3', ok: true, detail: '3 行' })
    expect(checkRule({ lines: [4, 5] }, reply({ finalText: 'a\nb' })).ok).toBe(false)
  })
  it('resolves:kind 必比,taskId / via 写了才比', () => {
    const out: EvalOutput = { kind: 'reference', resolution: { kind: 'task', taskId: 'abcd1234', via: 'judge' } }
    expect(checkRule({ resolves: { kind: 'task' } }, out).ok).toBe(true)
    expect(checkRule({ resolves: { kind: 'task', taskId: 'abcd1234', via: 'judge' } }, out).ok).toBe(true)
    expect(checkRule({ resolves: { kind: 'task', taskId: 'ffff0000' } }, out).ok).toBe(false)
    expect(checkRule({ resolves: { kind: 'task', via: 'name' } }, out).ok).toBe(false)
    expect(checkRule({ resolves: { kind: 'none' } }, out).ok).toBe(false)
  })
  it('文字规则用在指称样本上 / 指称规则用在回复上 ⇒ 不过并说明', () => {
    expect(checkRule({ maxChars: 3 }, { kind: 'reference', resolution: { kind: 'none' } })).toEqual({ rule: 'maxChars 3', ok: false, detail: '这条规则只用于 reply / brief' })
    expect(checkRule({ resolves: { kind: 'none' } }, reply())).toEqual({ rule: 'resolves none', ok: false, detail: '这条规则只用于 reference' })
  })
})

describe('judge', () => {
  it('提示词带上输入、输出、标准,并要求只回一个数字', () => {
    const p = judgePrompt({ input: '早', output: '早,今天想先做哪件?', criterion: '像熟人打招呼' })
    expect(p).toContain('像熟人打招呼')
    expect(p).toContain('早,今天想先做哪件?')
    expect(p).toContain('<input>\n早\n</input>')
    expect(p).toMatch(/只回一个数字/)
  })
  it('静默的输出写成一句说明,不是空的', () => {
    expect(judgePrompt({ input: '早', output: null, criterion: 'c' })).toContain('(没有回复:模型选择了 NO_REPLY)')
  })
  it('parseJudgeAnswer:单独一个 0 / 1 才算数,其余 unclear', () => {
    expect(parseJudgeAnswer('1')).toBe('pass')
    expect(parseJudgeAnswer(' 0。\n')).toBe('fail')
    expect(parseJudgeAnswer('答案:1')).toBe('pass')
    expect(parseJudgeAnswer('1 或 0')).toBe('unclear')
    expect(parseJudgeAnswer('2')).toBe('unclear')
    expect(parseJudgeAnswer('')).toBe('unclear')
    expect(parseJudgeAnswer('符合')).toBe('unclear')
  })
})

describe('sampleStatus', () => {
  const ok = { rule: 'r', ok: true }
  const bad = { rule: 'r', ok: false }
  it('跑出错 ⇒ error;规则有不过 ⇒ fail;裁判 0 ⇒ fail;裁判 unclear / 出错 不算过也不算不过', () => {
    expect(sampleStatus({ error: 'boom', rules: [ok] })).toBe('error')
    expect(sampleStatus({ rules: [ok, bad] })).toBe('fail')
    expect(sampleStatus({ rules: [ok], judge: 'fail' })).toBe('fail')
    expect(sampleStatus({ rules: [ok], judge: 'unclear' })).toBe('pass')
    expect(sampleStatus({ rules: [ok], judge: 'error' })).toBe('pass')
    expect(sampleStatus({ rules: [ok], judge: 'pass' })).toBe('pass')
    expect(sampleStatus({ rules: [] })).toBe('pass')
  })
})

const result = (id: string, status: SampleResult['status'], extra: Partial<SampleResult> = {}): SampleResult => ({ id, kind: 'reply', status, rules: [], durationMs: 10, ...extra })
const run = (runId: string, results: SampleResult[]): RunReport => ({ runId, startedAt: '2026-10-29T00:00:00.000Z', durationMs: 100, results, summary: summarize(results) })

describe('summarize', () => {
  it('数 pass / fail / error,judge unclear 单列', () => {
    expect(summarize([result('a', 'pass', { judge: { criterion: 'c', verdict: 'unclear', answer: '嗯' } }), result('b', 'fail'), result('c', 'error')]))
      .toEqual({ total: 3, pass: 1, fail: 1, error: 1, judgeUnclear: 1, judgeError: 0 })
  })
})

describe('diffRuns:上次过、这次不过 = 回归', () => {
  it('分出 回归 / 修好 / 新样本 / 少了的', () => {
    const prev = run('r1', [result('a', 'pass'), result('b', 'fail'), result('c', 'pass'), result('gone', 'pass')])
    const cur = run('r2', [result('a', 'fail'), result('b', 'pass'), result('c', 'error'), result('new', 'fail')])
    expect(diffRuns(prev, cur)).toEqual({ from: 'r1', to: 'r2', regressions: ['a', 'c'], fixed: ['b'], added: ['new'], missing: ['gone'] })
  })
  it('没有上一次 ⇒ 只出基线(没有回归)', () => {
    expect(diffRuns(null, run('r1', [result('a', 'fail')]))).toEqual({ from: null, to: 'r1', regressions: [], fixed: [], added: ['a'], missing: [] })
  })
})

describe('renderReportMd', () => {
  it('写清总数、回归、每条不过的原因和原文;judge unclear 单列', () => {
    const cur = run('r2', [
      result('a', 'fail', { note: '早上一句', rules: [{ rule: 'maxChars 3', ok: false, detail: '9 字' }], output: reply({ finalText: '早早早早早早早早早' }) }),
      result('b', 'pass', { judge: { criterion: '像熟人', verdict: 'unclear', answer: '不好说' } }),
      result('c', 'error', { error: 'turn_timeout' }),
    ])
    const md = renderReportMd(cur, diffRuns(run('r1', [result('a', 'pass')]), cur))
    expect(md).toContain('# 输出评测 r2')
    expect(md).toContain('1 过 / 1 不过 / 1 出错(共 3 条)')
    expect(md).toContain('## 回归(上次过、这次不过):1')
    expect(md).toContain('- a')
    expect(md).toContain('✗ maxChars 3 — 9 字')
    expect(md).toContain('早早早早早早早早早')
    expect(md).toContain('## 裁判拿不准(judge_unclear):1')
    expect(md).toContain('- b — 「不好说」')
    expect(md).toContain('turn_timeout')
  })
  it('裁判没跑成(没有便宜模型 / 超时)单列,不能看着像全过(Codex 评审)', () => {
    const cur = run('r1', [result('a', 'pass', { judge: { criterion: '像熟人', verdict: 'error', error: 'eval_no_cheap_model' } })])
    expect(summarize(cur.results).judgeError).toBe(1)
    const md = renderReportMd({ ...cur, summary: summarize(cur.results) }, diffRuns(null, cur))
    expect(md).toContain('## 裁判没跑成:1')
    expect(md).toContain('- a — eval_no_cheap_model')
  })
  it('第一次跑:写「基线」', () => {
    const cur = run('r1', [result('a', 'pass')])
    expect(renderReportMd(cur, diffRuns(null, cur))).toContain('第一次跑,这次是基线')
  })
})

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEval, diffLatest, formatRunSummary, EVAL_EXIT, exitCodeFor, type EvalCliDeps } from './output-eval'
import { parseSample, type RunReport } from '../domain/output-eval'

let evalDir = ''
beforeEach(() => { evalDir = mkdtempSync(join(tmpdir(), 'wcc-eval-cli-')); mkdirSync(join(evalDir, 'samples'), { recursive: true }) })
afterEach(() => { rmSync(evalDir, { recursive: true, force: true }) })

const sample = (id: string, body: Record<string, unknown>) => writeFileSync(join(evalDir, 'samples', `${id}.json`), JSON.stringify({ id, ...body }))

type Handler = (path: string, body: any) => { status: number; json: unknown }
function deps(handler: Handler, o: { health?: number; info?: boolean; t0?: number } = {}): EvalCliDeps & { calls: Array<{ path: string; body: any; auth: string }> } {
  const calls: Array<{ path: string; body: any; auth: string }> = []
  let t = o.t0 ?? Date.parse('2026-10-29T04:00:00.000Z')
  return {
    calls,
    evalDir,
    readApiInfo: () => (o.info === false ? null : { baseUrl: 'http://x', token: 'file-tok', operatorToken: 'op-tok' }),
    fetch: (async (url: string, init?: RequestInit) => {
      const path = url.replace('http://x', '')
      const auth = String((init?.headers as Record<string, string>)?.authorization ?? '')
      if (path === '/v1/health') return new Response('{}', { status: o.health ?? 200 })
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ path, body, auth })
      const r = handler(path, body)
      return new Response(JSON.stringify(r.json), { status: r.status })
    }) as typeof fetch,
    now: () => (t += 1000),
    log: () => {},
  }
}

const turn = (finalText: string, extra: Record<string, unknown> = {}) => ({ status: 200, json: { ok: true, kind: 'reply', providerId: 'claude', finalText, bubbles: finalText ? [finalText] : [], silent: false, ...extra } })

describe('runEval', () => {
  it('每条样本调一次路由(operator 凭据),按硬规则判;写 report.json + report.md;第一次是基线', async () => {
    sample('greet', { kind: 'reply', input: { text: '早', tier: 'admin' }, rules: [{ maxChars: 20 }] })
    sample('think', { kind: 'reply', input: { text: '在吗' } })
    const d = deps((_p, b) => (b.text === '早' ? turn('早,今天先做哪件?') : turn('<think>嗯</think>在')))
    const r = await runEval(d, {})
    expect(d.calls.map(c => [c.path, c.body, c.auth])).toEqual([
      ['/v1/eval/run', { kind: 'reply', text: '早', tier: 'admin' }, 'Bearer op-tok'],
      ['/v1/eval/run', { kind: 'reply', text: '在吗' }, 'Bearer op-tok'],
    ])
    expect(r.report.results.map(x => [x.id, x.status])).toEqual([['greet', 'pass'], ['think', 'fail']])
    expect(r.report.results[1]!.rules[0]).toMatchObject({ rule: 'noThink', ok: false })
    expect(r.diff.from).toBeNull()
    const saved = JSON.parse(readFileSync(join(r.dir, 'report.json'), 'utf8')) as RunReport
    expect(saved.summary).toEqual({ total: 2, pass: 1, fail: 1, error: 0, judgeUnclear: 0 })
    expect(readFileSync(join(r.dir, 'report.md'), 'utf8')).toContain('第一次跑,这次是基线')
    expect(exitCodeFor(r.report)).toBe(EVAL_EXIT.failed)
  })

  it('第二次跑和上一次比:上次过、这次不过 = 回归', async () => {
    sample('greet', { kind: 'reply', input: { text: '早' }, rules: [{ maxChars: 5 }] })
    const first = await runEval(deps(() => turn('早')), {})
    expect(first.report.results[0]!.status).toBe('pass')
    const second = await runEval(deps(() => turn('早上好呀,今天天气不错'), { t0: Date.parse('2026-10-29T05:00:00.000Z') }), {})
    expect(second.diff).toMatchObject({ from: first.report.runId, regressions: ['greet'] })
    expect(readFileSync(join(second.dir, 'report.md'), 'utf8')).toContain('## 回归(上次过、这次不过):1')
    expect(await diffLatest(evalDir)).toMatchObject({ from: first.report.runId, to: second.report.runId, regressions: ['greet'] })
  })

  it('judge:便宜模型回 0 ⇒ 不过;回不清 ⇒ judge_unclear,不算过也不算不过;判分走同一条路由', async () => {
    sample('a', { kind: 'reply', input: { text: '早' }, judge: '像熟人' })
    sample('b', { kind: 'reply', input: { text: '晚' }, judge: '像熟人' })
    const d = deps((_p, b) => {
      if (b.kind === 'judge') return { status: 200, json: { ok: true, kind: 'judge', answer: b.prompt.includes('<input>\n早\n</input>') ? '0' : '可能吧' } }
      return turn('好')
    })
    const r = await runEval(d, {})
    expect(r.report.results.map(x => [x.id, x.status, x.judge?.verdict])).toEqual([['a', 'fail', 'fail'], ['b', 'pass', 'unclear']])
    expect(r.report.summary.judgeUnclear).toBe(1)
    expect(d.calls.filter(c => c.body.kind === 'judge')).toHaveLength(2)
  })

  it('没有便宜模型 ⇒ 裁判记 error,不挡硬规则的结论', async () => {
    sample('a', { kind: 'reply', input: { text: '早' }, judge: '像熟人' })
    const r = await runEval(deps((_p, b) => (b.kind === 'judge' ? { status: 503, json: { ok: false, error: 'eval_no_cheap_model' } } : turn('好'))), {})
    expect(r.report.results[0]).toMatchObject({ status: 'pass', judge: { verdict: 'error', error: 'http_503 eval_no_cheap_model' } })
  })

  it('daemon 那头跑不起来 / 路由拒了 / 样本文件写错 ⇒ 这一条记 error,其余照跑', async () => {
    sample('a', { kind: 'reply', input: { text: '早' } })
    sample('b', { kind: 'reply', input: { text: '晚' } })
    writeFileSync(join(evalDir, 'samples', 'c.json'), '{ not json')
    sample('d', { kind: 'chat', input: {} })
    const d = deps((_p, b) => (b.text === '早'
      ? { status: 200, json: { ok: false, kind: 'reply', error: 'turn timed out', errorCode: 'turn_timeout', finalText: '', bubbles: [], silent: false } }
      : { status: 404, json: { ok: false, error: 'eval_unknown_provider' } }))
    const r = await runEval(d, {})
    expect(r.report.results.map(x => [x.id, x.status, x.error])).toEqual([
      ['a', 'error', 'turn timed out (turn_timeout)'],
      ['b', 'error', 'http_404 eval_unknown_provider'],
      ['c', 'error', expect.stringContaining('样本文件读不了')],
      ['d', 'error', '样本写错了:kind 只能是 reply / brief / reference'],
    ])
    expect(d.calls).toHaveLength(2)
  })

  it('--only 只跑点名的;--provider 只加给 reply / brief', async () => {
    sample('a', { kind: 'reply', input: { text: '早' } })
    sample('b', { kind: 'reference', input: { text: '登录那件', candidates: [] }, rules: [{ resolves: { kind: 'none' } }] })
    sample('c', { kind: 'reply', input: { text: '晚' } })
    const d = deps((_p, b) => (b.kind === 'reference' ? { status: 200, json: { ok: true, kind: 'reference', resolution: { kind: 'none' } } } : turn('好')))
    const r = await runEval(d, { only: ['a', 'b'], providerId: 'codex' })
    expect(d.calls.map(c => c.body)).toEqual([
      { kind: 'reply', text: '早', providerId: 'codex' },
      { kind: 'reference', text: '登录那件', candidates: [] },
    ])
    expect(r.report.providerId).toBe('codex')
    expect(r.report.results.map(x => [x.id, x.status])).toEqual([['a', 'pass'], ['b', 'pass']])
  })

  it('daemon 没在跑 ⇒ 抛 daemon_not_running(CLI 退 2),不写报告', async () => {
    sample('a', { kind: 'reply', input: { text: '早' } })
    await expect(runEval(deps(() => turn('好'), { info: false }), {})).rejects.toThrow('daemon_not_running')
    await expect(runEval(deps(() => turn('好'), { health: 500 }), {})).rejects.toThrow('daemon_not_running')
    expect(existsSync(join(evalDir, 'runs')) ? readdirSync(join(evalDir, 'runs')) : []).toEqual([])
  })

  it('没有样本 ⇒ 抛 no_samples', async () => {
    await expect(runEval(deps(() => turn('好')), {})).rejects.toThrow('no_samples')
  })
})

describe('formatRunSummary / exitCodeFor', () => {
  it('全过 ⇒ 0;人读版每条一行,末尾写回归和报告路径', async () => {
    sample('a', { kind: 'reply', input: { text: '早' } })
    const r = await runEval(deps(() => turn('好')), {})
    expect(exitCodeFor(r.report)).toBe(EVAL_EXIT.ok)
    const text = formatRunSummary(r)
    expect(text).toContain('✓ a')
    expect(text).toContain('1 过 / 0 不过 / 0 出错')
    expect(text).toContain(join(r.dir, 'report.md'))
  })
})

describe('仓库里的示例样本(eval/output/examples/)', () => {
  it('每一份都读得通,id 和文件名一致,三类各有一条', () => {
    const dir = join(__dirname, '..', '..', 'eval', 'output', 'examples')
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    const kinds = files.map(f => {
      const id = f.slice(0, -5)
      const p = parseSample(JSON.parse(readFileSync(join(dir, f), 'utf8')), id)
      expect(p, f).toMatchObject({ ok: true, sample: { id } })
      return p.ok ? p.sample.kind : null
    })
    expect(kinds.sort()).toEqual(['brief', 'reference', 'reply'])
  })
})

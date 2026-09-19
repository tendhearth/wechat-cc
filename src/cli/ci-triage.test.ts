import { describe, it, expect } from 'vitest'
import {
  stripLogPrefix,
  parseJobLog,
  relatedSources,
  globToRegExp,
  classifyFailure,
  classifyJob,
  verdictOf,
  pickBaseSha,
  formatTriage,
  NO_SUMMARY,
  type FlakeRegistry,
  type Classified,
  type ClassifyCtx,
  type TriageReport,
} from './ci-triage'

// Fixtures below are inline, deliberately shaped like real
// `gh run view --job <id> --log-failed` output: `<job>\t<step>\t<ISO ts> <text>`,
// with both ANSI escape forms (`\x1b[31m` and the literal `^[[31m` residue)
// gh's pipe has been seen leaving behind. No network, no real CI run.
const prefixed = (job: string, step: string, ts: string, text: string) => `${job}\t${step}\t${ts} ${text}`

describe('stripLogPrefix', () => {
  it('strips job\\tstep\\t and the leading timestamp, leaving the rest untouched', () => {
    const line = 'build · windows-latest\tRun tests\t2026-09-18T17:06:20.5714169Z  ✓ x'
    expect(stripLogPrefix(line)).toBe('  ✓ x')
  })

  it('returns lines without two tabs unchanged', () => {
    expect(stripLogPrefix('no tabs here')).toBe('no tabs here')
    expect(stripLogPrefix('one\ttab only')).toBe('one\ttab only')
  })
})

describe('parseJobLog', () => {
  it('parses two FAIL blocks, strips ANSI from excerpts, dedupes by file+test, and finds the summary line', () => {
    const job = 'build · windows-latest'
    const step = 'Run tests'
    const ts = '2026-09-18T17:06:20.0000000Z'
    const raw = [
      prefixed(job, step, ts, 'RUN  v1.6.0 /home/runner/work/wechat-cc'),
      prefixed(job, step, ts, 'FAIL src/daemon/foo.test.ts > suite one > test one'),
      prefixed(job, step, ts, '\x1b[31mAssertionError: expected 1 to be 2\x1b[0m'),
      prefixed(job, step, ts, '^[[31m at Object.<anonymous> (src/daemon/foo.test.ts:10:5)^[[0m'),
      prefixed(job, step, ts, '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯'),
      prefixed(job, step, ts, 'FAIL src/cli/bar.test.ts > suite two > test two'),
      prefixed(job, step, ts, 'Error: boom'),
      prefixed(job, step, ts, '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯'),
      // Duplicate of the first block (same file + test) — must not double-count.
      prefixed(job, step, ts, 'FAIL src/daemon/foo.test.ts > suite one > test one'),
      prefixed(job, step, ts, 'AssertionError: expected 1 to be 2 (dup)'),
      prefixed(job, step, ts, '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯'),
      prefixed(job, step, ts, 'Test Files  1 failed | 576 passed (577)'),
    ].join('\n')

    const parsed = parseJobLog(raw, job)

    expect(parsed.failures).toHaveLength(2)
    expect(parsed.failures[0]).toMatchObject({ job, file: 'src/daemon/foo.test.ts', test: 'suite one > test one' })
    expect(parsed.failures[1]).toMatchObject({ job, file: 'src/cli/bar.test.ts', test: 'suite two > test two' })
    expect(parsed.hasSummary).toBe(true)
    for (const f of parsed.failures) {
      expect(f.excerpt).not.toMatch(/\x1b\[/)
      expect(f.excerpt).not.toMatch(/\^\[\[/)
    }
  })

  it('reports no failures and no summary when the log has neither, and captures the ##[error] line', () => {
    const job = 'build · windows-latest'
    const step = 'Run tests'
    const ts = '2026-09-18T17:06:20.0000000Z'
    const raw = [
      prefixed(job, step, ts, 'Run vitest run'),
      prefixed(job, step, ts, '##[error]Process completed with exit code 1.'),
    ].join('\n')

    const parsed = parseJobLog(raw, job)

    expect(parsed.failures).toEqual([])
    expect(parsed.hasSummary).toBe(false)
    expect(parsed.stepErrors.some(l => l.includes('Process completed with exit code 1'))).toBe(true)
  })
})

describe('relatedSources', () => {
  it('a .test.ts file is related to itself and its non-test source', () => {
    expect(relatedSources('src/a/b.test.ts')).toEqual(['src/a/b.test.ts', 'src/a/b.ts'])
  })

  it('any other file is only related to itself', () => {
    expect(relatedSources('src/cli/ci-triage.ts')).toEqual(['src/cli/ci-triage.ts'])
  })
})

describe('globToRegExp', () => {
  it('supports * within a segment and ** across segments, anchored', () => {
    const re = globToRegExp('src/**/x*.test.ts')
    expect(re.test('src/a/b/x1.test.ts')).toBe(true)
    expect(re.test('src/x1.test.tsx')).toBe(false)
  })
})

const testRegistry: FlakeRegistry = {
  entries: [
    { id: 'win-hook-timeout', jobs: ['build · windows-latest'], symptom: 'Hook timed out in \\d+ms', note: 'windows runner 慢', since: '2026-09-16' },
    { id: 'econnreset-chunked', files: ['src/daemon/internal-api/routes-workbench*.test.ts'], symptom: 'ECONNRESET', note: '分块上传偶发', since: '2026-09-10' },
    { id: 'node-no-summary', jobs: ['node · core suite'], symptom: NO_SUMMARY, note: 'node 作业没有汇总行', since: '2026-09-16' },
  ],
}

const ctxWith = (overrides: Partial<ClassifyCtx>): ClassifyCtx => ({
  changedFiles: new Set(),
  registry: testRegistry,
  ...overrides,
})

describe('classifyFailure', () => {
  it('is real when the failing test file itself changed', () => {
    const f = { job: 'build · windows-latest', file: 'src/a.test.ts', test: 't', excerpt: 'boom' }
    const c = classifyFailure(f, ctxWith({ changedFiles: new Set(['src/a.test.ts']) }))
    expect(c).toEqual({ kind: 'real', failure: f, reason: 'file changed since last green' })
  })

  it('is real when the test file itself is untouched but its source sibling changed', () => {
    const f = { job: 'build · windows-latest', file: 'src/a.test.ts', test: 't', excerpt: 'boom' }
    const c = classifyFailure(f, ctxWith({ changedFiles: new Set(['src/a.ts']) }))
    expect(c).toEqual({ kind: 'real', failure: f, reason: 'file changed since last green' })
  })

  it('is a known flake when unrelated file + symptom + job all match', () => {
    const f = { job: 'build · windows-latest', file: 'src/b.test.ts', test: 't', excerpt: 'Error: Hook timed out in 20000ms.' }
    const c = classifyFailure(f, ctxWith({}))
    expect(c).toEqual({ kind: 'flake', failure: f, id: 'win-hook-timeout' })
  })

  it('is unknown when the symptom matches but the job does not', () => {
    const f = { job: 'build · macos-latest', file: 'src/b.test.ts', test: 't', excerpt: 'Error: Hook timed out in 20000ms.' }
    const c = classifyFailure(f, ctxWith({})) as Classified & { kind: 'unknown' }
    expect(c.kind).toBe('unknown')
    expect(c.failure).toEqual(f)
  })

  it('respects a files glob restriction on the registry entry', () => {
    const matching = { job: 'x', file: 'src/daemon/internal-api/routes-workbench-upload.test.ts', test: 't', excerpt: 'ECONNRESET: socket hang up' }
    expect(classifyFailure(matching, ctxWith({}))).toEqual({ kind: 'flake', failure: matching, id: 'econnreset-chunked' })

    const nonMatching = { job: 'x', file: 'src/x.test.ts', test: 't', excerpt: 'ECONNRESET: socket hang up' }
    const c = classifyFailure(nonMatching, ctxWith({}))
    expect(c.kind).toBe('unknown')
  })

  it('is real on a second run even if the symptom matches a known flake', () => {
    const f = { job: 'build · windows-latest', file: 'src/b.test.ts', test: 't', excerpt: 'Error: Hook timed out in 20000ms.' }
    const c = classifyFailure(f, ctxWith({ secondRun: true }))
    expect(c).toEqual({ kind: 'real', failure: f, reason: 'still failing after rerun' })
  })
})

describe('classifyJob', () => {
  it('a non-test failed step is real with no failure, reason includes stepErrors', () => {
    const job = { name: 'build · windows-latest', failedStep: 'Typecheck' }
    const parsed = { failures: [], stepErrors: ['##[error]TS2345: bad arg'], hasSummary: false }
    const result = classifyJob(job, parsed, ctxWith({}))
    expect(result).toEqual([{ kind: 'real', failure: null, reason: 'step Typecheck failed\n##[error]TS2345: bad arg' }])
  })

  it('Run tests + empty failures + no summary + a job the registry names ⇒ flake:node-no-summary', () => {
    const job = { name: 'node · core suite', failedStep: 'Run tests' }
    const parsed = { failures: [], stepErrors: [], hasSummary: false }
    const result = classifyJob(job, parsed, ctxWith({}))
    expect(result).toEqual([{ kind: 'flake', failure: null, id: 'node-no-summary' }])
  })

  it('same shape but a job the registry does not name ⇒ unknown', () => {
    const job = { name: 'build · ubuntu-latest', failedStep: 'Run tests' }
    const parsed = { failures: [], stepErrors: [], hasSummary: false }
    const result = classifyJob(job, parsed, ctxWith({}))
    expect(result).toEqual([{ kind: 'unknown', failure: null, excerpt: '' }])
  })
})

describe('verdictOf', () => {
  const flakeC: Classified = { kind: 'flake', failure: null, id: 'x' }
  const realC: Classified = { kind: 'real', failure: null, reason: 'x' }
  const unknownC: Classified = { kind: 'unknown', failure: null, excerpt: '' }

  it('no classified failures ⇒ green', () => {
    expect(verdictOf([])).toBe('green')
  })
  it('all flake ⇒ flake', () => {
    expect(verdictOf([flakeC, flakeC])).toBe('flake')
  })
  it('any real ⇒ real, even mixed with flake', () => {
    expect(verdictOf([flakeC, realC])).toBe('real')
  })
  it('mixed flake + unknown (no real) ⇒ unknown', () => {
    expect(verdictOf([flakeC, unknownC])).toBe('unknown')
  })
})

describe('pickBaseSha', () => {
  it('skips failed runs, itself, and non-ancestors, and finds the first ancestor success', () => {
    const runs = [
      { headSha: 'sha0', conclusion: null },
      { headSha: 'shaFail', conclusion: 'failure' },
      { headSha: 'shaNotAncestor', conclusion: 'success' },
      { headSha: 'shaGood', conclusion: 'success' },
      { headSha: 'shaGood2', conclusion: 'success' },
    ]
    const isAncestor = (a: string) => a === 'shaGood' || a === 'shaGood2'
    expect(pickBaseSha(runs, 'sha0', isAncestor)).toBe('shaGood')
  })

  it('returns null when nothing qualifies', () => {
    const runs = [
      { headSha: 'sha0', conclusion: null },
      { headSha: 'shaFail', conclusion: 'failure' },
      { headSha: 'shaNotAncestor', conclusion: 'success' },
    ]
    expect(pickBaseSha(runs, 'sha0', () => false)).toBeNull()
  })
})

describe('formatTriage', () => {
  it('formats the summary line and indents an unknown excerpt', () => {
    const report: TriageReport = {
      sha: '0123456789abcdef',
      runId: 42,
      url: 'https://github.com/x/y/actions/runs/42',
      verdict: 'unknown',
      base: 'deadbeef',
      changedFiles: [],
      reruns: 0,
      jobs: [
        {
          name: 'build · windows-latest',
          step: 'Run tests',
          classified: [
            { kind: 'flake', failure: { job: 'build · windows-latest', file: 'src/a.test.ts', test: 'works', excerpt: 'x' }, id: 'win-hook-timeout' },
            { kind: 'unknown', failure: { job: 'build · windows-latest', file: 'src/b.test.ts', test: 'breaks', excerpt: '' }, excerpt: 'line1\nline2' },
          ],
        },
      ],
    }

    const out = formatTriage(report)
    const lines = out.split('\n')

    expect(lines[0]).toBe('verdict=unknown sha=01234567 run=42 https://github.com/x/y/actions/runs/42')
    expect(lines).toContain('  build · windows-latest · src/a.test.ts · works → flake:win-hook-timeout')
    expect(lines).toContain('  build · windows-latest · src/b.test.ts · breaks → unknown')
    expect(lines).toContain('    line1')
    expect(lines).toContain('    line2')
  })
})

describe('parseJobLog edge cases (review follow-up)', () => {
  it('a FAIL line with no `>` suffix yields test === "" and still forms a block', () => {
    const log = ['job\tRun tests\t2026-09-18T17:06:20.000Z  FAIL  src/a.test.ts', 'job\tRun tests\t2026-09-18T17:06:20.000Z Error: boom', 'job\tRun tests\t2026-09-18T17:06:20.000Z  Test Files  1 failed (1)'].join('\n')
    const parsed = parseJobLog(log, 'job')
    expect(parsed.failures).toHaveLength(1)
    expect(parsed.failures[0]!.file).toBe('src/a.test.ts')
    expect(parsed.failures[0]!.test).toBe('')
    expect(parsed.failures[0]!.excerpt).toContain('Error: boom')
    expect(parsed.hasSummary).toBe(true)
  })
  it('caps the excerpt at 60 lines', () => {
    const body = Array.from({ length: 90 }, (_, i) => `job\tRun tests\t2026-09-18T17:06:20.000Z line-${i}`)
    const log = ['job\tRun tests\t2026-09-18T17:06:20.000Z  FAIL  src/a.test.ts > s > t', ...body].join('\n')
    const parsed = parseJobLog(log, 'job')
    const lines = parsed.failures[0]!.excerpt.split('\n')
    expect(lines.length).toBeLessThanOrEqual(60)
    expect(parsed.failures[0]!.excerpt).toContain('line-0')
    expect(parsed.failures[0]!.excerpt).not.toContain('line-80')
  })
})

describe('globToRegExp escapes ? literally', () => {
  it('a literal ? in the glob matches only ?', () => {
    const re = globToRegExp('src/a?.test.ts')
    expect(re.test('src/a?.test.ts')).toBe(true)
    expect(re.test('src/ab.test.ts')).toBe(false)
  })
})

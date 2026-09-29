/**
 * ci-triage.ts — pure-logic core of `wechat-cc ci triage`.
 *
 * Answers "did CI go green, and if not, is the failure mine or a known
 * flake?" from already-fetched data (gh run/job JSON, `--log-failed` text,
 * changed files). No network, no spawn — the shell (src/cli/ci-triage-run.ts,
 * a later task) fetches everything and hands it to these functions, so the
 * classification rules are unit-testable without `gh` or a real CI run, and
 * the self-change pipeline (also a later task) can call `classify*`/`verdictOf`
 * in-process without shelling out to this CLI at all.
 *
 * Design: docs/superpowers/specs/2026-09-18-ci-triage-design.md §2.
 */

export interface FlakeEntry {
  id: string
  symptom: string
  jobs?: string[]
  files?: string[]
  note: string
  since: string
}

export interface FlakeRegistry {
  entries: FlakeEntry[]
}

export interface Failure {
  job: string
  file: string
  test: string
  excerpt: string
}

export interface ParsedJobLog {
  failures: Failure[]
  stepErrors: string[]
  hasSummary: boolean
  /** 每条 `Hook timed out` 行的时间戳(epoch ms,来自 gh 日志行前缀);判 runner 卡死用。 */
  hookTimeoutAt: number[]
}

export type Classified =
  | { kind: 'real'; failure: Failure | null; reason: string }
  | { kind: 'flake'; failure: Failure | null; id: string }
  | { kind: 'unknown'; failure: Failure | null; excerpt: string }

export type Verdict = 'green' | 'flake' | 'real' | 'unknown'

export interface ClassifyCtx {
  changedFiles: ReadonlySet<string>
  registry: FlakeRegistry
  secondRun?: boolean
  /** 同一次运行里,除这条作业外的 `build · *` 作业都绿(且至少有一条)。runner 卡死判定要它。 */
  siblingBuildsGreen?: boolean
}

export interface TriageReport {
  sha: string
  runId: number | null
  url: string | null
  verdict: Verdict
  base: string | null
  changedFiles: string[]
  jobs: Array<{ name: string; step: string | null; classified: Classified[] }>
  reruns: number
}

/** Special `symptom` value: the job failed but its log has no FAIL block and
 * no `Test Files` summary line (the runner's own output got cut off). Only
 * `classifyJob` matches on this — `classifyFailure` never does, since it is
 * only meaningful when there is no `Failure` to classify. */
export const NO_SUMMARY = '__NO_SUMMARY__'

/** Step names that run the actual test suite. Any other failed step (typecheck,
 * build, depcheck, smoke, …) is treated as a real failure with no per-test
 * classification. */
export const TEST_STEP_NAMES: readonly string[] = [
  'Run tests',
  'Unit tests under Node (whole src, minus the ws server)',
]

/** Strip both ANSI escape forms seen in `gh run view --log-failed` output:
 * real ESC (`\x1b[31m`) and the literal-caret residue (`^[[31m`) some
 * terminals/pipes leave behind. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\^\[\[[0-9;]*[A-Za-z]/g, '')
}

/** Strip the `<job>\t<step>\t` prefix and the leading ISO timestamp that
 * `gh run view --job --log-failed` puts on every line. Lines without two
 * tabs (e.g. already-stripped fixtures) pass through unchanged. */
export function stripLogPrefix(line: string): string {
  const firstTab = line.indexOf('\t')
  if (firstTab === -1) return line
  const secondTab = line.indexOf('\t', firstTab + 1)
  if (secondTab === -1) return line
  const rest = line.slice(secondTab + 1)
  return rest.replace(/^\d{4}-\d{2}-\d{2}T[^ ]+/, '')
}

const FAIL_RE = /^\s*FAIL\s+(\S+\.test\.ts)(?:\s*>\s*(.+))?$/
const DIVIDER_RE = /^\s*⎯{5,}/

/** Parse a job's failed-step log into FAIL blocks + step-level `##[error]`
 * lines + whether a `Test Files` summary line was present at all. */
export function parseJobLog(raw: string, jobName: string): ParsedJobLog {
  const rawLines = stripAnsi(raw).split('\n')
  const hookTimeoutAt: number[] = []
  for (const l of rawLines) {
    if (!/Hook timed out in \d+ms/.test(l)) continue
    const m = /\t(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(l)
    const t = m ? Date.parse(m[1]!) : NaN
    if (Number.isFinite(t)) hookTimeoutAt.push(t)
  }
  const lines = rawLines.map(stripLogPrefix)
  const failures: Failure[] = []
  const seen = new Set<string>()
  const stepErrors: string[] = []
  let hasSummary = false

  const noteLine = (line: string) => {
    if (/^\s*Test Files\s/.test(line)) hasSummary = true
    if (line.includes('##[error]')) stepErrors.push(line)
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    noteLine(line)
    const m = FAIL_RE.exec(line)
    if (m) {
      const file = m[1]!
      const test = m[2] ? m[2].trim() : ''
      const blockLines = [line]
      let j = i + 1
      while (j < lines.length && !FAIL_RE.test(lines[j]!) && !DIVIDER_RE.test(lines[j]!)) {
        blockLines.push(lines[j]!)
        noteLine(lines[j]!)
        j++
      }
      const key = `${file}\0${test}`
      if (!seen.has(key)) {
        seen.add(key)
        failures.push({ job: jobName, file, test, excerpt: blockLines.slice(0, 60).join('\n') })
      }
      i = j
      continue
    }
    i++
  }

  return { failures, stepErrors, hasSummary, hookTimeoutAt }
}

/** `x.test.ts` also depends on `x.ts` — a failure in the test is "real" if
 * either file changed this round. Anything else is only related to itself. */
export function relatedSources(testFile: string): string[] {
  if (testFile.endsWith('.test.ts')) {
    return [testFile, `${testFile.slice(0, -'.test.ts'.length)}.ts`]
  }
  return [testFile]
}

/** Minimal glob → RegExp: only `*` (within one path segment) and `**` (across
 * segments) are supported, matching the brief's "no new dependencies" rule —
 * no picomatch/minimatch. Anchored full-string match. */
export function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*'
        i++
      } else {
        pattern += '[^/]*'
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      pattern += `\\${c}`
    } else {
      pattern += c
    }
  }
  return new RegExp(`^${pattern}$`)
}

/** Validate a raw JSON value against the `FlakeRegistry` shape: unique ids,
 * compilable `symptom` regexes, required `note`/`since`, well-typed optional
 * `jobs`/`files`. Collects every error rather than failing on the first. */
export function validateRegistry(raw: unknown): { ok: true; registry: FlakeRegistry } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { entries?: unknown }).entries)) {
    return { ok: false, errors: ['registry must be an object with an "entries" array'] }
  }
  const rawEntries = (raw as { entries: unknown[] }).entries
  const seenIds = new Set<string>()
  const entries: FlakeEntry[] = []

  rawEntries.forEach((rawEntry, idx) => {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      errors.push(`entry ${idx}: must be an object`)
      return
    }
    const e = rawEntry as Record<string, unknown>
    const id = e.id
    const label = typeof id === 'string' && id.length > 0 ? id : `#${idx}`

    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`entry ${label}: id must be a non-empty string`)
    } else if (seenIds.has(id)) {
      errors.push(`duplicate id ${id}`)
    } else {
      seenIds.add(id)
    }

    if (typeof e.symptom !== 'string' || e.symptom.length === 0) {
      errors.push(`entry ${label}: symptom must be a non-empty string`)
    } else {
      try {
        // eslint-disable-next-line no-new
        new RegExp(e.symptom)
      } catch (err) {
        errors.push(`entry ${label}: invalid regex in symptom (${(err as Error).message})`)
      }
    }

    if (typeof e.note !== 'string' || e.note.length === 0) {
      errors.push(`entry ${label}: note must be a non-empty string`)
    }
    if (typeof e.since !== 'string' || e.since.length === 0) {
      errors.push(`entry ${label}: since must be a non-empty string`)
    }
    if (e.jobs !== undefined && (!Array.isArray(e.jobs) || !e.jobs.every(j => typeof j === 'string'))) {
      errors.push(`entry ${label}: jobs must be an array of strings`)
    }
    if (e.files !== undefined && (!Array.isArray(e.files) || !e.files.every(f => typeof f === 'string'))) {
      errors.push(`entry ${label}: files must be an array of strings`)
    }

    entries.push(e as unknown as FlakeEntry)
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, registry: { entries } }
}

/** Classify a single failing test. Order matters: a rerun that still fails
 * is real regardless of symptom; a changed related file is real regardless
 * of symptom; only then does the flake registry get a look; anything left
 * is unknown. */
export function classifyFailure(f: Failure, ctx: ClassifyCtx): Classified {
  if (ctx.secondRun) {
    return { kind: 'real', failure: f, reason: 'still failing after rerun' }
  }

  const related = relatedSources(f.file)
  if (related.some(r => ctx.changedFiles.has(r))) {
    return { kind: 'real', failure: f, reason: 'file changed since last green' }
  }

  for (const entry of ctx.registry.entries) {
    if (entry.symptom === NO_SUMMARY) continue
    if (entry.jobs && !entry.jobs.includes(f.job)) continue
    if (entry.files && !entry.files.some(glob => globToRegExp(glob).test(f.file))) continue
    let symptomRe: RegExp
    try {
      symptomRe = new RegExp(entry.symptom)
    } catch {
      continue
    }
    if (symptomRe.test(f.excerpt)) {
      return { kind: 'flake', failure: f, id: entry.id }
    }
  }

  return { kind: 'unknown', failure: f, excerpt: f.excerpt.split('\n').slice(0, 12).join('\n') }
}

const STALL_MIN_TIMEOUTS = 3
const STALL_WINDOW_MS = 2000

/**
 * 一批 hook 超时挤在两秒之内(2026-09-28 #142、#145:六条 `Hook timed out in 40000ms` 同一秒,
 * 连纯文档 PR 都红)。单看这个不够判 runner 卡死 —— 见 classifyJob 里另外两个条件。
 */
export function isRunnerStall(parsed: ParsedJobLog): boolean {
  const ts = [...parsed.hookTimeoutAt].sort((a, b) => a - b)
  for (let i = 0; i + STALL_MIN_TIMEOUTS - 1 < ts.length; i++) {
    if (ts[i + STALL_MIN_TIMEOUTS - 1]! - ts[i]! <= STALL_WINDOW_MS) return true
  }
  return false
}

/** Classify an entire job's outcome. A non-test failed step (typecheck,
 * build, …) is real with no per-test breakdown. A test step with no parsed
 * failures and no summary line is the `NO_SUMMARY` case — flake only if the
 * registry has an entry that names this exact job. */
export function classifyJob(
  job: { name: string; failedStep: string | null },
  parsed: ParsedJobLog,
  ctx: ClassifyCtx,
): Classified[] {
  if (job.failedStep === null || !TEST_STEP_NAMES.includes(job.failedStep)) {
    let reason = `step ${job.failedStep} failed`
    if (parsed.stepErrors.length > 0) {
      reason += `\n${parsed.stepErrors.slice(0, 3).join('\n')}`
    }
    return [{ kind: 'real', failure: null, reason }]
  }

  // Windows runner 卡死:整条作业一个 flake,**先于**「重跑后仍红 / 动过相关文件 ⇒ real」。
  // 三个条件同时成立才算:Windows 作业、同一运行里别的构建都绿、一批 hook 超时挤在两秒内。
  // 只看批量超时不够 —— 一个改动让公共 setup 卡住,几个并行文件也会同一刻超时,但那样
  // Linux / macOS 也会红。
  if (/windows/i.test(job.name) && ctx.siblingBuildsGreen && isRunnerStall(parsed)) {
    return [{ kind: 'flake', failure: null, id: 'runner-stall' }]
  }

  if (parsed.failures.length > 0) {
    return parsed.failures.map(f => classifyFailure(f, ctx))
  }

  if (!parsed.hasSummary) {
    const entry = ctx.registry.entries.find(
      e => e.symptom === NO_SUMMARY && Array.isArray(e.jobs) && e.jobs.includes(job.name),
    )
    if (entry) return [{ kind: 'flake', failure: null, id: entry.id }]
    return [{ kind: 'unknown', failure: null, excerpt: parsed.stepErrors.slice(0, 12).join('\n') }]
  }

  return [{ kind: 'unknown', failure: null, excerpt: parsed.stepErrors.slice(0, 12).join('\n') }]
}

/** No failures ⇒ green. Any real ⇒ real (real always wins). All flake ⇒
 * flake. Otherwise (a mix that includes unknown, but no real) ⇒ unknown. */
export function verdictOf(all: Classified[]): Verdict {
  if (all.length === 0) return 'green'
  if (all.some(c => c.kind === 'real')) return 'real'
  if (all.every(c => c.kind === 'flake')) return 'flake'
  return 'unknown'
}

/** Pick the base sha to diff against: the most recent successful run (newest
 * first in `runs`) whose headSha is an ancestor of `sha` and isn't `sha`
 * itself. `null` means the caller should fall back to `sha~1`. */
export function pickBaseSha(
  runs: Array<{ headSha: string; conclusion: string | null }>,
  sha: string,
  isAncestor: (a: string, b: string) => boolean,
): string | null {
  for (const run of runs) {
    if (run.conclusion === 'success' && run.headSha !== sha && isAncestor(run.headSha, sha)) {
      return run.headSha
    }
  }
  return null
}

/** Human-readable triage report: one summary line, then one line per
 * classified failure, with unknowns' excerpt indented below. */
export function formatTriage(report: TriageReport): string {
  const shaShort = report.sha.slice(0, 8)
  const lines: string[] = [
    `verdict=${report.verdict} sha=${shaShort} run=${report.runId ?? 'null'} ${report.url ?? ''}`.trimEnd(),
  ]
  for (const job of report.jobs) {
    for (const c of job.classified) {
      const fileOrStep = c.failure ? c.failure.file : (job.step ?? '')
      const test = c.failure ? c.failure.test : ''
      const kindLabel = c.kind === 'flake' ? `flake:${c.id}` : c.kind
      lines.push(`  ${job.name} · ${fileOrStep} · ${test} → ${kindLabel}`)
      if (c.kind === 'unknown') {
        for (const excerptLine of c.excerpt.split('\n')) {
          lines.push(`    ${excerptLine}`)
        }
      }
    }
  }
  return lines.join('\n')
}

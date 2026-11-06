import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eligible, main } from './ci-tree-coverage.mjs'
const tree = 'a'.repeat(40)
const run = { id: 42, run_attempt: 1, event: 'pull_request', status: 'completed', conclusion: 'success' }
const receipt = { version: 1, repository: 'o/r', run: '42', attempt: '1', tree, merge: 'b'.repeat(40) }
const jobs = ['ubuntu-latest', 'macos-latest', 'windows-latest'].map(os => ({ name: `build · ${os}`, conclusion: 'success' }))
describe('exact PR merge-tree coverage', () => {
  it('identical tree with a successful three-platform PR is reusable across squash SHAs', () => {
    expect(eligible(run, receipt, tree, jobs, 'o/r')).toBe(true)
  })
  it('rerunning failed jobs can reuse the unchanged merge-tree receipt from an earlier attempt', () => {
    expect(eligible({ ...run, run_attempt: 2 }, receipt, tree, jobs, 'o/r')).toBe(true)
  })
  it.each([
    ['different tree', run, { ...receipt, tree: 'c'.repeat(40) }, jobs],
    ['failed run', { ...run, conclusion: 'failure' }, receipt, jobs],
    ['running run', { ...run, status: 'in_progress' }, receipt, jobs],
    ['push run', { ...run, event: 'push' }, receipt, jobs],
    ['old two-platform gate', run, receipt, jobs.slice(0, 2)],
    ['failed Windows', run, receipt, [...jobs.slice(0, 2), { ...jobs[2], conclusion: 'failure' }]],
    ['future attempt', run, { ...receipt, attempt: '2' }, jobs],
    ['wrong run', run, { ...receipt, run: '43' }, jobs],
    ['wrong repository', run, { ...receipt, repository: 'other/r' }, jobs],
    ['missing merge identity', run, { ...receipt, merge: '' }, jobs],
  ])('%s falls back to CI', (_name, candidate, proof, builds) => {
    expect(eligible(candidate, proof, tree, builds, 'o/r')).toBe(false)
  })
})

describe('coverage job orchestration (offline API)', () => {
  it.each(['covered', 'different', 'api-error', 'expired', 'wrong-workflow', 'master'])('%s', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-test-'))
    const output = join(dir, 'output'); const summary = join(dir, 'summary')
    writeFileSync(output, ''); writeFileSync(summary, '')
    const calls: string[] = []
    try {
      main({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: mode === 'master' ? 'refs/heads/master' : 'refs/heads/dev',
        GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, (cmd: string, args: string[]) => {
        const line = [cmd, ...args].join(' '); calls.push(line)
        if (cmd === 'git') return tree
        if (mode === 'api-error') throw new Error('offline')
        if (line.includes('/actions/artifacts?')) return JSON.stringify({ artifacts: [{ id: 1, expired: mode === 'expired', workflow_run: { id: 42 } }] })
        if (line.includes('run download')) {
          const dest = args[args.indexOf('--dir') + 1]!
          mkdirSync(dest, { recursive: true })
          writeFileSync(join(dest, 'ci-tree.json'), JSON.stringify({ ...receipt, tree: mode === 'different' ? 'c'.repeat(40) : tree }))
          return ''
        }
        if (line.includes('/jobs?')) return JSON.stringify([{ jobs }])
        return JSON.stringify({ ...run, path: mode === 'wrong-workflow' ? '.github/workflows/other.yml' : '.github/workflows/ci.yml', html_url: 'https://github.com/o/r/actions/runs/42' })
      })
      expect(readFileSync(output, 'utf8').includes('covered=true')).toBe(mode === 'covered')
      if (mode === 'covered') expect(readFileSync(summary, 'utf8')).toContain('/runs/42')
      if (mode === 'master') expect(calls.some(c => c.startsWith('gh'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

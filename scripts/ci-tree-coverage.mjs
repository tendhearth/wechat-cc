/** Exact PR merge-tree receipts; API/artifact failures always fall back to CI. No dependencies. */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function eligible(run, receipt, tree, jobs, repo) {
  return run.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success'
    && receipt.version === 1 && receipt.repository === repo && receipt.run === String(run.id)
    // Re-running only failed jobs retains the original changes artifact. GitHub reruns keep GITHUB_SHA.
    && /^[1-9]\d*$/.test(receipt.attempt) && Number(receipt.attempt) <= run.run_attempt && receipt.tree === tree
    && /^[a-f0-9]{40}$/.test(tree) && /^[a-f0-9]{40}$/.test(receipt.merge)
    && ['ubuntu-latest', 'macos-latest', 'windows-latest'].every(os =>
      jobs.some(j => j.name === `build · ${os}` && j.conclusion === 'success'))
}

export function main(env = process.env, execute) {
  const exec = execute ?? ((cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr || r.error || r.status}`)
    return r.stdout.trim()
  })
  const tree = exec('git', ['rev-parse', 'HEAD^{tree}'])
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `tree=${tree}\n`)
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    writeFileSync('ci-tree.json', JSON.stringify({ version: 1, repository: env.GITHUB_REPOSITORY,
      run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, tree,
      merge: exec('git', ['rev-parse', 'HEAD']) }))
    return
  }
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/dev') return
  let covered
  const dir = mkdtempSync(join(tmpdir(), 'ci-tree-'))
  try {
    const repo = env.GITHUB_REPOSITORY
    // Bounded search is an optimization only: older/missing receipts cost a full run, never a false green.
    const { artifacts } = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/artifacts?name=ci-tree-${tree}&per_page=100`]))
    for (const artifact of artifacts) {
      if (artifact.expired || !artifact.workflow_run?.id) continue
      const dest = join(dir, String(artifact.id))
      try {
        const run = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${artifact.workflow_run.id}`]))
        if (run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' || run.conclusion !== 'success') continue
        exec('gh', ['run', 'download', String(run.id), '--repo', repo, '--name', `ci-tree-${tree}`, '--dir', dest])
        const receipt = JSON.parse(readFileSync(join(dest, 'ci-tree.json'), 'utf8'))
        if (receipt.tree !== tree) continue
        const pages = JSON.parse(exec('gh', ['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]))
        if (eligible(run, receipt, tree, pages.flatMap(p => p.jobs), repo)) { covered = run; break }
      } catch { /* Missing/expired artifact or unreadable evidence: keep looking. */ }
    }
  } catch (e) { console.log(`Coverage unavailable; running CI: ${e.message}`) }
  finally { rmSync(dir, { recursive: true, force: true }) }
  if (covered) {
    appendFileSync(env.GITHUB_OUTPUT, `covered=true\nrun=${covered.id}\n`)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `Tree \`${tree}\` already passed three-platform PR CI: ${covered.html_url}\n`)
    console.log(`Already covered by PR run: ${covered.html_url}`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

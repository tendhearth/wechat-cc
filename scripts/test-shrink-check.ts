/**
 * 测试只增不减 + 修 bug 要有红/绿(规矩见 docs/maintainer/verify.md「测试只增不减」「红/绿」;判法见 test-shrink-lib.ts 开头)。
 *
 *   bun scripts/test-shrink-check.ts                 本机:相对 merge-base(缺省 origin/dev)列出变少/变松的测试,只报告、退出 0
 *   bun scripts/test-shrink-check.ts --pr <N>        本机按某个 PR 判(gh 取标题/描述/分支),跟 CI 同一个结论
 *   bun scripts/test-shrink-check.ts --base <ref>    换基线
 *
 * CI(ci.yml 的 pr-rules 作业,只在 pull_request 上跑):GITHUB_EVENT_NAME=pull_request 时从环境变量读
 * PR_TITLE / PR_BODY(workflow 用 env 传,不在 run 里插值:标题和描述是不可信输入)、GITHUB_HEAD_REF / GITHUB_BASE_REF。
 * 比的是 HEAD(PR 的合并提交)和 merge-base(origin/<base>, HEAD)。拿不到基线在 CI 里判红,不悄悄跳过。
 */
import { spawnSync } from 'node:child_process'
import { collectChanges, findShrinks, judge, type PrInfo } from './test-shrink-lib'

const argv = process.argv.slice(2)
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const git = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

const inPrCi = process.env.GITHUB_EVENT_NAME === 'pull_request'
const prNumber = opt('--pr')

let pr: PrInfo | null = null
let baseRef = opt('--base') ?? 'origin/dev'
if (inPrCi) {
  pr = { title: process.env.PR_TITLE ?? '', body: process.env.PR_BODY ?? '', headRef: process.env.GITHUB_HEAD_REF ?? '', baseRef: process.env.GITHUB_BASE_REF }
  if (process.env.GITHUB_BASE_REF) baseRef = `origin/${process.env.GITHUB_BASE_REF}`
} else if (prNumber) {
  const r = spawnSync('gh', ['pr', 'view', prNumber, '--json', 'title,body,headRefName,baseRefName'], { encoding: 'utf8' })
  if (r.status !== 0) { console.error(`✗ gh pr view ${prNumber} 失败:${r.stderr.trim()}`); process.exit(2) }
  const j = JSON.parse(r.stdout) as { title: string; body: string; headRefName: string; baseRefName: string }
  pr = { title: j.title, body: j.body, headRef: j.headRefName, baseRef: j.baseRefName }
  if (!opt('--base')) baseRef = `origin/${j.baseRefName}`
}

const mb = git(['merge-base', baseRef, 'HEAD'])
if (mb.status !== 0) {
  console.error(`✗ test-shrink:找不到 HEAD 和 ${baseRef} 的共同祖先${inPrCi ? '(checkout 要 fetch-depth: 0)。这道检查不能悄悄跳过。' : '(先 git fetch?或者 --base <ref>)。'}`)
  process.exit(inPrCi ? 1 : 2)
}
const base = mb.stdout.trim()

const changes = collectChanges(base, 'HEAD')
const findings = findShrinks(changes)
const byFile = new Map<string, string[]>()
for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f.what])
if (findings.length) {
  console.log(`相对 ${baseRef}(${base.slice(0, 8)}),这些测试变少/变松了:`)
  for (const [file, whats] of byFile) {
    console.log(`  ${file}`)
    for (const w of whats) console.log(`    - ${w}`)
  }
} else {
  console.log(`✓ test-shrink:相对 ${baseRef}(${base.slice(0, 8)}),改到的 ${changes.length} 个测试相关文件没有变少/变松。`)
}

if (!pr) {
  if (findings.length) console.log(`\n开 PR 时描述里要有 \`## 删掉/放松的测试\`,逐个文件写理由(CI 的 pr-rules 作业会查)。`)
  process.exit(0)
}
const verdict = judge(findings, pr)
for (const m of verdict.messages) (verdict.ok ? console.log : console.error)(m)
if (!verdict.ok && inPrCi) console.error('\n改完 PR 描述后要重新触发:推一次,或者 gh pr close <N> && gh pr reopen <N>(重跑这个作业用的还是旧描述)。')
process.exit(verdict.ok ? 0 : 1)

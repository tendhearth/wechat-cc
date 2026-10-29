/**
 * 「推之前跑过 verify」由机器查(2026-10-27,主人定的测试方向第 ② 条的补充)。
 *
 * 以前这条只写在 AGENTS.md 和派活的提示词里,agent 可以说跑了、也可以忘了跑。现在:
 *  - `bun run verify` 一开始就记下**它检查的那份内容**的 git 树(工作区原样:暂存的、没暂存的、没跟踪但没被忽略的,
 *    用一份临时 index 算,不碰真的 index),全绿才把这棵树记进 `<git 目录>/wechat-cc-verified-trees`(每个 worktree 一份);
 *  - `scripts/git-hooks/pre-push` 对每个要推上去的提交,看它的树在不在记录里 —— 先跑 verify 再 commit 也认(树一样)。
 *    只改了 Markdown(相对 origin/dev)的、删分支的不查。真要绕过:`git push --no-verify`,并在 PR 里说为什么。
 * 用树而不是提交号:verify 常在 commit 之前跑,提交号那时还没有;树只看内容。
 * 装钩子:`git config core.hooksPath scripts/git-hooks`(主仓库配一次,所有 worktree 共用)。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const KEEP = 200

function git(args: string[], cwd: string, env?: Record<string, string>) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败:${r.stderr.trim()}`)
  return r.stdout.trim()
}

function recordFile(cwd: string): string {
  return resolve(cwd, git(['rev-parse', '--git-path', 'wechat-cc-verified-trees'], cwd))
}

/** 工作区现在这份内容的树(没被忽略的都算);不动真的 index。 */
export function workingTree(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-stamp-'))
  try {
    const index = join(dir, 'index')
    const real = resolve(cwd, git(['rev-parse', '--git-path', 'index'], cwd))
    // 拷过来的 index 要带上原来的修改时间:git 拿 index 自己的 mtime 判断哪些条目「可能刚改过、要重新算内容」(racy-git)。
    // 拷贝得到一个新的 mtime ⇒ 和 index 同一秒里改过、长度没变的文件被当成没改,`add -A` 跳过它,算出的树和真提交对不上
    // (CI 慢机上 1.7.8 后 #759 撞到;本机等到下一秒再拷,40/40 复现)。
    if (existsSync(real)) { copyFileSync(real, index); const st = statSync(real); utimesSync(index, st.atime, st.mtime) }
    const env = { GIT_INDEX_FILE: index }
    git(['add', '-A', '--', '.'], cwd, env)
    return git(['write-tree'], cwd, env)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function recordVerified(cwd: string, tree: string): void {
  const file = recordFile(cwd)
  appendFileSync(file, `${tree}\n`)
  const all = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  if (all.length > KEEP * 2) writeFileSync(file, `${all.slice(-KEEP).join('\n')}\n`)
}

export function verifiedTrees(cwd: string): Set<string> {
  try { return new Set(readFileSync(recordFile(cwd), 'utf8').split('\n').filter(Boolean)) } catch { return new Set() }
}

const ZERO = /^0+$/

/**
 * pre-push 的判定。stdin 每行:`<local ref> <local sha> <remote ref> <remote sha>`。
 * 返回拦下的说明(空 = 放行)。
 */
export function prePushProblems(cwd: string, stdin: string, base = 'origin/dev'): string[] {
  const ok = verifiedTrees(cwd)
  const problems: string[] = []
  for (const line of stdin.split('\n').map(l => l.trim()).filter(Boolean)) {
    const [localRef, localSha] = line.split(/\s+/)
    if (!localSha || ZERO.test(localSha)) continue // 删分支
    const tree = git(['rev-parse', `${localSha}^{tree}`], cwd)
    if (ok.has(tree)) continue
    let changed: string[] = []
    try {
      const mb = git(['merge-base', localSha, base], cwd)
      changed = git(['diff', '--name-only', mb, localSha], cwd).split('\n').filter(Boolean)
    } catch { /* 找不到 base:当成有代码改动 */ changed = ['?'] }
    if (changed.length === 0 || changed.every(f => f.endsWith('.md'))) continue
    problems.push(`${localRef}(${localSha.slice(0, 8)}):这份内容没跑过 bun run verify(或者跑了没全绿)`)
  }
  return problems
}

if (import.meta.main) {
  const cwd = process.cwd()
  const stdin = readFileSync(0, 'utf8')
  const problems = prePushProblems(cwd, stdin)
  if (problems.length) {
    console.error(`✗ 推不上去:\n  ${problems.join('\n  ')}\n先 bun run verify(全绿会记下这份内容),再推。真要绕过:git push --no-verify,并在 PR 里写为什么。`)
    process.exit(1)
  }
}

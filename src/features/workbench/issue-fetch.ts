/**
 * 用 gh 只读取一个 issue(issue-intake.ts 的取件那半)。在项目文件夹里跑,gh 自己按 git remote 认仓库。
 * launchd 下 PATH 没有 Homebrew(#421 同类坑)⇒ 先找常见安装位置。失败归成几种原因,不抛。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IssueData } from './issue-intake'

export type IssueFetchReason = 'gh_missing' | 'gh_auth' | 'not_found' | 'not_github' | 'timeout' | 'failed'
export type IssueFetchResult = { ok: true; issue: IssueData } | { ok: false; reason: IssueFetchReason }
type Exec = (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<string>

const TIMEOUT_MS = 15_000
const defaultExec: Exec = (cmd, args, o) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') })); else resolve(String(stdout))
  })
})
const CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
export function findGh(): string | null {
  for (const p of CANDIDATES) if (existsSync(p)) return p
  return process.platform === 'win32' ? 'gh' : null
}

function reasonOf(e: unknown): IssueFetchReason {
  const err = (e ?? {}) as { code?: unknown; killed?: unknown; stderr?: unknown }
  const msg = String(err.stderr ?? '')
  if (err.code === 'ENOENT') return 'gh_missing'
  if (err.killed) return 'timeout'
  if (/gh auth login|not logged in|authentication/i.test(msg)) return 'gh_auth'
  if (/could not resolve to an issue|not found/i.test(msg)) return 'not_found'
  if (/remotes?.*github host|not a git repository|no git remotes/i.test(msg)) return 'not_github'
  return 'failed'
}

export function makeIssueFetcher(deps: { exec?: Exec; ghPath?: () => string | null } = {}) {
  const exec = deps.exec ?? defaultExec, ghPath = deps.ghPath ?? findGh
  return async (projectPath: string, n: number): Promise<IssueFetchResult> => {
    const gh = ghPath()
    if (!gh) return { ok: false, reason: 'gh_missing' }
    let out: string
    try { out = await exec(gh, ['issue', 'view', String(n), '--json', 'number,title,body,url,state,comments'], { cwd: projectPath, timeoutMs: TIMEOUT_MS }) }
    catch (e) { return { ok: false, reason: reasonOf(e) } }
    try {
      const v = JSON.parse(out) as Record<string, unknown>
      if (typeof v.number !== 'number' || typeof v.title !== 'string' || typeof v.url !== 'string') return { ok: false, reason: 'failed' }
      const comments = Array.isArray(v.comments) ? v.comments.flatMap(c => {
        const o = (c ?? {}) as { author?: { login?: unknown }; body?: unknown }
        return typeof o.body === 'string' ? [{ author: typeof o.author?.login === 'string' ? o.author.login : '?', body: o.body }] : []
      }) : []
      return { ok: true, issue: { number: v.number, title: v.title, body: typeof v.body === 'string' ? v.body : '', url: v.url, state: typeof v.state === 'string' ? v.state : 'OPEN', comments } }
    } catch { return { ok: false, reason: 'failed' } }
  }
}
export type IssueFetcher = ReturnType<typeof makeIssueFetcher>

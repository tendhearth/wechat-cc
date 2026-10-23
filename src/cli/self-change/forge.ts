/**
 * forge.ts —— 自改流水线跟 GitHub 打交道的那一面:开 PR、等它的 CI 再 squash 合、作废时关掉。
 *
 * 为什么自改要走 PR(设计稿 2026-10-23-cc-runs-development §6 第 3 步):以前它 rebase 完直接把 HEAD 快进推上 dev,
 * 一条改动在 GitHub 上没有任何记录 —— 人类的改动都走 PR、squash 合,只有 CC 自己的绕过去了。现在两条路是同一条:
 * 推 `self/<id>` 时开一个进 dev 的 PR(CI 只跑 PR 这一份,不再推送、PR 各跑一遍),拍板放行之后交给
 * `ci land`(src/cli/ci-land.ts)合:钉死 head、空 rollup 不算绿、网络抖退避、回应丢了先问状态、dev 被人动过就停。
 * 那些坑整合者一条条踩过,这里不再抄一份。
 *
 * 接口单独拎出来是为了 run.integration.test.ts:它的远端是本地裸仓库,没有 GitHub,塞一个「本地 squash」的假件,
 * 照样验 worktree / 分支 / 两条运行互不影响那些 git 上的事。
 */
import { runCiLand, type CiLandDeps } from '../ci-land'

export interface PrRef { number: number; url: string }

export interface Forge {
  /** 这条分支上开着的 PR;没有就开一个(重跑 / `--resume` 不重复开)。 */
  ensurePr(o: { cwd: string; branch: string; base: string; title: string; body: string }): Promise<PrRef>
  /** 按 ci land 的判法看 CI、squash 合进 base。退出码就是 CI_LAND_EXIT。 */
  land(o: { cwd: string; pr: number; base: string }): Promise<{ exitCode: number; message: string }>
  /** 作废时关掉,免得整合者的 PR 列表里躺着一条永远不会合的。失败只记一笔。 */
  close(o: { cwd: string; pr: number; comment: string }): Promise<void>
}

/** PR 标题:去掉 `[migration-edit]`(迁移闸门按标题放行,需求原文里带了也不能借道)。 */
export function prTitle(id: string, request: string): string {
  const req = request.replace(/\[migration-edit\]/gi, '').replace(/\s+/g, ' ').trim()
  return `自改 #${id}:${req.length > 60 ? `${req.slice(0, 60)}…` : req}`
}

/**
 * 真 GitHub(gh)。`makeDeps(cwd)` 给的是 ci land 那一套(gh 要在工作树里跑才认得出是哪个 repo)。
 *
 * land 传 `minChecks: 1`:ci 步已经用 `ci triage` 看过同一个 head 上一次真跑完的全绿运行,这里只要防「rollup 是空的」
 * 那一种;按缺省的 5 条,只改文档的自改会被判成「检查不够」。
 */
export function ghForge(makeDeps: (cwd: string) => CiLandDeps): Forge {
  return {
    async ensurePr(o) {
      const deps = makeDeps(o.cwd)
      const gh = (...args: string[]) => deps.exec('gh', args, { cwd: o.cwd, timeoutMs: 60_000 })
      const listed = gh('pr', 'list', '--head', o.branch, '--state', 'open', '--json', 'number,url', '--limit', '1')
      if (listed.code !== 0) throw new Error(`gh pr list 失败:${listed.stderr.trim().slice(0, 300)}`)
      const found = (JSON.parse(listed.stdout || '[]') as PrRef[])[0]
      if (found) return found
      const made = gh('pr', 'create', '--base', o.base, '--head', o.branch, '--title', o.title, '--body', o.body)
      if (made.code !== 0) throw new Error(`gh pr create 失败:${made.stderr.trim().slice(0, 300)}`)
      // gh pr create 最后一行是 PR 的链接,编号在链接尾巴上。
      const url = made.stdout.trim().split('\n').pop() ?? ''
      const n = Number(/\/pull\/(\d+)/.exec(url)?.[1])
      if (!Number.isInteger(n) || n <= 0) throw new Error(`gh pr create 回的不是 PR 链接:${url.slice(0, 200)}`)
      return { number: n, url }
    },
    async land(o) {
      const r = await runCiLand(makeDeps(o.cwd), { top: o.pr, target: o.base, minChecks: 1, timeoutMin: 60 })
      return { exitCode: r.exitCode, message: r.message }
    },
    async close(o) {
      const deps = makeDeps(o.cwd)
      const r = deps.exec('gh', ['pr', 'close', String(o.pr), '--comment', o.comment], { cwd: o.cwd, timeoutMs: 60_000 })
      if (r.code !== 0) deps.log(`[self-change] 关 PR #${o.pr} 失败(不影响作废):${r.stderr.trim().slice(0, 200)}`)
    },
  }
}

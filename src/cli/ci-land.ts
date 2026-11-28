/**
 * ci-land.ts —— `wechat-cc ci land <最上面那个 PR>`:把叠起来的一串 PR 按顺序合进 dev。
 *
 * 以前整合者每层手做四步(rebase --onto、改 base、force push、等 CI、squash 合),一串五个就是五次 20 分钟。
 * 规矩(docs/maintainer/ci-and-flakes.md「提速的边界」):上层包含下层的全部改动,只看最上面那个 PR 的 CI;
 * 绿了从下往上逐层合;PR 三平台是正式闸门,dev push 仅在 tree 相同且有成功回执时复用。这条命令就是把这套做成一步,
 * 也是 CC 以后自己合代码要用的那块。
 *
 * 每一条「停下来」都来自整合者真踩过的坑(2026-10-23):
 *   - 先记下每层的旧 head:下层 squash 合掉以后,上层要 `rebase --onto origin/dev <下层旧 head>`,而旧 head
 *     从分支名上就再也找不到了。
 *   - 钉死 head:最上面那个 PR 的 head 不再是开始时看到的那个 ⇒ 停(没看过的版本不合)。
 *     合并用 `--match-head-commit`,看完到合之间被人推了,GitHub 自己拒。
 *   - 空 rollup 不算绿:没跑的 CI 看上去和「都过了」一样(jq 的 all 对空列表是 true,差点合进一个零检查的 PR)。
 *     要求不是 skipped 的检查至少 N 条、全部 SUCCESS;任何一条红 ⇒ 停。
 *   - gh 偶尔什么都不回(网络抖)⇒ 隔一会儿再问,不当成 head 变了;连续十次 ⇒ 停(登录态没了不能死等)。
 *   - 检查不够数不当场判红:changes 先完、别的作业还没进 rollup 的那一分钟里就是这个样子。
 *   - 等 CI 期间 dev 被别人合了东西 ⇒ 停,先同步再等新 CI。
 *   - rebase 后先 bun install --frozen-lockfile 再 tsc:新 worktree 没 node_modules 是假红。
 *   - rebase 冲突 ⇒ abort,不留半截;已经合进去的几层照旧在 dev 上,报告停在哪一层。
 *   - 开始后 dev 被别人动过(不是我们刚合的那一个)⇒ 停:剩下几层的内容不再是 CI 验过的那一份。
 *   - 兄弟(两个 PR 叠在同一个下层上)⇒ 第一版不处理,停下来说清楚:先排成一条线,或者各自等 CI。
 *   - 给的那个 PR 上面还叠着别的(比如合 #598、#599 叠在它上面)⇒ **不算兄弟**,只合到给的那一层:核心链一步一部署,
 *     就是要一层层合(2026-10-23 真机:按兄弟拒了,整合者只好手合)。上面那些的 base 还指着合掉的分支,
 *     以后 `ci land <上面那个>` 按「接着上一次」那条路接上(findLandedParentOld 从 force push 事件里找起点)。
 *   - 网络抖(SSL_ERROR_SYSCALL 之类)⇒ push / 改 base / 合 退避重试三次;租约和 match-head 被拒不重试。
 *   - 跑到一半停了 ⇒ 重跑同一条命令接着来:下层 PR 已合、上层 base 还指着它的分支 ⇒ 找这一层当初叠在下层的
 *     哪个提交上(findLandedParentOld)当 rebase 起点;找不到就停,要 --parent-old;已经 rebase 推上去的那层不再 rebase。
 *   - 只在整合者自己的 detached worktree 里跑:这条命令会 checkout / rebase,不能在别人在用的工作区里。
 *
 * 合并队列(`queue`,2026-11-27 起 dev 默认):进 dev 不再要求 PR 先跟 dev 同步、等 CI 期间 dev 被合了别的也不停 ——
 * 队列把「dev + 排在前面的 + 这一个」拼起来在 merge_group 上跑三平台,绿了才快进进 dev;红了把它踢出来。
 * 这时 PR 自己的 CI 只有 Linux,不再要求三条 build。合并改成 `gh pr merge --auto`(检查过了就进队列),
 * 然后等到 MERGED;离开队列又没合 ⇒ 队列那一轮红了。叠起来的上层照旧在下层合进去后 rebase、推,`--auto` 等它的新 CI。
 */
import type { ExecResult } from './ci-triage-run'

export interface CiLandDeps {
  exec: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => ExecResult
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
  cwd: string
}

export interface CiLandOpts {
  top: number
  /** 不是 skipped 的检查至少几条才算「CI 真跑了」。只改文档的串只有 changes 一条,要显式给 1。 */
  minChecks?: number
  timeoutMin?: number
  dryRun?: boolean
  skipTypecheck?: boolean
  target?: string
  /** 接着上一次、自动找不到下层的旧 head 时手给(这一层当初叠在下层的哪个提交上)。 */
  parentOld?: string
  /** target 开着合并队列:进队列、等合,不要求跟 target 同步、不要求 PR 上三平台(见文件头)。 */
  queue?: boolean
}

/** 0 全部合完 / 1 CI 红 / 2 前提不满足或 gh 出错 / 3 head 或 dev 被人动过 / 4 rebase 冲突 / 5 等超时。 */
export const CI_LAND_EXIT = { landed: 0, red: 1, precondition: 2, moved: 3, conflict: 4, timeout: 5 } as const

export interface PrInfo {
  number: number
  state: string
  baseRefName: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
}

export interface Layer extends PrInfo {
  /** 开始时记下的 head(下层合掉以后它就从分支名上消失了)。 */
  oldHead: string
  /** 只有最下面一层可能有:它的 base 是一个**已经合掉**的 PR 的分支(上一次跑到一半停了)⇒ 那个 PR 和它最后的 head。 */
  landedParent?: { number: number; head: string }
}

export interface MergedPr { number: number; headRefName: string; headRefOid: string }

export interface RollupItem { name?: string; context?: string; status?: string; conclusion?: string; state?: string; startedAt?: string; workflowName?: string; detailsUrl?: string; completedAt?: string }

export type RollupVerdict =
  | { kind: 'green'; counted: number }
  | { kind: 'pending'; counted: number }
  | { kind: 'red'; failed: string[] }
  | { kind: 'too_few'; counted: number }

/**
 * 同一个提交上同一个作业跑过不止一次(close/reopen、改完描述重新触发、被新推送取消的旧一轮)⇒ rollup 里每一次都在。
 * 只认每个(工作流, 作业名)最新 run ID / 开始时间的那一次;没有任何排序证据的照旧都算。
 * 2026-10-27 #747:旧一轮 pr-rules 读的是改之前的描述、红了,新一轮绿了,不去重就永远合不下去。
 */
export function latestRuns(items: RollupItem[]): RollupItem[] {
  const latest = new Map<string, RollupItem>()
  const rest: RollupItem[] = []
  for (const it of items) {
    if (it.status === undefined || !it.name || (!it.startedAt && !it.completedAt && !it.detailsUrl)) { rest.push(it); continue }
    const key = `${it.workflowName ?? ''}\u0000${it.name}`
    const prev = latest.get(key)
    const order = (r: RollupItem) => r.startedAt && !r.startedAt.startsWith('0001-') ? r.startedAt : r.completedAt ?? ''
    const id = (r: RollupItem) => Number(r.detailsUrl?.match(/(?:runs|check-runs)\/(\d+)/)?.[1] ?? 0)
    if (!prev || (id(prev) && id(it) && id(prev) !== id(it) ? id(prev) < id(it) : order(prev) < order(it))) latest.set(key, it)
  }
  return [...rest, ...latest.values()]
}

/**
 * 判一份 statusCheckRollup。CheckRun 看 status/conclusion,StatusContext 看 state。
 * SKIPPED / NEUTRAL 不计数;空的或计数不够 ⇒ too_few(**永远不是 green**)。
 */
export function judgeRollup(all: RollupItem[], minChecks: number): RollupVerdict {
  const items = latestRuns(all)
  const failed: string[] = []
  let counted = 0
  let pending = false
  for (const it of items) {
    const label = it.name ?? it.context ?? '?'
    if (it.state !== undefined && it.status === undefined) {
      // StatusContext
      if (it.state === 'SUCCESS') counted++
      else if (it.state === 'PENDING' || it.state === 'EXPECTED') { counted++; pending = true }
      else failed.push(label)
      continue
    }
    if (it.status !== 'COMPLETED') { counted++; pending = true; continue }
    const c = it.conclusion ?? ''
    if (c === 'SKIPPED' || c === 'NEUTRAL') continue
    counted++
    if (c !== 'SUCCESS') failed.push(label)
  }
  if (failed.length) return { kind: 'red', failed }
  if (pending) return { kind: 'pending', counted }
  if (counted < minChecks) return { kind: 'too_few', counted }
  return { kind: 'green', counted }
}

/**
 * 从最上面那个 PR 往下走到 target(dev),返回从下到上的一串。
 * 走不到(下层不是开着的 PR)、有环、有兄弟 ⇒ 抛出说明。
 */
export function resolveStack(top: number, open: PrInfo[], target: string, merged: MergedPr[] = []): Layer[] {
  const byHead = new Map(open.map(p => [p.headRefName, p]))
  const mergedByHead = new Map(merged.map(p => [p.headRefName, p]))
  let landedParent: MergedPr | undefined
  const chain: PrInfo[] = []
  let cur = open.find(p => p.number === top)
  if (!cur) throw new Error(`#${top} 不是开着的 PR`)
  const seen = new Set<number>()
  while (cur) {
    if (seen.has(cur.number)) throw new Error(`#${cur.number} 处成环`)
    seen.add(cur.number)
    chain.unshift(cur)
    if (cur.baseRefName === target) break
    const parent = byHead.get(cur.baseRefName)
    // 接着上一次:下层已经合掉了(PR 关了,分支名还在 base 上)⇒ 这一串从这里开始,rebase 用那个 PR 最后的 head。
    if (!parent && mergedByHead.has(cur.baseRefName)) { landedParent = mergedByHead.get(cur.baseRefName); break }
    if (!parent) throw new Error(`#${cur.number} 的 base 是 ${cur.baseRefName},既不是 ${target} 也不是开着的 PR 的分支`)
    cur = parent
  }
  const inChain = new Set(chain.map(p => p.number))
  // 最上面那层上面叠着的不是兄弟(见文件头):这一次只合到它。
  for (const layer of chain.slice(0, -1)) {
    const siblings = open.filter(p => p.baseRefName === layer.headRefName && !inChain.has(p.number))
    if (siblings.length) {
      throw new Error(`#${layer.number} 上还叠着不在这一串里的 ${siblings.map(s => `#${s.number}`).join('、')}(兄弟):先排成一条线,或者让它们各自等 CI`)
    }
  }
  return chain.map((p, i) => ({ ...p, oldHead: p.headRefOid, ...(i === 0 && landedParent ? { landedParent: { number: landedParent.number, head: landedParent.headRefOid } } : {}) }))
}

const POLL_MS = 3 * 60_000
const BLIP_MS = 60_000
const DEFAULT_MIN_CHECKS = 5
const DEFAULT_TIMEOUT_MIN = 120
const NO_CHECKS_GIVE_UP_MS = 10 * 60_000
/** 一条检查都没有过了这么久 ⇒ 先说一声多半没触发(不判红,判红还是十分钟那条)。 */
const NO_CHECKS_HINT_MS = 3 * 60_000
const MAX_BLIPS = 10
/** dev 规则集唯一要求的检查(ci.yml 的汇总作业)。 */
const GATE_CHECK = 'ci · gate'
/** 进队列之后多久还没看见「在队列里 / 开了自动合并」就算没进去(GitHub 偶尔要几十秒才反映出来)。 */
const QUEUE_ENTER_GRACE_MS = 3 * 60_000
const QUEUE_POLL_MS = 60_000

export interface QueueState { state: string; headRefOid: string; isInMergeQueue: boolean; autoMerge: boolean; mergeCommit?: string; baseRefName?: string; gate?: string }

/**
 * 队列里的一个 PR 现在算什么。先核 head:合进去的不是钉住的那一版(有人换了 head 又先合了)⇒ moved,不报成功。
 * `sinceActiveMs` 从**最后一次**看见「在队列里 / 开着自动合并」算起(没看见过就从排队请求算):重组的空档里
 * 偶尔一次两个标记都读不到,不当场判被踢。
 */
export function judgeQueue(q: QueueState, head: string, sinceActiveMs: number, base?: string): 'merged' | 'waiting' | 'awaiting_checks' | 'gate_red' | 'dequeued' | 'moved' {
  if (q.headRefOid !== head) return 'moved'
  if (base && q.baseRefName && q.baseRefName !== base) return 'moved'
  if (q.state === 'MERGED') return 'merged'
  if (q.state !== 'OPEN') return 'dequeued'
  if (q.isInMergeQueue) return 'waiting'
  // 开着自动合并、还没进队列 = 在等 PR 自己的检查(叠起来的上层刚推上去)。
  if (q.autoMerge) return q.gate && q.gate !== 'PENDING' && q.gate !== 'SUCCESS' ? 'gate_red' : 'awaiting_checks'
  return sinceActiveMs < QUEUE_ENTER_GRACE_MS ? 'waiting' : 'dequeued'
}

/** target 的有效规则里有没有合并队列(`gh api repos/{o}/{r}/rules/branches/<b>` 的输出)。 */
export function hasMergeQueueRule(rulesJson: string): boolean {
  try { return (JSON.parse(rulesJson) as Array<{ type?: string }>).some(r => r.type === 'merge_queue') } catch { return false }
}
const NET_RETRIES = 3
const NET_BACKOFF_MS = [5_000, 15_000, 45_000]

/** 是不是网络层的失败(可以重试)。租约 / match-head / 冲突的拒绝都不在这里。 */
export function isNetworkError(stderr: string): boolean {
  if (/stale info|rejected|fetch first|non-fast-forward|head commit|not mergeable|conflict/i.test(stderr)) return false
  return /SSL_ERROR|SSL_connect|Could not resolve|timed? ?out|Connection (reset|refused|closed)|unexpected disconnect|early EOF|HTTP (5\d\d)|\b50[234]\b|Bad Gateway|Service Unavailable|TLS handshake/i.test(stderr)
}

export interface CiLandResult { exitCode: number; merged: number[]; message: string; /** 队列模式:最后合进去的那一层在 target 上的合入提交。 */ mergeSha?: string }

export async function runCiLand(deps: CiLandDeps, opts: CiLandOpts): Promise<CiLandResult> {
  const target = opts.target ?? 'dev'
  const minChecks = opts.minChecks ?? DEFAULT_MIN_CHECKS
  const merged: number[] = []
  const done = (exitCode: number, message: string): CiLandResult => ({ exitCode, merged, message })
  const run = (cmd: string, args: string[], timeoutMs?: number) => deps.exec(cmd, args, { cwd: deps.cwd, ...(timeoutMs ? { timeoutMs } : {}) })
  const git = (...args: string[]) => run('git', args)
  const gh = (...args: string[]) => run('gh', args)
  const lastLine = (r: ExecResult) => r.stderr.trim().split('\n').pop() ?? ''
  // 网络抖(这台机器上 git push / gh 一小时能撞两次 SSL_ERROR_SYSCALL)⇒ 退避重试三次;租约 / match-head 被拒是真「动过」,不重试。
  const net = async (fn: () => ExecResult): Promise<ExecResult> => {
    let r = fn()
    for (let i = 0; i < NET_RETRIES && r.code !== 0 && isNetworkError(r.stderr); i++) {
      deps.log(`网络抖了(${lastLine(r)}),${NET_BACKOFF_MS[i]! / 1000}s 后重试`)
      await deps.sleep(NET_BACKOFF_MS[i]!)
      r = fn()
    }
    return r
  }
  const isAncestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).code === 0
  /**
   * 接着上一次时,最下面那层的 rebase 起点 = 它**当初叠在**下层的哪个提交上。下层合之前常被 rebase 过(整合者、
   * 或者上一次 ci land 自己),它最后的 head 就不是这一层的祖先了;靠补丁相同让 git 丢旧提交也不稳 —— 下层 rebase 时
   * 解过冲突补丁就变了(#617)。所以按顺序找第一个**是这一层祖先**的:手给的 → 下层最后的 head → 下层每次被
   * force push 之前的 head(GraphQL 的 HeadRefForcePushedEvent.beforeCommit,REST 的事件不带 before)。
   */
  const findLandedParentOld = (layer: Layer): string | undefined => {
    const lp = layer.landedParent!
    const befores = ghJson<string[]>('api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `n=${lp.number}`,
      '-f', 'query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],last:50){nodes{... on HeadRefForcePushedEvent{beforeCommit{oid}}}}}}}',
      '-q', '[.data.repository.pullRequest.timelineItems.nodes[].beforeCommit.oid]') ?? []
    const candidates = [opts.parentOld, lp.head, ...[...befores].reverse()].filter((c): c is string => !!c)
    return candidates.find(c => isAncestor(c, layer.oldHead))
  }
  /**
   * 合并**不能**盲重试:网络错常常是请求到了、合了,只是回应丢了;再合一次回「already merged / not mergeable」,
   * 不像网络错 ⇒ 会被报成「动过」,其实已经合了。所以每次失败先问一句状态:MERGED 就算合成(合进去的是不是我们
   * 要的那一个,后面 `origin/dev^ == devBefore` 那道照样查)。
   */
  const mergeLayer = async (n: number, head: string): Promise<ExecResult> => {
    const isMerged = () => ghJson<{ state: string }>('pr', 'view', String(n), '--json', 'state')?.state === 'MERGED'
    let r = gh('pr', 'merge', String(n), '--squash', '--match-head-commit', head)
    for (let i = 0; r.code !== 0; i++) {
      if (isMerged()) { deps.log(`#${n} 回应丢了,但其实已经合了`); return { code: 0, stdout: '', stderr: '' } }
      if (i >= NET_RETRIES || !isNetworkError(r.stderr)) break
      deps.log(`网络抖了(${lastLine(r)}),${NET_BACKOFF_MS[i]! / 1000}s 后重试`)
      await deps.sleep(NET_BACKOFF_MS[i]!)
      r = gh('pr', 'merge', String(n), '--squash', '--match-head-commit', head)
    }
    return r
  }
  const ghJson = <T>(...args: string[]): T | null => {
    const r = gh(...args)
    if (r.code !== 0 || !r.stdout.trim()) return null
    try { return JSON.parse(r.stdout) as T } catch { return null }
  }

  // ── 前提:detached、干净 ───────────────────────────────────────────
  if (!opts.dryRun) {
    if (git('symbolic-ref', '-q', 'HEAD').code === 0) {
      return done(CI_LAND_EXIT.precondition, '要在整合者自己的 detached worktree 里跑(这条命令会 checkout / rebase):git worktree add --detach <路径> origin/dev')
    }
    if (git('status', '--porcelain').stdout.trim()) return done(CI_LAND_EXIT.precondition, '工作区有未提交的改动,先处理干净')
  }

  // ── 认出这一串,记下每层旧 head ───────────────────────────────────
  const open = ghJson<PrInfo[]>('pr', 'list', '--state', 'open', '--limit', '300', '--json', 'number,state,baseRefName,headRefName,headRefOid,isDraft')
  if (!open) return done(CI_LAND_EXIT.precondition, 'gh pr list 失败(登录态?网络?)')
  const mergedList = await net(() => gh('pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,headRefName,headRefOid'))
  if (mergedList.code !== 0) return done(CI_LAND_EXIT.precondition, `gh pr list --state merged 失败:${lastLine(mergedList)}`)
  let mergedPrs: MergedPr[]
  try { mergedPrs = JSON.parse(mergedList.stdout || '[]') as MergedPr[] } catch { return done(CI_LAND_EXIT.precondition, 'gh pr list --state merged 回的不是 JSON') }
  let stack: Layer[]
  try { stack = resolveStack(opts.top, open, target, mergedPrs) } catch (e) { return done(CI_LAND_EXIT.precondition, (e as Error).message) }
  const topLayer = stack[stack.length - 1]!
  deps.log(`这一串(从下到上):${stack.map(l => `#${l.number} ${l.headRefName}@${l.oldHead.slice(0, 8)}`).join(' → ')}`)
  const above = open.filter(p => p.baseRefName === topLayer.headRefName)
  if (above.length) deps.log(`#${topLayer.number} 上面还叠着 ${above.map(p => `#${p.number}`).join('、')}:这次只合到 #${topLayer.number};它们以后 ci land 接着来`)
  if (opts.dryRun) {
    const lp = stack[0]!.landedParent
    const resume = lp ? `最下层 #${stack[0]!.number} 叠在已合的 #${lp.number} 上:先 rebase 到 ${target} 推上去,` : ''
    return done(CI_LAND_EXIT.landed, `预演:${resume}会等 #${topLayer.number} 的 CI(至少 ${minChecks} 条非 skipped 全绿),然后从下往上合 ${stack.length} 层`)
  }

  /**
   * 把第 i 层放到 `onto` 上(缺省 dev):rebase --onto(起点 = 下层旧 head;最下层叠在已合 PR 上时自己找)→ install + tsc
   * → 带租约推 → 放到 dev 上时改 base。回新 head;停下来就回结果。
   */
  const seat = async (i: number, onto = `origin/${target}`): Promise<{ head: string } | { result: CiLandResult }> => {
    const layer = stack[i]!
    const fail = (code: number, message: string) => ({ result: done(code, message) })
    if (git('checkout', '-q', '--detach', layer.oldHead).code !== 0) return fail(CI_LAND_EXIT.precondition, `checkout ${layer.oldHead.slice(0, 8)} 失败`)
    // 上一次已经 rebase 并推上去了(停在改 base / 合那一步)⇒ 已经在 dev 上,不再 rebase。
    const alreadyOnTarget = git('merge-base', '--is-ancestor', onto, 'HEAD').code === 0
    let parentOld = i > 0 ? stack[i - 1]!.oldHead : undefined
    if (!alreadyOnTarget && !parentOld) {
      parentOld = findLandedParentOld(layer)
      if (!parentOld) {
        return fail(CI_LAND_EXIT.precondition, `#${layer.number} 叠在已合的 #${layer.landedParent!.number} 上,但找不到它当初叠在哪个提交上(下层合之前被 rebase 过、事件里也没有):用 --parent-old <sha> 给出来`)
      }
    }
    const rb = alreadyOnTarget ? { code: 0 } : git('rebase', '--onto', onto, parentOld!)
    if (rb.code !== 0) {
      git('rebase', '--abort')
      return fail(CI_LAND_EXIT.conflict, `#${layer.number} rebase 到 ${target} 冲突,已 abort;前面 ${merged.length} 层已合(${merged.map(n => `#${n}`).join('、') || '无'}),这一层交还负责人`)
    }
    if (!opts.skipTypecheck) {
      // 新建的 worktree 没有 node_modules、下层改过 bun.lock ⇒ 不装就是跟代码无关的假红。装好了的话这一步几秒。
      if (run('bun', ['install', '--frozen-lockfile'], 10 * 60_000).code !== 0) return fail(CI_LAND_EXIT.precondition, `#${layer.number} rebase 后 bun install 失败(没推)`)
      const tc = run('bun', ['x', 'tsc', '--noEmit'], 20 * 60_000)
      if (tc.code !== 0) return fail(CI_LAND_EXIT.red, `#${layer.number} rebase 后 typecheck 红(没推);前面已合 ${merged.map(n => `#${n}`).join('、') || '无'}`)
    }
    const head = git('rev-parse', 'HEAD').stdout.trim()
    if (head !== layer.oldHead) {
      // --no-verify:重放的这一层推上去之后,下面照样等它的 CI 全绿才合;本机 pre-push 钩子(scripts/verify-stamp.ts)认的是
      // 「这份内容本机跑过 verify」,rebase 出来的新树必然没跑过 ⇒ 不绕过就合不下去(2026-10-27 #739 就这么卡住)。
      const push = await net(() => git('push', '--no-verify', `--force-with-lease=${layer.headRefName}:${layer.oldHead}`, 'origin', `HEAD:refs/heads/${layer.headRefName}`))
      if (push.code !== 0) return fail(CI_LAND_EXIT.moved, `#${layer.number} 推不上去(分支被人动过?):${lastLine(push)}`)
    }
    const edit = onto === `origin/${target}` ? await net(() => gh('pr', 'edit', String(layer.number), '--base', target)) : { code: 0, stdout: '', stderr: '' }
    if (edit.code !== 0) return fail(CI_LAND_EXIT.precondition, `#${layer.number} 改 base 失败:${lastLine(edit)}(重跑 ci land ${opts.top} 接着来)`)
    if (opts.queue && onto === `origin/${target}`) {
      // 推送那一轮可能还是按旧 base 跑的,改 base 本身又不触发新一轮(pull_request 缺省不含 edited)⇒ 关了再开,
      // 让 ci · gate 对着「这个 head + dev」跑一遍,--auto 等的就是它。先推后改 base:推失败时 base 没动,重跑照旧能接上(#1119 复审)。
      const closed = (await net(() => gh('pr', 'close', String(layer.number)))).code === 0
      const reopened = closed && (await net(() => gh('pr', 'reopen', String(layer.number)))).code === 0
      if (!reopened) return fail(CI_LAND_EXIT.precondition, `#${layer.number} 改 base 后重触发 CI 没成${closed ? '(关了没开回来,PR 现在是关着的:gh pr reopen ' + layer.number + ')' : ''}:重跑 ci land ${opts.top} 接着来`)
    }
    return { head }
  }

  if (opts.queue) {
    // 队列关着时 gh pr merge --auto 会走普通自动合并、甚至在非交互下要你选合并方式 —— 不猜,先核规则;
    // 放在任何远端写(接着来的 rebase / 推 / 改 base)之前。
    const rules = await net(() => gh('api', `repos/{owner}/{repo}/rules/branches/${target}`))
    if (rules.code !== 0) return done(CI_LAND_EXIT.precondition, `查 ${target} 的规则失败:${lastLine(rules)}`)
    if (!hasMergeQueueRule(rules.stdout)) return done(CI_LAND_EXIT.precondition, `${target} 没开合并队列:用 --direct 照老办法合(那时 PR 要三平台:仓库变量 MERGE_QUEUE 也要关掉)`)
  }

  // ── 接着上一次:最下层叠在已合 PR 上 ⇒ 先把整串从下往上重新放好、推上去,再等最上面那个的**新** CI ──────────
  // 不先放:最上面那个的 CI 是对着旧下层分支跑的(或者根本没跑:base 不是 dev 时推的),合进去的却是 rebase 后
  // 没人验过的那一份(整合者评审 #624)。只放最下层不够:推下层分支不会让上层 PR 重跑 CI。
  // 放好以后这一串就是一条普通的串(最下层 base 是 dev、各层旧 head = 刚推上去的),后面照常走。
  if (stack[0]!.landedParent) {
    if (git('fetch', 'origin', target).code !== 0) return done(CI_LAND_EXIT.precondition, `git fetch origin ${target} 失败`)
    const heads: string[] = []
    for (let i = 0; i < stack.length; i++) {
      const r = await seat(i, i === 0 ? `origin/${target}` : heads[i - 1]!)
      if ('result' in r) return r.result
      heads.push(r.head)
    }
    stack = stack.map((l, i) => ({ ...l, oldHead: heads[i]!, ...(i === 0 ? { baseRefName: target, landedParent: undefined } : {}) }))
    deps.log(`接着来:整串已重新放到 ${target} 上(${stack.map(l => `#${l.number}@${l.oldHead.slice(0, 8)}`).join(' → ')}),等 #${stack[stack.length - 1]!.number} 的新 CI`)
  }
  const pinnedTop = stack[stack.length - 1]!.oldHead

  /** 队列那条路:从下往上,每层 `--auto` 进队列、等它合;上层先放到 dev 上再进。 */
  const queueState = (n: number): QueueState | null => {
    type GateNode = { name?: string; conclusion?: string; status?: string } | null
    const q = ghJson<{ data?: { repository?: { pullRequest?: { state: string; headRefOid: string; baseRefName: string; isInMergeQueue: boolean; autoMergeRequest: unknown; mergeCommit: { oid: string } | null; commits?: { nodes?: Array<{ commit?: { oid: string; statusCheckRollup?: { contexts?: { nodes?: GateNode[] } } | null } }> } } } } }>(
      'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `n=${n}`,
      '-f', 'query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){state headRefOid baseRefName isInMergeQueue autoMergeRequest{enabledAt} mergeCommit{oid} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name conclusion status}}}}}}}}}}')
    const pr = q?.data?.repository?.pullRequest
    if (!pr) return null
    // 只看必过的那一条(ci · gate),而且是这个 head 上的:别的检查红了不挡队列,不能据此报红(#1119 复审)。
    const last = pr.commits?.nodes?.[0]?.commit
    const gateRun = last?.oid === pr.headRefOid ? (last.statusCheckRollup?.contexts?.nodes ?? []).filter(c => c?.name === GATE_CHECK).pop() : undefined
    const gate = gateRun ? (gateRun.status === 'COMPLETED' ? gateRun.conclusion ?? '' : 'PENDING') : undefined
    return { state: pr.state, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName, isInMergeQueue: pr.isInMergeQueue, autoMerge: !!pr.autoMergeRequest,
      ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit.oid } : {}), ...(gate !== undefined ? { gate } : {}) }
  }
  const landThroughQueue = async (): Promise<CiLandResult> => {
    let last = ''
    for (let i = 0; i < stack.length; i++) {
      const layer = stack[i]!
      let head = layer.oldHead
      if (i > 0) {
        if (git('fetch', 'origin', target).code !== 0) return done(CI_LAND_EXIT.precondition, `git fetch origin ${target} 失败(已合 ${merged.map(n => `#${n}`).join('、')})`)
        const r = await seat(i)
        if ('result' in r) return r.result
        head = r.head
      }
      if (layer.isDraft) {
        const ready = await net(() => gh('pr', 'ready', String(layer.number)))
        if (ready.code !== 0) return done(CI_LAND_EXIT.precondition, `#${layer.number} 标 ready 失败:${lastLine(ready)}(重跑 ci land ${opts.top} 接着来)`)
      }
      // 已经在队列里 / 已开自动合并(上一次回应丢了、或上一次等超时了)⇒ 直接接着等,不再请求一次(gh 会报 already in queue)。
      const before = queueState(layer.number)
      const active = (q: QueueState | null) => !!q && q.headRefOid === head && (q.state === 'MERGED' || q.isInMergeQueue || q.autoMerge)
      if (!active(before)) {
        const enq = await net(() => gh('pr', 'merge', String(layer.number), '--auto', '--match-head-commit', head))
        if (enq.code !== 0 && !active(queueState(layer.number))) {
          return done(CI_LAND_EXIT.moved, `#${layer.number} 进不了合并队列:${lastLine(enq)}(重跑 ci land ${opts.top} 接着来)`)
        }
        deps.log(`#${layer.number} 已排进 ${target} 的合并队列(PR 自己的检查过了就进),等它合`)
      } else deps.log(`#${layer.number} 已经在队列里 / 开着自动合并,接着等`)
      let lastActive = deps.now()
      let missingMerge = 0
      for (;;) {
        const q = queueState(layer.number)
        if (deps.now() > deadline && !(q && q.state === 'MERGED')) {
          const where = q?.isInMergeQueue ? '还在合并队列里' : q?.autoMerge ? '开着自动合并、在等 PR 自己的检查' : '不在队列里'
          return done(CI_LAND_EXIT.timeout, `等 #${layer.number} 合进去超时:它${where}${q?.isInMergeQueue || q?.autoMerge ? ',GitHub 之后仍可能把它合进去(gh pr view ' + layer.number + ' 看)' : ''};已合 ${merged.map(n => `#${n}`).join('、') || '无'}`)
        }
        if (!q) {
          if (++blips >= MAX_BLIPS) return done(CI_LAND_EXIT.precondition, `gh 连续 ${blips} 次没回东西(登录态?限流?)`)
          await deps.sleep(BLIP_MS); continue
        }
        blips = 0
        if (q.isInMergeQueue || q.autoMerge) lastActive = deps.now()
        const v = judgeQueue(q, head, deps.now() - lastActive, target)
        if (v === 'merged') {
          // 合入提交偶尔晚几秒才在 API 里出现:再问几次,拿不到就照实说(自改拿不到它就不部署)。
          if (!q.mergeCommit && ++missingMerge < 5) { await deps.sleep(BLIP_MS); continue }
          last = q.mergeCommit ?? ''; break
        }
        if (v === 'moved') return done(CI_LAND_EXIT.moved, q.headRefOid !== head
          ? `#${layer.number} 的 head 不是钉住的那一版(${head.slice(0, 8)} → ${q.headRefOid.slice(0, 8)})${q.state === 'MERGED' ? ',而且已经被合进去了 —— 合进去的不是这次看过的版本,人看一眼' : ':没看过的版本不合,重新跑一次'}`
          : `#${layer.number} 的 base 变成了 ${q.baseRefName}(不是 ${target}):重新跑一次`)
        if (v === 'dequeued') return done(CI_LAND_EXIT.red, `#${layer.number} 离开了合并队列却没合:多半是队列那一轮(三平台)红了,也可能和排在前面的冲突、或被人移出。看 gh pr view ${layer.number} 的时间线和 Actions 里 merge_group 那一轮`)
        if (v === 'gate_red') return done(CI_LAND_EXIT.red, `#${layer.number} 自己的 ${GATE_CHECK} 红了(${q.gate}):进不了队列。自动合并还开着,修好推上去会自己进;不要了就 gh pr merge ${layer.number} --disable-auto。看是不是 flake:wechat-cc ci triage --sha ${head}`)
        await deps.sleep(QUEUE_POLL_MS)
      }
      merged.push(layer.number)
      deps.log(`#${layer.number} 已合${last ? `(${last.slice(0, 8)})` : ''}`)
    }
    // 队列可能一次快进好几个 PR:这一层的合入提交不一定是 dev 推送的那一个。triage 看现在的顶端。
    const tip = git('fetch', 'origin', target).code === 0 ? git('rev-parse', `origin/${target}`).stdout.trim() : ''
    const r = done(CI_LAND_EXIT.landed, `合完 ${merged.length} 层(经合并队列):${merged.map(n => `#${n}`).join(' → ')}${last ? `,最后一层合入 ${last.slice(0, 8)}` : ''}。${target} 推送应由队列那一轮的 tree 回执覆盖:wechat-cc ci triage --wait --rerun --sha ${tip || `origin/${target}`}`)
    return last ? { ...r, mergeSha: last } : r
  }

  // ── 等最上面那个的 CI ───────────────────────────────────────────
  const deadline = deps.now() + (opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000
  if (git('fetch', 'origin', target).code !== 0) return done(CI_LAND_EXIT.precondition, `git fetch origin ${target} 失败`)
  const devAtStart = git('rev-parse', `origin/${target}`).stdout.trim()
  if (!opts.queue && !isAncestor(devAtStart, stack[0]!.oldHead)) {
    return done(CI_LAND_EXIT.precondition, `#${stack[0]!.number} 落后 ${target}:先 rebase 到 origin/${target} 并推送,再运行 ci land 等新 CI`)
  }
  let blips = 0
  // too_few 不当场判红:changes 十秒就完,依赖它的作业要再过几秒到一分钟才进 rollup,
  // 那个空档里看到的是「一条 SUCCESS、没有在跑的」。rollup 十分钟没变化、还是不够数,才判。
  let lastSig = ''
  let sigSince = deps.now()
  const waitStart = deps.now()
  let hinted = false
  // 改了 base 紧接着 force push(或者反过来),GitHub 有时一条运行都不建(2026-10-23 #599):别安静地等,说怎么重触发。
  const reopenHint = `gh pr close ${topLayer.number} && gh pr reopen ${topLayer.number}(重触发 pull_request,head 不变)`
  for (;;) {
    if (deps.now() > deadline) return done(CI_LAND_EXIT.timeout, `等 #${topLayer.number} 的 CI 超时`)
    const v = ghJson<{ headRefOid: string; statusCheckRollup: RollupItem[] | null }>('pr', 'view', String(topLayer.number), '--json', 'headRefOid,statusCheckRollup')
    if (!v) {
      if (++blips >= MAX_BLIPS) return done(CI_LAND_EXIT.precondition, `gh 连续 ${blips} 次没回东西(登录态?限流?)`)
      deps.log('gh 没回东西,一分钟后再问')
      await deps.sleep(BLIP_MS)
      continue
    }
    blips = 0
    if (v.headRefOid !== pinnedTop) return done(CI_LAND_EXIT.moved, `#${topLayer.number} 的 head 变了(${pinnedTop.slice(0, 8)} → ${v.headRefOid.slice(0, 8)}):没看过的版本不合,重新跑一次`)
    let verdict = judgeRollup(v.statusCheckRollup ?? [], minChecks)
    if (verdict.kind === 'green' && minChecks > 1 && !opts.queue) {
      const checks = latestRuns(v.statusCheckRollup ?? [])
      const platforms = ['ubuntu-latest', 'macos-latest', 'windows-latest']
      if (!platforms.every(os => checks.some(c => c.name === `build · ${os}` && c.conclusion === 'SUCCESS'))) {
        verdict = { kind: 'too_few', counted: verdict.counted }
      }
    }
    if (verdict.kind === 'red') return done(CI_LAND_EXIT.red, `#${topLayer.number} 的 CI 红了:${verdict.failed.join('、')}(看是不是 flake:wechat-cc ci triage --sha ${pinnedTop})`)
    if (verdict.kind === 'green') { deps.log(`#${topLayer.number} 的 CI 绿了(${verdict.counted} 条)`); break }
    const sig = JSON.stringify(v.statusCheckRollup ?? [])
    if (sig !== lastSig) { lastSig = sig; sigSince = deps.now() }
    if (verdict.kind === 'too_few' && verdict.counted === 0 && !hinted && deps.now() - waitStart >= NO_CHECKS_HINT_MS) {
      hinted = true
      // 自己关了再开一次(只一次):10-24 #600 又碰上,整合者照着提示手敲的就是这两条,head 不变、租约照旧。
      // 关不掉 / 开不回来 ⇒ 退回只说怎么做(开不回来尤其要说:PR 停在关着)。
      const closed = gh('pr', 'close', String(topLayer.number)).code === 0
      const reopened = closed && gh('pr', 'reopen', String(topLayer.number)).code === 0
      if (reopened) {
        deps.log(`#${topLayer.number} 的 head ${pinnedTop.slice(0, 8)} ${Math.round(NO_CHECKS_HINT_MS / 60_000)} 分钟了一条检查都没有:多半没触发 CI,已关了再开一次重触发,接着等`)
        sigSince = deps.now()
      } else {
        deps.log(`#${topLayer.number} 的 head ${pinnedTop.slice(0, 8)} ${Math.round(NO_CHECKS_HINT_MS / 60_000)} 分钟了一条检查都没有:多半没触发 CI。自动重触发没成${closed ? '(关了没开回来,PR 现在是关着的)' : ''}:${reopenHint}`)
      }
    }
    if (verdict.kind === 'too_few' && deps.now() - sigSince > NO_CHECKS_GIVE_UP_MS) {
      // 十分钟还是空 ⇒ CI 根本没触发(比如 pull_request 的 base 过滤);不空但不够数 ⇒ 多半是只改文档的串。
      return done(CI_LAND_EXIT.red, verdict.counted === 0
        ? `#${topLayer.number} 十分钟了一条检查都没有:CI 没触发,不能当绿。${reopenHint},然后重跑 ci land`
        : `#${topLayer.number} 只跑了 ${verdict.counted} 条非 skipped 检查(要 ${minChecks}):必须有三平台 build 全绿;只改文档的串用 --min-checks 1`)
    }
    deps.log(`#${topLayer.number} 的 CI 还在跑(${verdict.kind === 'pending' ? verdict.counted : 0} 条),${POLL_MS / 60_000} 分钟后再看`)
    await deps.sleep(POLL_MS)
  }

  if (opts.queue) return await landThroughQueue()

  // ── 从下往上合 ─────────────────────────────────────────────────
  if (git('fetch', 'origin', target).code !== 0) return done(CI_LAND_EXIT.precondition, `git fetch origin ${target} 失败`)
  let devBefore = git('rev-parse', `origin/${target}`).stdout.trim()
  if (devBefore !== devAtStart) {
    return done(CI_LAND_EXIT.moved, `${target} 在等待 CI 期间变了:先同步分支并等待新 PR CI,再合入`)
  }
  for (let i = 0; i < stack.length; i++) {
    const layer = stack[i]!
    let head = layer.oldHead
    if (i > 0) {
      const r = await seat(i)
      if ('result' in r) return r.result
      head = r.head
    }
    if (layer.isDraft) {
      const ready = await net(() => gh('pr', 'ready', String(layer.number)))
      if (ready.code !== 0) return done(CI_LAND_EXIT.precondition, `#${layer.number} 标 ready 失败:${lastLine(ready)}(重跑 ci land ${opts.top} 接着来)`)
    }
    const m = await mergeLayer(layer.number, head)
    if (m.code !== 0) return done(CI_LAND_EXIT.moved, `#${layer.number} 合不进去:${lastLine(m)}(重跑 ci land ${opts.top} 接着来)`)
    merged.push(layer.number)
    deps.log(`#${layer.number} 已合`)
    if (git('fetch', 'origin', target).code !== 0) return done(CI_LAND_EXIT.precondition, `git fetch origin ${target} 失败(已合 ${merged.map(n => `#${n}`).join('、')})`)
    const devNow = git('rev-parse', `origin/${target}`).stdout.trim()
    const parentOfNew = git('rev-parse', `origin/${target}^`).stdout.trim()
    if (parentOfNew !== devBefore) {
      return done(CI_LAND_EXIT.moved, `${target} 在这期间被别人动过(不止我们合的那一个):剩下几层不再是 CI 验过的那一份,各自走 CI。已合 ${merged.map(n => `#${n}`).join('、')}`)
    }
    devBefore = devNow
  }
  return done(CI_LAND_EXIT.landed, `合完 ${merged.length} 层:${merged.map(n => `#${n}`).join(' → ')}。接着确认 ${target} 推送的 tree 覆盖(未覆盖才完整 CI):wechat-cc ci triage --wait --rerun --sha ${devBefore}`)
}

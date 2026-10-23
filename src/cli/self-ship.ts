/**
 * self-ship.ts —— `wechat-cc self ship`:一批合进 dev 之后的那道部署门,一条命令走完。
 *
 * 以前整合者手做四步(build-sidecar → self deploy → selftest workbench → selftest chat),再隔一天看日志;
 * 中间两条规矩只活在笔记里:主人在用机器(负载高)别跑重活 —— 满载下的自检超时会被当成真红、白白回滚;
 * 调模型之前先看网络守护 —— 自检要打官方端点,直连会封号。设计稿 2026-10-23-cc-runs-development §6 第 4 步把它们
 * 收成一道门,顺序就是它们该被检查的顺序:**什么都还没动的时候**先问能不能动。
 *
 *   0. 装的是哪棵树:工作区有未提交的改动 ⇒ 退 6;HEAD 不是 origin/dev ⇒ 退 6(`--allow-off-dev` 放行,照实打出来)。
 *      不查的话,脏树或一条功能分支也能装上去,soak 会把它的版本当成 dev 报(整合者评审 #638)。
 *      自改不走这里:它的工作树合完就钉在 origin/dev 上,deploy 步自己断言。
 *   1. 负载:1 分钟负载 / 核数 > 上限(缺省 1.0)⇒ 每分钟再看,`--wait-min` 到了还高 ⇒ 退 3,什么都没动。
 *   2. 网络守护:读不到、或开着但不安全 ⇒ 退 5。放在构建之前:部署完才发现自检跑不了,只能回滚。
 *   3. 构建 sidecar(源码模式,apps/desktop 的 build-sidecar)⇒ 红退 4。
 *   4. self deploy(换 inode、重启、健康门;它自己红了自己回滚)⇒ 红退 1。
 *   5. 自检(工作台 + 对话,跟自改同一套、同一份配置)⇒ 红 ⇒ 回滚到 .prev,退 2。
 *   6. 绿 ⇒ 退 0,并说下一步:`wechat-cc self soak`(稳不稳看信号,不在这里死等几个小时)。
 *
 * 负载只是「这台机器此刻给不给得出公正的判决」,不是「主人在不在」—— 主人在、机器闲,照样部署。
 */
import type { SelfDeployResult } from './self-deploy'
import type { SelftestReport } from './selftest'

export interface MachineLoad { load1: number; cpus: number }

/** 要装的那棵树。`devHead` = 刚 fetch 过的 origin/dev;null = 取不到。 */
export interface ShipTree { dirty: string; head: string; devHead: string | null }

export interface ShipDeps {
  tree: () => ShipTree
  load: () => MachineLoad
  /** /v1/health.guard;null = 读不到。 */
  guard: () => Promise<{ enabled: boolean; safe: boolean; detail: string } | null>
  build: () => Promise<{ ok: boolean; detail: string }>
  deploy: (mode: 'deploy' | 'rollback') => Promise<SelfDeployResult>
  selftest: () => Promise<{ workbench: SelftestReport; chat: SelftestReport }>
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
}

export interface ShipOpts {
  /** 负载高时最多等几分钟;0 = 不等。 */
  waitMin?: number
  /** 1 分钟负载 / 核数的上限。 */
  maxLoadPerCpu?: number
  skipBuild?: boolean
  /** HEAD 不是 origin/dev 也装(试一条分支)。脏树永远不装。 */
  allowOffDev?: boolean
}

export const SHIP_EXIT = { shipped: 0, deploy_failed: 1, selftest_red: 2, busy: 3, build_failed: 4, unguarded: 5, tree_unfit: 6 } as const

export interface ShipResult { exitCode: number; message: string; version?: string }

export const DEFAULT_MAX_LOAD_PER_CPU = 1.0
const LOAD_POLL_MS = 60_000

/** 负载门:回 null = 可以动;否则回一句为什么不动。自改的 deploy 步也用它。 */
export async function waitForQuietMachine(
  deps: Pick<ShipDeps, 'load' | 'sleep' | 'now' | 'log'>,
  opts: { waitMin: number; maxLoadPerCpu: number },
): Promise<string | null> {
  const deadline = deps.now() + opts.waitMin * 60_000
  for (;;) {
    const { load1, cpus } = deps.load()
    const ratio = load1 / Math.max(1, cpus)
    if (ratio <= opts.maxLoadPerCpu) return null
    const why = `机器正忙:1 分钟负载 ${load1.toFixed(1)} / ${cpus} 核 = ${ratio.toFixed(2)}(上限 ${opts.maxLoadPerCpu})`
    if (deps.now() >= deadline) return `${why}。满载下的自检超时会被当成真红、白白回滚 —— 等机器闲了再来`
    deps.log(`${why},一分钟后再看`)
    await deps.sleep(LOAD_POLL_MS)
  }
}

function failedChecks(r: SelftestReport): string {
  const bad = r.checks.filter(c => !c.ok).map(c => c.name)
  return `${r.kind}(${r.target})${bad.length ? `:${bad.join('、')}` : ''}`
}

export async function runShip(deps: ShipDeps, opts: ShipOpts = {}): Promise<ShipResult> {
  const tree = deps.tree()
  if (tree.dirty.trim()) {
    const files = tree.dirty.trim().split('\n').slice(0, 10).join('\n')
    return { exitCode: SHIP_EXIT.tree_unfit, message: `工作区有未提交的改动,不装(装上去的就不是任何一个提交了):\n${files}\n什么都没动。` }
  }
  const short = (sha: string | null) => (sha ? sha.slice(0, 8) : '(取不到)')
  if (tree.head !== tree.devHead) {
    const where = `HEAD ${short(tree.head)},origin/dev ${short(tree.devHead)}`
    if (!opts.allowOffDev) return { exitCode: SHIP_EXIT.tree_unfit, message: `要装的不是 origin/dev(${where}):soak 会把它当 dev 报。真要试一条分支加 --allow-off-dev。什么都没动。` }
    deps.log(`注意:装的不是 origin/dev(${where}),按 --allow-off-dev 照装`)
  }

  const busy = await waitForQuietMachine(deps, { waitMin: opts.waitMin ?? 0, maxLoadPerCpu: opts.maxLoadPerCpu ?? DEFAULT_MAX_LOAD_PER_CPU })
  if (busy) return { exitCode: SHIP_EXIT.busy, message: `${busy}。什么都没动。` }

  const g = await deps.guard().catch(() => null)
  if (!g || (g.enabled && !g.safe)) {
    const why = !g ? '读不到网络守护的状态(daemon 不通?)' : `网络守护说现在不安全:${g.detail}`
    return { exitCode: SHIP_EXIT.unguarded, message: `${why}。自检要调模型,不部署(部署完跑不了自检只能回滚)。什么都没动。` }
  }

  if (!opts.skipBuild) {
    deps.log('构建 sidecar…')
    const b = await deps.build()
    if (!b.ok) return { exitCode: SHIP_EXIT.build_failed, message: `构建 sidecar 失败,没部署:\n${b.detail}` }
  }

  deps.log('部署…')
  const d = await deps.deploy('deploy')
  if (!d.ok) {
    const steps = d.steps.filter(s => !s.ok).map(s => `- ${s.name}: ${s.detail ?? ''}`).join('\n')
    return { exitCode: SHIP_EXIT.deploy_failed, message: `self deploy 没过${d.rolledBack ? '(已自动回滚)' : ''}:\n${[d.diagnostics ?? '', steps].filter(Boolean).join('\n')}` }
  }

  deps.log(`已部署 ${d.version ?? ''},跑自检…`)
  const t = await deps.selftest()
  if (!t.workbench.ok || !t.chat.ok) {
    const red = [t.workbench, t.chat].filter(r => !r.ok).map(failedChecks).join(';')
    const rb = await deps.deploy('rollback')
    return {
      exitCode: SHIP_EXIT.selftest_red,
      message: rb.ok
        ? `自检红了(${red}),已回滚到上一版。dev 上的代码没动,要人看。`
        : `自检红了(${red}),**回滚也没成**:机器上跑的还是新版,要人马上看。\n${rb.diagnostics ?? ''}`,
    }
  }

  return {
    exitCode: SHIP_EXIT.shipped,
    ...(d.version ? { version: d.version } : {}),
    message: `已部署 ${d.version ?? ''},自检两条全绿。稳不稳看信号:过几个小时 wechat-cc self soak(改到开机 / 关机顺序的加 --min-restarts 1)。`,
  }
}

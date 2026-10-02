/**
 * abandon.ts —— 「这条我不接了」(`self change --abandon <id>`)和 `--list` 的分类。
 *
 * 为什么要有这个动作:顺手清理(steps.ts 的 sweepWorktrees)只敢扫 `done` /
 * `declined` 两种**不可恢复的终局** —— 别的失败码都还能 `--resume`,被 kill 掉的
 * 运行 `result` 永远是 null,扫了就把一轮付过钱的实现扔了。于是这些树永不回收,
 * `<workdir>/runs` 单调增长。缺的是一个**人说了算**的出口:主人明说不接了,
 * 这条就变成和 `declined` 一样的终局(`abandoned`),树当场删掉。
 *
 * 删法和顺手清理**完全一样**:中枢里先 `worktree prune`,再
 * `worktree remove --force <workdir>/runs/<id>`。分支 `self/<id>` 不删 —— 顺手清理
 * 也不删;提交留在中枢里不占多少盘,真要扔由人 `branch -D`。
 *
 * 门:**正在跑的那条绝不能作废**(等于从它脚底下把树抽走)。「在跑」认的是
 * 「一次只跑一条」那把锁:拿得到锁 ⇒ 没人在跑,在锁里作废(和 `--resume` 互斥);
 * 拿不到 ⇒ 看锁里记的 runId —— 是这条、或者老格式的锁没记(分不清)⇒ 拒绝;
 * 是别的一条 ⇒ 照样作废,因为这条要恢复也得先拿到那把锁。
 */
import type { SelfChangeConfig } from './config'
import type { Git } from './git'
import type { SelfChangeState, StateStore } from './state'
import { hubPath, runPath } from './steps'

/** 不可恢复、由流水线自己收的两种终局。作废它们不改结局,只提前回收树。 */
const SETTLED: readonly string[] = ['done', 'declined']

export const ABANDONED = 'abandoned'

export type LiveHolder = { pid: number; runId: string | null } | null

export interface AbandonDeps {
  store: StateStore
  config: Pick<SelfChangeConfig, 'workdir'>
  git: Git
  exists: (p: string) => boolean
  now: () => number
  /** 拿「一次只跑一条」的锁(生产是 acquireLock(…, runId = 这条))。 */
  lock: () => { ok: true; release: () => void } | { ok: false; holder: number }
  /** 现在活着的持锁者(生产是 readLockHolder)。 */
  liveHolder: () => LiveHolder
}

export type AbandonCode =
  | 'abandoned'
  /** 早就作废过了(幂等):不改存盘,树还在就再删一次。 */
  | 'already_abandoned'
  /** done / declined:不改结局,只提前回收树。 */
  | 'reclaimed'
  | 'self_change_not_found'
  | 'self_change_running'
  /** 存盘已经记成作废,但树没删掉 —— 再跑一次就行。 */
  | 'self_change_reclaim_failed'

export interface AbandonOutcome {
  ok: boolean
  code: AbandonCode
  message: string
}

/** 删树。和 sweepWorktrees 同一套 git;返回 null = 删掉了(或者本来就没有)。 */
function removeTree(d: AbandonDeps, id: string): string | null {
  const tree = runPath(d.config, id)
  if (!d.exists(tree)) return null
  const hub = hubPath(d.config)
  if (!d.exists(hub)) return `中枢克隆 ${hub} 不在了,没法用 git 删;手工删掉 ${tree} 即可`
  d.git.run(['worktree', 'prune'], { cwd: hub })
  const r = d.git.run(['worktree', 'remove', '--force', tree], { cwd: hub })
  if (r.code !== 0) return `git worktree remove --force ${tree} → ${r.code} ${(r.stderr || r.stdout).trim()}`
  return null
}

export function runAbandon(d: AbandonDeps, id: string): AbandonOutcome {
  if (!d.store.load(id)) {
    return { ok: false, code: 'self_change_not_found', message: `没有这条自改:${id}(wechat-cc self change --list 看有哪些)` }
  }

  const lock = d.lock()
  if (!lock.ok) {
    const live = d.liveHolder()
    if (live === null) {
      // 拿锁那一瞬有人持着,回头看又没了:正在换手,别在这时候动。
      return { ok: false, code: 'self_change_running', message: `锁刚刚在 pid ${lock.holder} 手里、正在换手;过一会儿再跑一次 --abandon ${id}` }
    }
    if (live.runId === id) {
      return { ok: false, code: 'self_change_running', message: `#${id} 正在跑(pid ${live.pid}),作废不了:等它停下来(或者先结束那个进程)再来` }
    }
    if (live.runId === null) {
      return { ok: false, code: 'self_change_running', message: `有一条自改在跑(pid ${live.pid}),锁里没记是哪条、分不清是不是 #${id};等它结束再来` }
    }
    // 持锁的是别的一条:这条要恢复也得先拿锁,拿不到 —— 不拿锁也不会和 --resume 撞。
  }

  try {
    // 拿到锁之后再读一遍:等锁这一会儿里盘上可能变过。
    const s = d.store.load(id)
    if (!s) return { ok: false, code: 'self_change_not_found', message: `没有这条自改:${id}` }

    let code: AbandonCode
    let head: string
    if (s.result === ABANDONED) {
      code = 'already_abandoned'
      head = `#${id} 早就作废过了`
    } else if (SETTLED.includes(s.result ?? '')) {
      code = 'reclaimed'
      head = `#${id} 已经收场(${s.result}),结局不改,只把工作树提前回收`
    } else {
      const before = s.result ?? '没收场(进程被杀或还没跑完)'
      s.error = `主人作废:原来停在 ${s.step},结局 ${before}`
      s.result = ABANDONED
      s.updatedAt = d.now()
      d.store.save(s)
      code = 'abandoned'
      head = `#${id} 已作废(原来停在 ${s.step},结局 ${before}),不能再 --resume`
    }

    const tree = runPath(d.config, id)
    const failed = removeTree(d, id)
    if (failed !== null) {
      return { ok: false, code: 'self_change_reclaim_failed', message: `${head};但工作树没删掉:${failed}。再跑一次 wechat-cc self change --abandon ${id} 重试(下一条自改也会顺手扫)` }
    }
    return {
      ok: true,
      code,
      message: `${head};工作树 ${tree} 已回收。分支 ${s.branch} 还留在中枢克隆里(提交没丢;真要扔:git -C ${hubPath(d.config)} branch -D ${s.branch})`,
    }
  } finally {
    if (lock.ok) lock.release()
  }
}

// ── --list 的分类 ──────────────────────────────────────────────────────────

/**
 * `running`:锁在它手里(老格式的锁分不清 ⇒ 没收场的都算,和 --abandon 同一个保守口径)。
 * `killed`:没收场、也没人在跑 —— 进程被杀 / 机器重启了。
 * `resumable`:收在某个失败码上,`--resume` 还能接着跑。
 * `settled`:done / declined,顺手清理一天后会扫。
 * `abandoned`:主人作废了。
 */
export type RunKind = 'running' | 'killed' | 'resumable' | 'settled' | 'abandoned'

export function classifyRun(s: SelfChangeState, live: LiveHolder): RunKind {
  if (s.result === ABANDONED) return 'abandoned'
  if (SETTLED.includes(s.result ?? '')) return 'settled'
  if (s.result !== null) return 'resumable'
  if (live !== null && (live.runId === s.id || live.runId === null)) return 'running'
  return 'killed'
}

export interface RunRow {
  id: string
  step: string
  result: string | null
  startedAt: number
  kind: RunKind
  /** 盘上的工作树;已经回收(或从没开出来)⇒ null。 */
  tree: string | null
  approvalHash: string | null
}

export function describeRuns(
  rows: SelfChangeState[],
  o: { config: Pick<SelfChangeConfig, 'workdir'>; exists: (p: string) => boolean; live: LiveHolder },
): RunRow[] {
  return rows.map(s => {
    const tree = runPath(o.config, s.id)
    return {
      id: s.id,
      step: s.step,
      result: s.result,
      startedAt: s.startedAt,
      kind: classifyRun(s, o.live),
      tree: o.exists(tree) ? tree : null,
      approvalHash: s.approval?.hash ?? null,
    }
  })
}

const KIND_LABEL: Record<RunKind, string> = {
  running: '在跑',
  killed: '被杀(没收场)',
  resumable: '可 --resume',
  settled: '已收场',
  abandoned: '已作废',
}

/** `--list` 的人读版:一行一条,末尾汇总还占着盘、又没人在跑的树。 */
export function formatRunRows(rows: RunRow[]): string {
  const lines = rows.map(r => {
    // 停在 approval 的那条要一眼看得出来:它在等人,而不是在跑
    // (微信卡可能根本没送到 —— 见 `--approve`)。
    const status = r.result ?? (r.step === 'approval' ? '等拍板 ' + String(r.approvalHash ?? '').slice(0, 8) : '进行中')
    return `${r.id} · ${r.step} · ${status} · ${new Date(r.startedAt).toISOString()} · ${KIND_LABEL[r.kind]} · ${r.tree ?? '工作树已回收'}`
  })
  const reclaimable = rows.filter(r => r.tree !== null && r.kind !== 'running')
  if (reclaimable.length > 0) {
    lines.push('', `占着盘的工作树 ${reclaimable.length} 棵(不在跑);不接了就 wechat-cc self change --abandon <id>`)
  }
  return lines.join('\n')
}

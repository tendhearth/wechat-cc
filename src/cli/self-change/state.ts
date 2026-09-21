import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** 流水线的十三个步。`--resume <id>` 从 state.step 这一步接着跑。 */
export type SelfChangeStep =
  | 'intake' | 'repo' | 'implement' | 'guard' | 'tests' | 'review' | 'ci'
  | 'approval' | 'merge' | 'deploy' | 'selftest' | 'report' | 'done'

/** 评审会话吐出来的一条意见(critical / important 会触发修复轮)。 */
export interface ReviewFinding {
  severity: 'critical' | 'important' | 'minor'
  file?: string
  line?: number
  summary: string
}

/** `STATE_DIR/self-change/<id>.json` 的内容。每步结束都整份写回。 */
export interface SelfChangeState {
  id: string
  request: string
  from: 'cli' | 'wechat'
  branch: string
  baseSha: string | null
  step: SelfChangeStep
  startedAt: number
  updatedAt: number
  noDeploy: boolean
  implement: {
    sessionId: string | null
    costUsd: number
    turns: number
    /**
     * 执行者最后那段话(最近一轮的尾巴,≤ SUMMARY_MAX_CHARS 字)。
     * brief 里向它承诺过「这段话会原样进主人的拍板卡」—— 卡片就从这儿取。
     */
    summary: string
    /** 三处修复轮各自独立计数,各最多 SELF_CHANGE_DEFAULTS.max_fix_rounds 轮。 */
    rounds: { tests: number; review: number; ci: number }
  }
  review: { sessionId: string | null; costUsd: number; verdict: 'approve' | 'changes' | null; findings: ReviewFinding[] }
  /**
   * 测试闸门的抖动账:`flakes` 里每一条是「第一次红、失败文件与本次改动无关、
   * 重跑就绿了」的那条命令。记下来是为了两件事 —— 事后能看出这条自改到底
   * 是被什么拖慢的,以及同一条命令老在这儿抖就该去修 CI 而不是继续重跑。
   */
  tests: { flakes: string[] }
  ci: { runId: number | null; url: string | null; verdict: string | null; sha: string | null }
  /** `delivered=false`:拍板卡没进微信(外发不通),但条目还在 daemon 的登记处 ——
   *  桌面权限卡和 `self change --approve <id>` 照样能拍。null = 还没问过。 */
  approval: { hash: string | null; code: string | null; decision: string | null; askedAt: number | null; delivered: boolean | null }
  merge: { sha: string | null; rebased: boolean }
  /**
   * `sha`:**实际构建并部署的那条提交**。部署前会把专用克隆钉回 `merge.sha`
   * 再记下来 —— 没有这一笔,`--resume` 从 deploy 接着跑时没人说得清机器上
   * 到底装的是哪条改动(2026-09-21 审查 #4)。
   * `rolledBack`:自检红之后二进制已经换回上一版。`ok` 这时是 false、
   * `version` 是 null —— 盘上要写**现在跑着的是什么**,不是「曾经部署成功过」
   * (审查 #8)。
   */
  deploy: { ok: boolean | null; version: string | null; sha: string | null; rolledBack: boolean }
  selftest: { workbench: boolean | null; chat: boolean | null }
  result: string | null
  error: string | null
  stderrTail: string[]
  notices: string[]
}

export function newState(input: {
  id: string; request: string; from: 'cli' | 'wechat'; noDeploy: boolean; now: number
}): SelfChangeState {
  return {
    id: input.id,
    request: input.request,
    from: input.from,
    branch: `self/${input.id}`,
    baseSha: null,
    step: 'intake',
    startedAt: input.now,
    updatedAt: input.now,
    noDeploy: input.noDeploy,
    implement: { sessionId: null, costUsd: 0, turns: 0, summary: '', rounds: { tests: 0, review: 0, ci: 0 } },
    review: { sessionId: null, costUsd: 0, verdict: null, findings: [] },
    tests: { flakes: [] },
    ci: { runId: null, url: null, verdict: null, sha: null },
    approval: { hash: null, code: null, decision: null, askedAt: null, delivered: null },
    merge: { sha: null, rebased: false },
    deploy: { ok: null, version: null, sha: null, rolledBack: false },
    selftest: { workbench: null, chat: null },
    result: null,
    error: null,
    stderrTail: [],
    notices: [],
  }
}

/** state / lock 用到的文件系统口子。测试可以塞假件;缺省是真 node:fs。 */
export interface StateFs {
  existsSync: typeof existsSync
  mkdirSync: typeof mkdirSync
  readFileSync: typeof readFileSync
  readdirSync: typeof readdirSync
  writeFileSync: typeof writeFileSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
}

const NODE_FS: StateFs = { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync }

/** 状态目录:`STATE_DIR/self-change`。锁文件也在这儿。 */
export function selfChangeDir(stateDir: string): string {
  return join(stateDir, 'self-change')
}

/** id 只能是流水线自己生成的那种形状 —— `--resume` 的参数直接拼进路径,
 *  不挡住 `../..` 就等于把 STATE_DIR 整个交出去。 */
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export interface StateStore {
  load(id: string): SelfChangeState | null
  save(s: SelfChangeState): void
  list(): SelfChangeState[]
  countSince(ts: number): number
}

/**
 * 每条自改一个 json。写是原子的(`.tmp` + rename,0600 —— 文件里有需求原文
 * 和会话 id),读坏了当没有(一条烂记录不该让 list / 日配额整个瘫掉)。
 */
export function makeStateStore(stateDir: string, fs: StateFs = NODE_FS): StateStore {
  const dir = selfChangeDir(stateDir)

  const readOne = (file: string): SelfChangeState | null => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8') as string)
      if (typeof parsed !== 'object' || parsed === null) return null
      const s = parsed as SelfChangeState
      return typeof s.id === 'string' && typeof s.startedAt === 'number' ? s : null
    } catch { return null }
  }

  return {
    load(id) {
      if (!ID_RE.test(id)) return null
      return readOne(join(dir, `${id}.json`))
    },
    save(s) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `${s.id}.json`)
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
    list() {
      let names: string[]
      try { names = fs.readdirSync(dir) as unknown as string[] } catch { return [] }
      return names
        .filter(n => n.endsWith('.json'))
        .flatMap(n => { const s = readOne(join(dir, n)); return s ? [s] : [] })
        .sort((a, b) => b.startedAt - a.startedAt)
    },
    countSince(ts) {
      return this.list().filter(s => s.startedAt >= ts).length
    },
  }
}

const LOCK_FILE = 'lock'

function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 建锁:`O_CREAT|O_EXCL` 一次写成,已经有人就抛(EEXIST)。
 *
 * 为什么不是「openSync('wx') 拿 fd,再写 pid」:那两步之间锁文件是**空的**,
 * 第二个进程这时候读到一个读不懂的锁,按下面「读不懂 ⇒ 抢过来」的规矩就把
 * 刚建好的锁删了 —— 两边都以为自己拿到了。一次 writeFileSync 带 flag 是同一组
 * 系统标志,但建文件和写 pid 在同一个调用里,没有那个空窗。
 */
function createLockExclusive(fs: StateFs, file: string, pid: number): void {
  fs.writeFileSync(file, JSON.stringify({ pid, at: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 })
}

/**
 * 「一次只跑一条」的锁。文件里写着持有者的 pid:
 *  · 没人持有 ⇒ 拿到
 *  · 持有者还活着 ⇒ 拒绝,把 pid 报给调用方(`self_change_busy`)
 *  · 持有者已经死了(上一条被 kill -9 / 断电)⇒ 抢过来。否则一次崩溃就要
 *    主人手工删文件才能再自改。
 *  · 文件读不懂 ⇒ 也当没人持有,理由同上。
 *
 * **拿锁本身必须是排他的**(2026-09-21 审查 #5):老写法是「先读一眼没人持有,
 * 再写 .tmp + rename」—— 原子替换只保证别人读不到半截文件,拦不住两个进程
 * 都先读到空、然后都写。现在改成 `O_CREAT|O_EXCL` 建文件:同一时刻只有一个
 * 能建成,输的那个才去看持有者是谁。
 *
 * 抢占(死掉的 / 读不懂的持有者)是「删掉再建一次」,而那一次同样是排他的:
 * 两个进程同时来抢一把死锁,也只有一个能建成,另一个照样被挡。
 *
 * `isAlive` 注入是为了测试能演「死 pid」而不用真去 kill 谁。
 */
export function acquireLock(
  stateDir: string,
  pid: number,
  fs: StateFs = NODE_FS,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): { ok: true; release: () => void } | { ok: false; holder: number } {
  const dir = selfChangeDir(stateDir)
  const file = join(dir, LOCK_FILE)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const mine = {
    ok: true as const,
    release: (): void => {
      // 只删自己的:被别人抢占之后再 release,不能把人家的锁带走。
      try { if (readHolder(fs, file) === pid) fs.unlinkSync(file) } catch { /* 已经没了 */ }
    },
  }

  try {
    createLockExclusive(fs, file, pid)
    return mine
  } catch { /* 已经有人建过了,下面看看是谁 */ }

  const holder = readHolder(fs, file)
  // 自己上一次留下的(同一个进程再进来一次):当成还持着。
  if (holder === pid) return mine
  if (holder !== null && isAlive(holder)) return { ok: false, holder }

  // 持有者死了 / 文件读不懂 ⇒ 删掉重建一次。重建仍然是排他的:
  // 另一个进程要是在这一瞬抢先建成了,这次就该轮到我们busy。
  try {
    fs.unlinkSync(file)
    createLockExclusive(fs, file, pid)
    return mine
  } catch {
    // 输给了同时来抢的那个。报出**现在**的持有者,报不出来就报 0
    //(调用方只拿它来告诉主人「被谁占着」,不该因为读不到 pid 就当成没人占)。
    return { ok: false, holder: readHolder(fs, file) ?? 0 }
  }
}

function readHolder(fs: StateFs, file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8') as string
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'number' && Number.isInteger(parsed)) return parsed
    if (typeof parsed === 'object' && parsed !== null) {
      const p = (parsed as { pid?: unknown }).pid
      if (typeof p === 'number' && Number.isInteger(p)) return p
    }
    return null
  } catch { return null }
}

/** 8 位 hex 的运行号。短到能在微信里念,长到一天五条不会撞。 */
export function newSelfChangeId(random: (n: number) => Buffer = randomBytes): string {
  return random(4).toString('hex')
}

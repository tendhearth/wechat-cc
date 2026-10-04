/**
 * provider-probe — 外部 CLI provider(agy / codex / cursor-agent)的开机 `--version`
 * 探测 + 失败后的指数退避重探(2026-10-04)。
 *
 * 事故(2026-10-04 03:14:38Z,self deploy 之后的那次开机):
 *   `[BOOT] agy: binary not found (PATH or agyBin) or --version probe failed`
 * 而 `agy --version` 在终端 0.13s 就回;两分钟后普通重启一次就注册上了。同一次开机
 * cursor-agent 也掉了(被那句误导人的 `CURSOR_API_KEY not set` 盖住)。真因两层:
 *
 *  1. **事件循环被开机的其他活饿住**。wireKnowledge 在 registerProviders 之前用
 *     setTimeout(0) 排了知识库的回填 + 模型预热(transformers.js 的大模块求值、onnxruntime
 *     原生库从编译包里解出来再 dlopen,同步的),正好压在 agy 探测的那几秒上。旧探测拿
 *     墙钟 setTimeout(5s) 和子进程退出赛跑:循环卡了 ~12s,一松开计时器先跑 ⇒ 判超时,
 *     agy 其实早就退出了。日志上看得见:每次失败的开机里 agy 那行都紧跟在
 *     `[KNOWLEDGE] embed runtime 'js' unavailable` 后面,离上一行 12~14s。
 *  2. **一次失败就永久掉线**。探测只在开机跑一次,失败 ⇒ 这一整个进程生命周期都没有这个
 *     provider;主人把 cheapEval 钉在 agy 上,后台判断就一直静默落到别家。
 *
 * 所以这里做三件事:
 *  - `probeVersion`:超时只按「事件循环真的醒着的时间」累计(循环卡住的那段不算),
 *    到点后再给一小段宽限让已经挂在 I/O 队列里的退出事件落地;失败带上**具体原因**
 *    (超时 / 退出码 + stderr / spawn 错误),不再是一句笼统的「没找到或探测失败」。
 *  - `createProbeRetrier`:失败后按 2s、4s、8s … 指数退避重探(封顶),之后转成慢速
 *    周期重探;成功的那一刻注册 provider —— 不用重启。一次一个、不重叠,永远到不了风暴。
 *  - 重探状态(`status()`)进 /v1/health 的 `provider_probes`,`wechat-cc status` /
 *    `guard status` 显示「探测失败,重试中」。
 */
import { spawn } from '../../lib/runtime/process'
import { augmentedPathEnv } from '../../lib/util'

// ── 单次探测 ─────────────────────────────────────────────────────────────────

export type VersionProbeResult =
  | { ok: true; firstLine: string | null; ms: number }
  | { ok: false; reason: 'timeout' | 'exit' | 'spawn_error'; detail: string; ms: number }

/** 测试注入用的子进程句柄 —— 缺省是 runtime/process 的 spawn(stdout/stderr 都 pipe)。 */
export interface VersionProbeHandle {
  exited: Promise<number>
  kill(): void
  /** 子进程退出后读输出(截断用);缺省实现读 pipe。没有 ⇒ 空串。 */
  output?: () => Promise<{ stdout: string; stderr: string }>
}
export type VersionProbeSpawn = (bin: string, args: string[]) => VersionProbeHandle

export interface ProbeVersionOptions {
  /** 「循环醒着的时间」累计到这么久还没退出 ⇒ 超时。缺省 5s。 */
  timeoutMs?: number
  /** 到点后再等这么久,让已经排在 I/O 队列里的退出事件落地。缺省 min(500, timeoutMs)。 */
  graceMs?: number
  spawnFn?: VersionProbeSpawn
  now?: () => number
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5000
/** 一次计时滴答的长度;一次滴答最多记 2 个 tick 的时长,多出来的算「循环卡住」不计入超时。 */
const TICK_MS = 250

async function readStream(s: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!s) return ''
  try { return await new Response(s).text() } catch { return '' }
}

function defaultSpawn(bin: string, args: string[]): VersionProbeHandle {
  // PATH 补全与 probeBinaryVersion 一致:launchd 起的 daemon 拿到的 PATH 比终端短,
  // cursor-agent 这类 shell 脚本里再去找 node 时要用到。
  const proc = spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: augmentedPathEnv() } })
  // 立刻开始读,免得输出塞满 pipe 反过来卡住子进程。
  const out = readStream(proc.stdout)
  const err = readStream(proc.stderr)
  return {
    exited: proc.exited,
    kill: () => { try { proc.kill() } catch { /* already gone */ } },
    output: async () => ({ stdout: await out, stderr: await err }),
  }
}

/** 读输出最多等这么久 —— 孙子进程攥着 pipe 不放时,退出码已经够用了。 */
const OUTPUT_READ_CAP_MS = 500

async function boundedOutput(h: VersionProbeHandle): Promise<{ stdout: string; stderr: string }> {
  if (!h.output) return { stdout: '', stderr: '' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      h.output(),
      new Promise<{ stdout: string; stderr: string }>(resolve => { timer = setTimeout(() => resolve({ stdout: '', stderr: '' }), OUTPUT_READ_CAP_MS) }),
    ])
  } catch {
    return { stdout: '', stderr: '' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 跑一次 `<bin> --version`。永不抛;子进程超时会被杀掉,不会活过这次调用。
 */
export async function probeVersion(bin: string, opts: ProbeVersionOptions = {}): Promise<VersionProbeResult> {
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const graceMs = opts.graceMs ?? Math.min(500, timeoutMs)
  const tickMs = Math.max(1, Math.min(TICK_MS, timeoutMs))
  const spawnFn = opts.spawnFn ?? defaultSpawn
  const start = now()
  let h: VersionProbeHandle
  try {
    h = spawnFn(bin, ['--version'])
  } catch (err) {
    return { ok: false, reason: 'spawn_error', detail: err instanceof Error ? err.message : String(err), ms: now() - start }
  }

  type Outcome = { kind: 'exit'; code: number } | { kind: 'error'; err: unknown }
  let settled: Outcome | null = null
  const exitP: Promise<Outcome> = h.exited.then(
    code => (settled = { kind: 'exit', code }),
    err => (settled = { kind: 'error', err }),
  )

  // 只按循环醒着的时间累计:每个滴答最多记 2*tickMs。循环被同步活卡住 12s,
  // 醒来后只记一个滴答,不会因此判超时。
  let alive = 0
  let stalledMs = 0
  let last = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = (ms: number) => new Promise<'tick'>(resolve => { timer = setTimeout(() => resolve('tick'), ms) })
  try {
    while (settled === null && alive < timeoutMs) {
      await Promise.race([exitP, sleep(tickMs)])
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      const t = now()
      const delta = t - last
      last = t
      const counted = Math.min(delta, 2 * tickMs)
      alive += counted
      stalledMs += delta - counted
    }
    if (settled === null) {
      // 宽限:循环刚醒时,退出事件可能还排在计时器后面。
      await Promise.race([exitP, sleep(graceMs)])
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  const ms = now() - start
  const outcome = settled as Outcome | null
  if (outcome === null) {
    h.kill()
    const stall = stalledMs > 0 ? `;其间事件循环被卡住约 ${Math.round(stalledMs)}ms(不计入超时)` : ''
    return { ok: false, reason: 'timeout', detail: `${Math.round(ms)}ms 内没退出(超时按 ${timeoutMs}ms 计${stall})`, ms }
  }
  if (outcome.kind === 'error') {
    return { ok: false, reason: 'spawn_error', detail: outcome.err instanceof Error ? outcome.err.message : String(outcome.err), ms }
  }
  const { stdout, stderr } = await boundedOutput(h)
  if (outcome.code !== 0) {
    const tail = stderr.trim() || stdout.trim()
    return { ok: false, reason: 'exit', detail: `退出码 ${outcome.code}${tail ? `:${tail.slice(0, 200)}` : ''}`, ms }
  }
  const firstLine = stdout.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? null
  return { ok: true, firstLine, ms }
}

/** 一句话说清楚为什么失败(进日志、进 health)。 */
export function describeProbeFailure(r: Extract<VersionProbeResult, { ok: false }>): string {
  const label = r.reason === 'timeout' ? '超时' : r.reason === 'exit' ? '非零退出' : '起不来'
  return `${label} — ${r.detail}`
}

// ── 失败后的重探 ─────────────────────────────────────────────────────────────

export interface ProbeRetryStatus {
  id: string
  /** retrying = 还没注册、在退避重探;registered = 晚注册成功(不用重启)。 */
  state: 'retrying' | 'registered'
  /** 开机那次不算,重探了几次。 */
  attempts: number
  last_error: string
  first_failed_at: string
  next_attempt_at: string | null
  registered_at: string | null
}

export type ProbeAttempt = () => Promise<{ ok: true } | { ok: false; reason: string }>

export interface ProbeRetrierOptions {
  log: (tag: string, line: string) => void
  /** 快速退避的各档等待(ms)。缺省 2s、4s、8s、16s、32s、60s。 */
  backoffMs?: readonly number[]
  /** 快速档用完之后的慢速周期(ms)。缺省 10 分钟。 */
  periodicMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const DEFAULT_PROBE_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000]
export const DEFAULT_PROBE_PERIODIC_MS = 10 * 60_000

export interface ProbeRetrier {
  /** 开机探测失败后登记。同一个 id 重复登记会被忽略(已经在重探了)。 */
  schedule(id: string, firstError: string, attempt: ProbeAttempt): void
  status(): ProbeRetryStatus[]
  /** daemon 关停:清掉所有计时器;在飞的那次跑完也不再排下一次。 */
  stop(): void
}

export function createProbeRetrier(opts: ProbeRetrierOptions): ProbeRetrier {
  const now = opts.now ?? Date.now
  const backoff = opts.backoffMs ?? DEFAULT_PROBE_BACKOFF_MS
  const periodicMs = opts.periodicMs ?? DEFAULT_PROBE_PERIODIC_MS
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    // 重探永远不该把进程拽着不让退出。
    ;(t as { unref?: () => void }).unref?.()
    return t
  })
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const entries = new Map<string, { status: ProbeRetryStatus; timer: unknown; attempt: ProbeAttempt }>()
  let stopped = false
  const iso = (ms: number) => new Date(ms).toISOString()
  const delayFor = (n: number) => (n < backoff.length ? backoff[n]! : periodicMs)

  const arm = (id: string) => {
    const e = entries.get(id)
    if (!e || stopped || e.status.state !== 'retrying') return
    const d = delayFor(e.status.attempts)
    e.status.next_attempt_at = iso(now() + d)
    e.timer = setTimer(() => { void run(id) }, d)
  }

  const run = async (id: string) => {
    const e = entries.get(id)
    if (!e || stopped) return
    e.timer = undefined
    e.status.next_attempt_at = null
    e.status.attempts++
    let r: Awaited<ReturnType<ProbeAttempt>>
    try {
      r = await e.attempt()
    } catch (err) {
      r = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (stopped) return
    if (r.ok) {
      e.status.state = 'registered'
      e.status.registered_at = iso(now())
      opts.log('BOOT', `${id}: 第 ${e.status.attempts} 次重探通过 — provider 已注册(不用重启)`)
      return
    }
    e.status.last_error = r.reason
    const nextDelay = delayFor(e.status.attempts)
    // 快速档内每次都记;转入慢速周期后只在切换那一下说一声,免得每 10 分钟刷一行。
    if (e.status.attempts <= backoff.length) {
      opts.log('BOOT', `${id}: 第 ${e.status.attempts} 次重探仍失败(${r.reason})— ${Math.round(nextDelay / 1000)}s 后再试`)
    }
    arm(id)
  }

  return {
    schedule(id, firstError, attempt) {
      if (stopped || entries.has(id)) return
      entries.set(id, {
        attempt,
        timer: undefined,
        status: {
          id, state: 'retrying', attempts: 0, last_error: firstError,
          first_failed_at: iso(now()), next_attempt_at: null, registered_at: null,
        },
      })
      arm(id)
    },
    status() {
      return Array.from(entries.values(), e => ({ ...e.status }))
    },
    stop() {
      stopped = true
      for (const e of entries.values()) {
        if (e.timer !== undefined) clearTimer(e.timer)
        e.timer = undefined
        e.status.next_attempt_at = null
      }
    },
  }
}

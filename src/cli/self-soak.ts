/**
 * self-soak.ts —— `wechat-cc self soak`:这一次部署在真机上跑得稳不稳,能不能放下一步进来。
 *
 * 以前的规矩是「部署后跑满一整天,日志里没有异常才合下一步」(核心链设计稿 2026-10-23 表里第 1 步)。一整天里
 * 大半是空等;真正要看的是几个信号。这里把「看日志、看健康」做成一条命令,时长只是其中一条:
 *
 *   - **从哪儿算起**:日志里最后一条 `planned restart (self-deploy)`(self deploy 重启前写的纸条,开机读到就记这一行);
 *     `--since` 可以手给。
 *   - **红**(任何一条 ⇒ 退 1):这之后日志里出现意外重启(`unplanned restart detected`)、模块停 / 起失败或降级
 *     (`[MODULES] … failed / degraded`)、`uncaughtException`、`startup failed`、关机时被迫退出(`forcing exit`);
 *     健康接口上有子系统 degraded、心跳不新鲜、该拉消息的账号没全起来。
 *   - **还没到**(退 2):信号都干净,但跑的时间不到 `--min-hours`(缺省 4 小时)。
 *   - **绿**(退 0):够时长、信号干净。顺带报一句部署后优雅重启过几次 —— 0 次说明关机那条路这一版还没走过,
 *     关机顺序是核心链要看的,风险大的那步可以 `--min-restarts 1` 要求至少走过一次。
 *
 * 只读:读本机日志、调一次 GET /v1/health(file token,跟 self deploy 的健康门同一把)。不重启、不改任何东西。
 */

export interface SoakInput {
  /** channel.log 的内容(新的在后;轮转出去的 .1 拼在前面)。 */
  log: string
  health: SoakHealth | null
  now: number
  since?: number
  minHours: number
  minRestarts: number
}

export interface SoakHealth {
  ok: boolean
  heartbeat_fresh?: boolean | null
  polling?: { eligible: number; started: number } | null
  subsystems?: Array<{ name: string; state: 'ok' | 'degraded' | 'off'; error?: string }>
  version?: { head: string | null; boot_at: string }
}

export type SoakVerdict = 'green' | 'red' | 'not_yet'
export const SOAK_EXIT = { green: 0, red: 1, not_yet: 2 } as const

export interface SoakReport {
  verdict: SoakVerdict
  since: string | null
  hours: number
  head: string | null
  restarts: number
  problems: string[]
  notes: string[]
}

const BAD: Array<[RegExp, string]> = [
  [/\[NOTIFY\] unplanned restart detected/, '意外重启'],
  [/\[MODULES\] .*\b(failed|degraded)\b/, '模块失败 / 降级'],
  [/uncaughtException/, 'uncaughtException'],
  [/\[DAEMON\] startup failed/, '开机失败'],
  [/\[DAEMON\] .*forcing exit/, '关机时被迫退出'],
]
const DEPLOY_MARK = /\[NOTIFY\] skip startup notify: planned restart \(self-deploy/
const GRACEFUL = /\[NOTIFY\] skip startup notify: planned restart \(shutdown:/
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /

export function judgeSoak(input: SoakInput): SoakReport {
  const lines = input.log.split('\n')
  let since = input.since ?? null
  if (since === null) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!DEPLOY_MARK.test(lines[i]!)) continue
      const m = TS.exec(lines[i]!)
      if (m) { since = Date.parse(m[1]!); break }
    }
  }
  const problems: string[] = []
  const notes: string[] = []
  let restarts = 0
  if (since === null) {
    problems.push('日志里找不到上一次 self deploy 的重启记录(轮转掉了?):用 --since <ISO 时间> 给出部署时间')
  } else {
    for (const line of lines) {
      const m = TS.exec(line)
      if (!m || Date.parse(m[1]!) < since) continue
      if (GRACEFUL.test(line)) restarts++
      for (const [re, label] of BAD) {
        if (re.test(line)) { problems.push(`${label}:${line.slice(0, 200)}`); break }
      }
    }
  }

  const h = input.health
  if (!h) problems.push('GET /v1/health 不通(daemon 没在跑?)')
  else {
    if (!h.ok) problems.push('health.ok = false')
    if (h.heartbeat_fresh === false) problems.push('心跳不新鲜')
    if (h.polling && h.polling.started < h.polling.eligible) problems.push(`拉消息只起了 ${h.polling.started}/${h.polling.eligible} 个账号`)
    for (const s of h.subsystems ?? []) if (s.state === 'degraded') problems.push(`子系统 ${s.name} degraded${s.error ? `:${s.error}` : ''}`)
  }

  const hours = since === null ? 0 : Math.max(0, (input.now - since) / 3_600_000)
  if (restarts === 0) notes.push('部署后还没优雅重启过:关机那条路这一版没走过')
  else notes.push(`部署后优雅重启过 ${restarts} 次,关机那条路走过`)

  let verdict: SoakVerdict
  if (problems.length) verdict = 'red'
  else if (hours < input.minHours) { verdict = 'not_yet'; notes.push(`才跑了 ${hours.toFixed(1)} 小时,要 ${input.minHours}`) }
  else if (restarts < input.minRestarts) { verdict = 'not_yet'; notes.push(`要至少优雅重启过 ${input.minRestarts} 次(重启一次:launchctl kickstart -k,或等空闲自动重启)`) }
  else verdict = 'green'

  return {
    verdict,
    since: since === null ? null : new Date(since).toISOString(),
    hours: Math.round(hours * 10) / 10,
    head: h?.version?.head ?? null,
    restarts,
    problems: problems.slice(0, 20),
    notes,
  }
}

export function formatSoak(r: SoakReport): string {
  const head = r.verdict === 'green' ? '✓ 稳,可以放下一步' : r.verdict === 'red' ? '✗ 有异常,别放下一步' : '… 还在观察'
  const out = [`${head}(部署于 ${r.since ?? '?'},跑了 ${r.hours} 小时,版本 ${r.head?.slice(0, 8) ?? '?'})`]
  for (const p of r.problems) out.push(`  ✗ ${p}`)
  for (const n of r.notes) out.push(`  · ${n}`)
  return out.join('\n')
}

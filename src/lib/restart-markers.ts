/**
 * restart-markers.ts — 「上一次是怎么停的」的面包屑,CLI 与 daemon 共用。
 *
 * WHY(2026-10-04 主人反馈):48 小时里 daemon 起了 39 次,几乎全是维护者
 * `self deploy` 的 `launchctl kickstart -k`(SIGTERM)。旧规矩只把
 * `self-restart-stale-code` 当计划内,其余每次都在微信里播一条
 * 「🔄 wechat-cc daemon 已重启 pid=… accounts=1 …」,发不出去还攒着「补发」。
 *
 * 新规矩把判断放在**证据**上,而不是一张「哪些理由算计划内」的白名单:
 *
 *   1. planned-restart.json —— 有人**事先**说了「我要重启它」(self deploy /
 *      回滚、daemon 自己 requestRestart、运维命令)。带 reason、带时间戳,
 *      开机读一次就删,超过 TTL 当没有。
 *   2. clean-shutdown.json —— daemon **收到停止信号、开始优雅退出**时自己写。
 *      launchctl kickstart -k / bootout、App 自动更新换包、注销/关机,走的都是
 *      SIGTERM ⇒ 都会留下它。这条兜住所有「没来得及写 planned 纸条」的计划内
 *      停止,不必每个调用方都记得写。
 *   3. 两张都没有 ⇒ 上一个进程是**没打招呼就没了**的:崩溃(uncaught → exit 1)、
 *      SIGKILL(OOM / jetsam / 看门狗)、断电。只有这一类可能值得告诉主人。
 *
 * 停机时长用上一个进程最后一次心跳(server.heartbeat,30s 一跳)估。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'

export const PLANNED_RESTART_FILE = 'planned-restart.json'
export const CLEAN_SHUTDOWN_FILE = 'clean-shutdown.json'
/** 与 daemon/single-instance.ts 的 HEARTBEAT_FILE 同名(lib 不能反向 import daemon)。 */
const HEARTBEAT_FILE = 'server.heartbeat'

/**
 * planned 纸条的有效期。正常路径是「写完马上 kickstart / 500ms 后退出、
 * launchd 秒级拉起」;给 10 分钟是为了容下 self deploy 的签名 + 健康门。
 * 设上限是为了:万一写了纸条但重启没发生(kickstart 失败),它不能一直
 * 把后面某次真正的意外重启静默掉。
 */
export const PLANNED_RESTART_TTL_MS = 10 * 60_000

export interface PlannedRestartMark { reason: string; ts: number }
export interface CleanShutdownMark { cause: string; pid: number; ts: number }

export interface PreviousRunEvidence {
  /** 新鲜的 planned 纸条(过期的在读时就丢了)。 */
  planned: PlannedRestartMark | null
  /** 上一个进程开始优雅退出时留下的纸条。 */
  cleanShutdown: CleanShutdownMark | null
  /** 上一个进程最后一次心跳(ms),没有就是 null。 */
  lastHeartbeatAt: number | null
}

function writeMark(stateDir: string, file: string, body: unknown): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, file), JSON.stringify(body) + '\n', { mode: 0o600 })
  } catch { /* best effort —— 写不成最多是多一次判断成「意外」,不能挡住重启 */ }
}

/** 重启**之前**调用:「这次是我故意的」。best-effort。 */
export function markPlannedRestart(stateDir: string, reason: string, now: number = Date.now()): void {
  writeMark(stateDir, PLANNED_RESTART_FILE, { reason, ts: now } satisfies PlannedRestartMark)
}

/** daemon 开始优雅退出时调用(收到 SIGTERM/SIGINT、或自己 requestRestart)。 */
export function markCleanShutdown(stateDir: string, cause: string, pid: number = process.pid, now: number = Date.now()): void {
  writeMark(stateDir, CLEAN_SHUTDOWN_FILE, { cause, pid, ts: now } satisfies CleanShutdownMark)
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = readJsonFile<unknown>(path)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

/** 读一次并**总是**删掉(坏的、过期的也删)。 */
function consume(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  const v = readJson(path)
  rmSync(path, { force: true })
  return v
}

function readHeartbeat(stateDir: string): number | null {
  try {
    const n = Number(readFileSync(join(stateDir, HEARTBEAT_FILE), 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

/**
 * 开机最早的时候调用 —— **必须**在本进程写第一跳心跳之前,否则读到的是自己。
 * 两张纸条都在这里吃掉:哪怕这次最后不发通知,也不能把它们留给下一次。
 */
export function consumePreviousRunEvidence(stateDir: string, now: number = Date.now()): PreviousRunEvidence {
  const lastHeartbeatAt = readHeartbeat(stateDir)
  const p = consume(join(stateDir, PLANNED_RESTART_FILE))
  const c = consume(join(stateDir, CLEAN_SHUTDOWN_FILE))
  const planned = p && typeof p.reason === 'string' && typeof p.ts === 'number' && now - p.ts >= 0 && now - p.ts <= PLANNED_RESTART_TTL_MS
    ? { reason: p.reason, ts: p.ts }
    : null
  const cleanShutdown = c && typeof c.ts === 'number'
    ? { cause: typeof c.cause === 'string' ? c.cause : 'unknown', pid: typeof c.pid === 'number' ? c.pid : 0, ts: c.ts }
    : null
  return { planned, cleanShutdown, lastHeartbeatAt }
}

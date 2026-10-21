/**
 * 启动失败的指数退避(重构第二批步 6a)。
 *
 * daemon 由 launchd(KeepAlive + ThrottleInterval 10s)/ systemd(Restart=always + RestartSec 5)托着:启动一失败就退出,
 * 过 5–10 秒又被拉起。配置坏了、迁移失败这种**确定性**的失败,会变成一天八千多次的重启风暴(规矩:退避必须指数级)。
 * 这里记连续失败次数,退出前先等:10s、20s、40s … 封顶 30 分钟;启动成功就清零;上次失败已经过了 1 小时就从头算。
 */
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'

export const BOOT_FAILURE_FILE = 'boot-failures.json'
export const BOOT_BACKOFF_BASE_MS = 10_000
export const BOOT_BACKOFF_MAX_MS = 30 * 60_000
const QUIET_RESET_MS = 60 * 60_000

interface State { count: number; lastAt: number }

function read(stateDir: string): State | null {
  const p = join(stateDir, BOOT_FAILURE_FILE)
  if (!existsSync(p)) return null
  try {
    const v = readJsonFile<Partial<State>>(p)
    return typeof v.count === 'number' && typeof v.lastAt === 'number' ? { count: v.count, lastAt: v.lastAt } : null
  } catch { return null }
}

/** 记一次启动失败,返回这次退出前该等多久。 */
export function recordBootFailure(stateDir: string, now: number): { count: number; delayMs: number } {
  const prev = read(stateDir)
  const count = prev && now - prev.lastAt < QUIET_RESET_MS ? prev.count + 1 : 1
  try { const p = join(stateDir, BOOT_FAILURE_FILE); writeFileSync(`${p}.tmp`, JSON.stringify({ count, lastAt: now })); renameSync(`${p}.tmp`, p) } catch { /* 写不了就当第一次 */ }
  return { count, delayMs: Math.min(BOOT_BACKOFF_BASE_MS * 2 ** (count - 1), BOOT_BACKOFF_MAX_MS) }
}

/** 启动成功:清零。 */
export function clearBootFailures(stateDir: string): void {
  try { rmSync(join(stateDir, BOOT_FAILURE_FILE), { force: true }) } catch { /* 没有就没有 */ }
}

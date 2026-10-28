/**
 * 启动失败的指数退避(重构第二批步 6a)。
 *
 * daemon 由 launchd(KeepAlive + ThrottleInterval 10s)/ systemd(Restart=always + RestartSec 5)托着:启动一失败就退出,
 * 过 5–10 秒又被拉起。配置坏了、迁移失败这种**确定性**的失败,会变成一天八千多次的重启风暴(规矩:退避必须指数级)。
 * 这里记连续失败次数,退出前先等:10s、20s、40s … 封顶 30 分钟;启动成功就清零;上次失败已经过了 1 小时就从头算。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { writeFileAtomic } from '../../lib/json-file'
import { log } from '../../lib/log'

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
  try { writeFileAtomic(join(stateDir, BOOT_FAILURE_FILE), JSON.stringify({ count, lastAt: now })) } catch { /* 写不了就当第一次 */ }
  return { count, delayMs: Math.min(BOOT_BACKOFF_BASE_MS * 2 ** (count - 1), BOOT_BACKOFF_MAX_MS) }
}

/** 启动成功:清零。 */
export function clearBootFailures(stateDir: string): void {
  try { rmSync(join(stateDir, BOOT_FAILURE_FILE), { force: true }) } catch { /* 没有就没有 */ }
}

/**
 * 开机失败、退出之前:记一次、写一行原因进 channel.log、按连续失败次数等(main.ts 的 catch 里调;从 main.ts 抽出来,2026-10-26)。
 * 原因进 channel.log:以前只在 stderr(launchd.err.log),日志里只有一句「startup failed」,self soak / self discover
 * 和主人都看不出为什么(10-21~22 真机 9 次,原因全是「another daemon already running」,只能去翻 stderr)。
 */
export async function waitAfterBootFailure(stateDir: string, err: unknown): Promise<void> {
  const { count, delayMs } = recordBootFailure(stateDir, Date.now())
  log('DAEMON', `startup failed (${count} in a row): ${(err instanceof Error ? err.message : String(err)).slice(0, 300)} — waiting ${Math.round(delayMs / 1000)}s before exit`)
  await new Promise(r => setTimeout(r, delayMs))
}

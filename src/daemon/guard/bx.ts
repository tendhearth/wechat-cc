/**
 * bx 状态读取 —— 网络守护在装了 bx 的机器上的主信号(2026-10-02)。
 *
 * bx(/usr/local/bin/bx,源码 ~/Documents/bx)是一条 fail-closed 的透明隧道。
 * `bx status --json` 只读本机 Guardian/Core 的控制 socket,不往外发任何流量,
 * 实测 ~70ms。判据只取两项对外契约字段:
 *
 *   protection_state === 'protected'   (bx internal/protectionstate 那六个字面量之一:
 *                                        off / starting / recovering / protected /
 *                                        blocked / needs_attention)
 *   tunnel_healthy   === true
 *
 * 两项都满足才算安全。**装了 bx 却读不出来一律按不安全处理(fail closed)**:
 * 进程起不来、超时、非零退出(bx 没在跑时 `--json` 直接返回错误)、输出不是
 * JSON、字段缺失或类型不对 —— 全部 safe=false,detail 写清是哪一种。
 *
 * 泄漏取证不在这里:那是 `bx leakcheck` 的事,这里只回答「此刻能不能往模型
 * 供应商发请求」。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { UNDER_TEST_RUNNER } from '../../lib/config'

export interface BxVerdict {
  safe: boolean
  /** bx 自报的 protection_state;读不出来时为 null。 */
  protection: string | null
  /** bx 自报的 tunnel_healthy;读不出来时为 null。 */
  tunnelHealthy: boolean | null
  /** 一句人话,进日志 / health / 桌面。 */
  detail: string
}

/** 注入的执行器:测试永远不碰真的 bx。 */
export type BxExec = (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>

// bx 自己给一轮观测封顶 5s(internal/cli observeTimeout:跑 route / networksetup 等);平时 ~70ms。
// 超时要比它的封顶宽,否则系统慢的那一下会被误判成「不安全」把 CC 停掉。
export const BX_STATUS_TIMEOUT_MS = 6000

/** 常见安装位置。launchd 下 daemon 的 PATH 很短,所以不靠 PATH 查找。 */
export const BX_CANDIDATE_PATHS = ['/usr/local/bin/bx', '/opt/homebrew/bin/bx']

export function findBx(opts: { configured?: string | null; exists?: (p: string) => boolean } = {}): string | null {
  // 单测里永远不碰真的 bx:没注入 exists 就当没装(注入了的测试照常走判据)。
  if (!opts.exists && UNDER_TEST_RUNNER) return null
  const exists = opts.exists ?? existsSync
  if (opts.configured) return exists(opts.configured) ? opts.configured : null
  for (const p of BX_CANDIDATE_PATHS) if (exists(p)) return p
  return null
}

export function parseBxStatus(stdout: string): BxVerdict {
  let raw: unknown
  try { raw = JSON.parse(stdout) } catch {
    return { safe: false, protection: null, tunnelHealthy: null, detail: 'bx status 输出不是 JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { safe: false, protection: null, tunnelHealthy: null, detail: 'bx status 输出形状不对' }
  }
  const o = raw as Record<string, unknown>
  const protection = typeof o.protection_state === 'string' ? o.protection_state : null
  const tunnelHealthy = typeof o.tunnel_healthy === 'boolean' ? o.tunnel_healthy : null
  if (protection === null) return { safe: false, protection, tunnelHealthy, detail: 'bx status 缺 protection_state' }
  if (tunnelHealthy === null) return { safe: false, protection, tunnelHealthy, detail: 'bx status 缺 tunnel_healthy' }
  if (protection !== 'protected') return { safe: false, protection, tunnelHealthy, detail: `bx 未保护(protection_state=${protection})` }
  if (!tunnelHealthy) return { safe: false, protection, tunnelHealthy, detail: 'bx 隧道不健康(tunnel_healthy=false)' }
  return { safe: true, protection, tunnelHealthy, detail: 'bx 保护中' }
}

export const defaultBxExec: BxExec = (bin, args, opts) => new Promise((resolve) => {
  execFile(bin, args, { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown }) | null
    let exitCode = 0
    if (e) exitCode = typeof e.code === 'number' ? e.code : (e.killed || e.signal ? 124 : 127)
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode })
  })
})

/** 读一次 bx;任何失败都折成 safe=false,绝不抛。 */
export async function readBxStatus(bin: string, opts: { exec?: BxExec; timeoutMs?: number } = {}): Promise<BxVerdict> {
  const exec = opts.exec ?? defaultBxExec
  const timeoutMs = opts.timeoutMs ?? BX_STATUS_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const res = await Promise.race([
      exec(bin, ['status', '--json'], { timeoutMs }),
      new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs + 500) }),
    ])
    if (res === 'timeout') return { safe: false, protection: null, tunnelHealthy: null, detail: `bx status 超时(>${timeoutMs}ms)` }
    if (res.exitCode !== 0) {
      const why = (res.stderr || res.stdout).trim().split('\n')[0]?.slice(0, 120) || `exit ${res.exitCode}`
      return { safe: false, protection: null, tunnelHealthy: null, detail: `bx 没在运行或读不出状态(${why})` }
    }
    return parseBxStatus(res.stdout)
  } catch (err) {
    return { safe: false, protection: null, tunnelHealthy: null, detail: `bx status 执行失败(${err instanceof Error ? err.message : String(err)})` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

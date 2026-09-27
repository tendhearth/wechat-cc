// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分 Task 1),行为不变。
import { join } from 'node:path'
import { STATE_DIR } from '../lib/config'
/**
 * 重启 daemon 并等新的监听真的起来。
 *
 * 「写完配置让用户自己重启」是这条流程里最贵的一步之一:用户得知道这台是
 * launchd 还是 schtasks 还是前台跑的。
 *
 * **不走 `/v1/daemon/restart`** —— 那条路要 admin **session** token,只有
 * 微信里的 agent(daemon_restart 工具)拿得到;CLI 手里的 internal-token 是
 * trusted 档,打过去是 403。我第一版就是这么写的,真机上当场撞了。
 * 改用仓库自己那条验证过的杀进程路径(`daemon kill-residual` 用的同一个):
 * 读 server.pid、**核对 cmdline 确认是我们的 daemon**、SIGTERM,然后靠进程
 * 管理器(launchd / schtasks / systemd)拉起来。
 *
 * 等的是**新地址真的出现在 a2a-info.json 里**,不是 sleep 一个拍脑袋的秒数
 * —— 后者在慢机器上会偶发失败,而失败长得像「配对码是坏的」。
 *
 * 前台 `wechat-cc run` 起的 daemon 没有管理器会拉它,所以等不回来时必须
 * **明说配置已经写好了、手动起一下再跑一次**,不能只丢一句超时。
 */
export async function restartDaemonAndWait(stateDir: string, wantBaseUrl: string): Promise<void> {
  const { readA2AInfo } = await import('./agent.ts')
  const { killResidualDaemon, defaultResidualKillDeps } = await import('./daemon-kill.ts')
  const r = await killResidualDaemon(defaultResidualKillDeps(), join(STATE_DIR, 'server.pid'))
  if (!r.killed) {
    throw new Error(`没能停下当前 daemon(${r.message})—— A2A 配置已经写好了,手动重启 daemon 后再跑一次 hand invite`)
  }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 1500))
    const info = readA2AInfo(stateDir)
    if (info?.enabled && info.base_url === wantBaseUrl) return
  }
  throw new Error(
    `等了 90 秒,A2A 还没在 ${wantBaseUrl} 上起来。`
    + `A2A 配置已经写好了 —— 如果这台的 daemon 是前台 \`wechat-cc run\` 起的,`
    + `没有进程管理器会自动拉它:手动启动后再跑一次 hand invite 即可。`,
  )
}


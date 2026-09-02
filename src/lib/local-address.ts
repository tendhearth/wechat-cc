/**
 * local-address — 「这台机器对外该报哪个地址」的**唯一判定处**。
 *
 * 配一台手时最贵的一步一直是这个:用户得先知道自己的 IP,还得先搞懂
 * 「为什么 127.0.0.1 不行」。`daemon a2a enable` 的帮助里写着
 * `--host <本机 100.x.y.z>` —— 那是把我们的实现细节摊给用户看。
 *
 * 判定顺序是**可达性从强到弱**:
 *   1. Tailscale(100.64.0.0/10 的 CGNAT 段)—— 跨网段也能通,最稳
 *   2. 普通私网网卡 —— 同一局域网内可达
 *   3. 都没有 → null,调用方必须**明说**"找不到可对外的地址",绝不能
 *      悄悄回落到回环:那样配对会成功、派活永远失败,而且症状离根因极远
 *      (2026-09-01 配对卡片广播 127.0.0.1 就是这个形状)。
 *
 * `lanIp()` 原本长在 settings-panel.ts 里。搬到这里是因为这一轮已经吃过
 * 两次「同一个判定散成几份、几份是旧的」的亏(连接错误的措辞、读 JSON)。
 */
import { networkInterfaces } from 'node:os'

/** node:os 的形状,窄化成我们需要的部分 —— 测试注入用。 */
export type NetIfaces = Record<string, Array<{ address: string; family: string; internal: boolean }> | undefined>

/** Tailscale 的 CGNAT 段 100.64.0.0/10。 */
function isTailscale(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

/** First non-internal IPv4 address (en0 preferred). */
export function lanIp(ifs: NetIfaces = networkInterfaces() as NetIfaces): string | null {
  const names = Object.keys(ifs).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0))
  for (const name of names) {
    for (const addr of ifs[name] ?? []) {
      if (!addr.internal && addr.family === 'IPv4' && !isLinkLocal(addr.address)) return addr.address
    }
  }
  return null
}

function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.')
}

export interface HostPick {
  host: string
  /** 为什么挑它 —— **一定要显示给用户**。多网卡时挑错是可能的,
   *  默默替他决定还不告诉他,正是本仓库反复栽的那种坑。 */
  why: 'tailscale' | 'lan'
}

/**
 * 挑一个「对端能连上」的本机地址。找不到返回 null —— 调用方必须明说,
 * 不许回落到回环。
 */
export function pickAdvertisableHost(ifs: NetIfaces = networkInterfaces() as NetIfaces): HostPick | null {
  for (const list of Object.values(ifs)) {
    for (const addr of list ?? []) {
      if (addr.internal || addr.family !== 'IPv4') continue
      if (isTailscale(addr.address)) return { host: addr.address, why: 'tailscale' }
    }
  }
  const lan = lanIp(ifs)
  return lan ? { host: lan, why: 'lan' } : null
}

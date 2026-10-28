/**
 * 每个独立工作区一个端口(2026-10-20,对标 Conductor):脚本里拿 TENDHEARTH_PORT,并行的几个工作区各起各的开发服务不撞车。
 * 范围 47100–48999,避开常见开发端口。用到时才分配:库里没人占(部分唯一索引兜底)+ 本机 127.0.0.1 上绑得上。
 */
import { createServer } from 'node:net'

export const PORT_MIN = 47100
export const PORT_MAX = 48999

/** 本机没有 IPv6 时绑 '::' 会报的两种错:不算占用。 */
const NO_IPV6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])
function bindOnce(port: number, host: string): Promise<'free' | 'busy' | 'unsupported'> {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', (error: NodeJS.ErrnoException) => resolve(host === '::' && NO_IPV6.has(error.code ?? '') ? 'unsupported' : 'busy'))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve('free')))
  })
}
/**
 * 本机这个端口现在绑不绑得上。绑上立刻放掉。三个地址都试:开发服务常绑通配地址(0.0.0.0 / ::),
 * macOS 上 SO_REUSEADDR 让 127.0.0.1 照样绑得上 —— 只探 127.0.0.1 会把被占的端口当成空的(PR-A 评审)。
 */
export async function probePort(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '0.0.0.0', '::']) {
    if ((await bindOnce(port, host)) === 'busy') return false
  }
  return true
}

/**
 * 从低往高找:库里没占、探得通、claim 成功的第一个。claim 返回 false = 唯一索引冲突(别人刚拿走)⇒ 接着找。
 * 全满 ⇒ null(调用方照常跑脚本,只是没有端口)。
 */
export async function allocatePort(input: {
  used: () => Set<number>
  claim: (port: number) => boolean
  probe?: (port: number) => Promise<boolean>
  min?: number
  max?: number
}): Promise<number | null> {
  const probe = input.probe ?? probePort
  const used = input.used()
  for (let port = input.min ?? PORT_MIN; port <= (input.max ?? PORT_MAX); port++) {
    if (used.has(port)) continue
    if (!(await probe(port))) continue
    if (input.claim(port)) return port
  }
  return null
}

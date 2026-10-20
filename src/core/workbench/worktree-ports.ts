/**
 * 每个独立工作区一个端口(2026-10-20,对标 Conductor):脚本里拿 TENDHEARTH_PORT,并行的几个工作区各起各的开发服务不撞车。
 * 范围 47100–48999,避开常见开发端口。用到时才分配:库里没人占(部分唯一索引兜底)+ 本机 127.0.0.1 上绑得上。
 */
import { createServer } from 'node:net'

export const PORT_MIN = 47100
export const PORT_MAX = 48999

/** 本机这个端口现在绑不绑得上。绑上立刻放掉。 */
export function probePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
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

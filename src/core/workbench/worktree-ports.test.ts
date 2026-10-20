import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { allocatePort, PORT_MAX, PORT_MIN, probePort } from './worktree-ports'

const listen = (port: number) => new Promise<Server>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen({ port, host: '127.0.0.1' }, () => resolve(server))
})
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))

describe('worktree ports', () => {
  it('range is 47100–48999', () => {
    expect([PORT_MIN, PORT_MAX]).toEqual([47100, 48999])
  })

  it('probePort: a port someone is listening on is not free; after it closes it is', async () => {
    const server = await listen(0)
    const port = (server.address() as { port: number }).port
    expect(await probePort(port)).toBe(false)
    await close(server)
    expect(await probePort(port)).toBe(true)
  })

  it('picks the lowest port that is free in the DB and probes free', async () => {
    const probed: number[] = []
    const claimed: number[] = []
    const port = await allocatePort({
      used: () => new Set([47100, 47102]),
      probe: async p => { probed.push(p); return p !== 47101 },
      claim: p => { claimed.push(p); return true },
    })
    expect(port).toBe(47103)
    expect(probed).toEqual([47101, 47103])
    expect(claimed).toEqual([47103])
  })

  it('claim conflict (unique index) ⇒ tries the next one', async () => {
    const port = await allocatePort({ used: () => new Set(), probe: async () => true, claim: p => p >= 47102 })
    expect(port).toBe(47102)
  })

  it('range exhausted ⇒ null', async () => {
    expect(await allocatePort({ used: () => new Set(), probe: async () => false, claim: () => true, min: 47100, max: 47105 })).toBeNull()
  })

  it('a real listener in range is skipped', async () => {
    const taken = await listen(0)
    const port = (taken.address() as { port: number }).port
    try {
      // 库里没人占,但本机真有人在听 ⇒ 默认探测拦下
      expect(await allocatePort({ used: () => new Set(), claim: () => true, min: port, max: port })).toBeNull()
    } finally { await close(taken) }
  })
})

/**
 * wire-yi.ts — 乙 v2:BRAIN 侧的 ws rendezvous(yiHub)+ HAND 侧的出站连接。
 * 从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,spec 2026-09-27-bootstrap-split-design)。
 *
 * 2026-10-22 起是一个 DaemonModule(第三批 3b 第 2 步,设计稿 2026-10-22-daemon-module-design):
 *  - 两段都没配 ⇒ `enabled` 为 false ⇒ off(以前是 fn 返回 null)。
 *  - 起失败 ⇒ degraded,boot 继续(`optional`,以前是 sup.start)。
 *  - hub 的监听、hand 的出站连接在 init 里造好、经 `own` 登记停法,start 段才 listen / connect。以前那两处手写的
 *    「半构造清理」(hand 侧抛了先停 hub)和 HAND_ONLY 哨兵都不要了:init 抛错时容器停掉已经登记的;只配 hand
 *    就是 ok、提供 undefined。
 */
import type { A2ARegistry } from '../../core/a2a-registry'
import { createYiHub, type YiHub } from '../../core/yi-hub'
import { createYiWsServer } from '../yi-ws-server'
import type { DaemonModule } from '../modules/container'
import type { DelegateDispatch } from './delegate'
import type { BootstrapCtx } from './types'

type YiConfig = {
  yi_hub_listen?: { host: string; port: number }
  yi_brain?: { url: string; handId: string; authToken: string }
}

export function yiModule(
  configuredAgent: BootstrapCtx['configuredAgent'],
  parts: { a2aRegistry: A2ARegistry; dispatchDelegate: DelegateDispatch },
): DaemonModule<YiHub | undefined> {
  const cfg = configuredAgent as YiConfig
  return {
    name: 'yi',
    optional: true,
    enabled: () => !!cfg.yi_hub_listen || !!cfg.yi_brain,
    async init(ctx) {
      let yiHub: YiHub | undefined
      // BRAIN side: a WebSocket rendezvous that hands connect to.
      if (cfg.yi_hub_listen) {
        const listen = cfg.yi_hub_listen
        const hub = createYiHub()
        const server = createYiWsServer({
          host: listen.host,
          port: listen.port,
          hub,
          verify: (id, tok) => !!parts.a2aRegistry.verifyBearer(id, tok),
        })
        ctx.own('hub server', () => server.stop())   // 没 start 过也能停(server?.stop())
        ctx.onStart('hub listen', async () => {
          await server.start()
          ctx.log(`hub listening on ws://${listen.host}:${server.port()}`)
        })
        yiHub = hub
      }
      // HAND side: connect outbound to a brain's rendezvous.
      if (cfg.yi_brain) {
        const brain = cfg.yi_brain
        const { createYiWsClient } = await import('../yi-ws-client')
        const client = createYiWsClient({
          brainUrl: brain.url,
          handId: brain.handId,
          authToken: brain.authToken,
          capabilities: ['exec'],
          onExec: (t) => parts.dispatchDelegate(t.peer, t.prompt, t.cwd),
          log: (m) => ctx.log(m),
        })
        ctx.own('hand client', () => client.stop())
        ctx.onStart('hand connect', () => {
          client.start()
          ctx.log(`hand connecting to brain at ${brain.url}`)
        })
      }
      return yiHub
    },
  }
}


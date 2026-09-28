/**
 * wire-yi.ts — 乙 v2:BRAIN 侧的 ws rendezvous(yiHub)+ HAND 侧的出站连接。
 * 从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,spec
 * 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,只参数化:
 * deps.log → ctx.log,configuredAgent → ctx.configuredAgent,a2aRegistry /
 * dispatchDelegate 走 parts.*。
 *
 * 形状上的唯一变化(spec §3 规矩 2):整块套进 ctx.sup.start('yi', …)。以前 hub 的
 * 端口绑不上会让整个 boot 抛;现在降级为 yiHub undefined + /v1/health.subsystems
 * 里 'yi' degraded,boot 继续。两段都没配 ⇒ 返回 null ⇒ off。
 */
import type { A2ARegistry } from '../../core/a2a-registry'
import { createYiHub, type YiHub } from '../../core/yi-hub'
import { createYiWsServer } from '../yi-ws-server'
import type { DelegateDispatch } from './delegate'
import type { BootstrapCtx } from './types'

/** 只配 hand 时的返回哨兵:让 supervisor 记 ok;wireYi 出口折回 undefined。 */
const HAND_ONLY = Symbol('yi-hand-only')

export async function wireYi(
  ctx: Pick<BootstrapCtx, 'sup' | 'log' | 'configuredAgent'>,
  parts: { a2aRegistry: A2ARegistry; dispatchDelegate: DelegateDispatch },
): Promise<YiHub | undefined> {
  const { a2aRegistry, dispatchDelegate } = parts
  // sup.start:fn 返回 null ⇒ off、抛 ⇒ degraded,两者都给 undefined。只配 hand 的
  // daemon 没有 hub 可返回,但子系统是活的 —— 用 HAND_ONLY 哨兵让 supervisor 记 ok
  // 而不是 off(2026-09-27 终审 #2),出口再折回 undefined。
  const hub = await ctx.sup.start('yi', async () => {
    let yiHub: YiHub | undefined
    let yiServer: ReturnType<typeof createYiWsServer> | undefined
    let handStarted = false
    // ── 乙 v2 wiring (guarded — no-op when config absent) ────────────────────
    // BRAIN side: start a WebSocket rendezvous that hands connect to.
    if ((ctx.configuredAgent as { yi_hub_listen?: { host: string; port: number } }).yi_hub_listen) {
      const cfg = (ctx.configuredAgent as { yi_hub_listen: { host: string; port: number } }).yi_hub_listen
      yiHub = createYiHub()
      yiServer = createYiWsServer({
        host: cfg.host,
        port: cfg.port,
        hub: yiHub,
        verify: (id, tok) => !!a2aRegistry.verifyBearer(id, tok),
      })
      await yiServer.start()
      ctx.log('YI', `hub listening on ws://${cfg.host}:${yiServer.port()}`)
    }

    // HAND side: connect outbound to a brain's rendezvous.
    // 半构造清理(2026-09-27 终审 #1,同 wire-knowledge 关 sqlite 句柄的姿态):hub 已经
    // 在监听、hand 侧抛(比如 yi_brain.url 畸形让 new WebSocket 同步抛)⇒ 先把 hub 的
    // 监听器停掉再外抛,不然 'yi' 记 degraded、端口却还被一个没人驾驭的 hub 占着。
    try {
      if ((ctx.configuredAgent as { yi_brain?: { url: string; handId: string; authToken: string } }).yi_brain) {
        const cfg = (ctx.configuredAgent as { yi_brain: { url: string; handId: string; authToken: string } }).yi_brain
        const { createYiWsClient } = await import('../yi-ws-client')
        const yiClient = createYiWsClient({
          brainUrl: cfg.url,
          handId: cfg.handId,
          authToken: cfg.authToken,
          capabilities: ['exec'],
          onExec: (t) => dispatchDelegate(t.peer, t.prompt, t.cwd),
          log: (m) => ctx.log('YI', m),
        })
        yiClient.start()
        handStarted = true
        ctx.log('YI', `hand connecting to brain at ${cfg.url}`)
      }
    } catch (err) {
      if (yiServer) { try { await yiServer.stop() } catch { /* best-effort */ } }
      throw err
    }

    return yiHub ?? (handStarted ? HAND_ONLY : null)
  })
  return hub === undefined || hub === null || hub === HAND_ONLY ? undefined : hub
}

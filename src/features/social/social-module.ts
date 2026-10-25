/**
 * 社交 —— 两个模块一组(第三批 3b 第 3 步,设计稿 docs/superpowers/specs/2026-10-22-daemon-module-design.md)。
 *
 *  - `social`:wireSocial 的全部(心愿、介绍、串门、笔友信、来信处理)。**开关就是 `social_enabled`**(连同它要的
 *    `social_disclosure_policy`),不另加:一件事只有一个开关。改了开关要重启才生效,`POST /v1/social/enable` 本来就回
 *    `restart_required: true`。开着却没有便宜模型(cheapEval)⇒ **degraded**,写明原因。以前记的是 off,可 off 在
 *    「CC 现在怎么样」里是「主人关的」,那是假话。
 *  - `mailbox-poller`:笔友信箱的轮询(以前在 main.ts 里单独 sup.start)。`needs: ['social']`:社交没起它也不起。
 *    单独成一个模块,是为了它坏了不连累社交别的部分,「笔友信箱」那一行也照旧单独显示。每拍仍会重读 `social_enabled`:
 *    开关一关,中继往来当场停,不等重启。
 *
 * 路由:`social` 起来以后在 init 里挂上路由表里标了 `module: 'social'` 的那几条(./routes.ts),再把关系视图 / 桌宠要的
 * 窄口 `socialView` 交给 internal-api。只有 bootstrap 这一组的测试容器里没有 internal-api ⇒ 不给 `api`,不挂。
 *
 * 配对(`pairing`)**不在这一组**:它看的是 `mailbox_relays`,不看 `social_enabled`,是刻意的(不开社交也能配对)。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApi } from '../../daemon/internal-api/types'
import { wireSocial, type SocialDeps, type SocialLog, type SocialWiring } from './wire-social'
import { socialRoutes } from './routes'
import { wireMailboxDeps } from './wire-mailbox-deps'
import { registerMailboxPoller } from './wire-mailbox'
import type { Lifecycle } from '../../lib/lifecycle'
import type { A2ARegistry } from '../../adapters/a2a/a2a-registry'
import type { AgentConfig } from '../../lib/agent-config'

/** 社交关着 / 起失败时下游看到的形状(handler 全缺席,a2a / mailbox 的门原样生效)。 */
export const INERT_SOCIAL: SocialWiring = { onLetter: undefined }

/** 社交模块对 internal-api 要的那几口(挂路由、交窄口)+ 信箱里给对端叫名字的口。 */
export interface SocialApi {
  mount: InternalApi['mount']
  provide: InternalApi['provide']
  /** 注册表里认识这个对端就给名字(经 A2A 服务那一侧;它没起 ⇒ undefined)。请求时现取。 */
  peerName: (agentId: string) => string | undefined
}

export function socialModule(deps: SocialDeps, api?: (ctx: ModuleCtx) => SocialApi): DaemonModule<SocialWiring> {
  const cfg = deps.configuredAgent
  return {
    name: 'social',
    optional: true,
    enabled: () => !!cfg.social_enabled && !!cfg.social_disclosure_policy,
    async init(ctx) {
      const w = await wireSocial(deps)
      // 开关开着、披露策略也有,还是没接上 ⇒ 只剩「没有便宜模型」这一种(wireSocial 里记了一行 BOOT)
      if (!w.social) throw new Error('no cheap-eval model available from any registered provider')
      if (api) {
        const a = api(ctx)
        const social = w.social
        a.mount('social', socialRoutes({ social, peerName: a.peerName }))
        a.provide({ socialView: { channelStore: social.penpal.channelStore, letterStore: social.penpal.letterStore, activeVisit: () => social.penpal.activeVisit() } })
      }
      return w
    },
  }
}

export function mailboxPollerModule(
  ctx: { log: SocialLog; stateDir: string; configuredAgent: AgentConfig },
  parts: { a2aRegistry: A2ARegistry; readAgentConfig: () => AgentConfig },
): DaemonModule<void> {
  const relays = ctx.configuredAgent.mailbox_relays ?? []
  return {
    name: 'mailbox-poller',
    optional: true,
    needs: ['social'],
    enabled: () => relays.length > 0,
    init(m) {
      const social = m.get<SocialWiring>('social')
      const deps = wireMailboxDeps(ctx, { a2aRegistry: parts.a2aRegistry, onMailboxLetter: social.onMailboxLetter, readAgentConfig: parts.readAgentConfig })
      if (!deps) throw new Error('social is up but has no own-channel letter handler for the mailbox')
      // 第一拍在 120s ± 30% 之后:到那时 CC 开口那道门(main.ts 里建)早就接上了,收到的来信告诉主人不会落空
      let lc: Lifecycle | null = null
      m.onStart('poll', () => { lc = registerMailboxPoller(deps) })
      m.own('poll', () => lc?.stop())
    },
  }
}


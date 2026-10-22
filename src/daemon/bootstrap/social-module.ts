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
 * 配对(`pairing`)**不在这一组**:它看的是 `mailbox_relays`,不看 `social_enabled`,是刻意的(不开社交也能配对)。
 */
import type { DaemonModule } from '../modules/container'
import { wireSocial, type SocialDeps, type SocialWiring } from './wire-social'
import { wireMailboxDeps } from './wire-mailbox-deps'
import { registerMailboxPoller } from './wire-mailbox'
import type { Lifecycle } from '../../lib/lifecycle'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { AgentConfig } from '../../lib/agent-config'
import type { BootstrapCtx } from './types'
import { runModuleGroup } from './module-group'

/** 社交关着 / 起失败时下游看到的形状(handler 全缺席,a2a / mailbox 的门原样生效)。 */
export const INERT_SOCIAL: SocialWiring = { onLetter: undefined }

export function socialModule(deps: SocialDeps): DaemonModule<SocialWiring> {
  const cfg = deps.configuredAgent
  return {
    name: 'social',
    optional: true,
    enabled: () => !!cfg.social_enabled && !!cfg.social_disclosure_policy,
    async init() {
      const w = await wireSocial(deps)
      // 开关开着、披露策略也有,还是没接上 ⇒ 只剩「没有便宜模型」这一种(wireSocial 里记了一行 BOOT)
      if (!w.social) throw new Error('no cheap-eval model available from any registered provider')
      return w
    },
  }
}

export function mailboxPollerModule(
  ctx: Pick<BootstrapCtx, 'log' | 'stateDir' | 'configuredAgent'>,
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

/** bootstrap/index 一行接上:起这一组,返回社交的接线(关着 / 坏了 ⇒ INERT_SOCIAL)。 */
export async function wireSocialGroup(
  ctx: Pick<BootstrapCtx, 'sup' | 'log' | 'teardown' | 'stateDir' | 'configuredAgent'>,
  deps: SocialDeps,
  parts: { a2aRegistry: A2ARegistry; readAgentConfig: () => AgentConfig },
): Promise<SocialWiring> {
  const group = await runModuleGroup(ctx, 'social', [socialModule(deps), mailboxPollerModule(ctx, parts)])
  return group.provided<SocialWiring>('social') ?? INERT_SOCIAL
}

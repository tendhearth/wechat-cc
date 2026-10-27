/**
 * 微信那一侧接进 daemon 的那一份:ilink 适配器(只造,不拉消息)、回复交付、ilink 起停、拉消息。只有模块表 daemon-modules.ts 引这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../modules/container'
import { lifecycleModule } from '../modules/lifecycle-module'
import type { Foundation } from '../foundation'
import type { GuardRuntime } from '../guard/runtime'
import type { WiredDeps } from '../wiring'
import type { PipelineModule } from '../wiring/module'
import { makeIlinkAdapter, ILINK_PORTS, type IlinkAdapter } from '../ilink-glue'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import { makeReplyDeliveryRuntime } from '../reply-delivery'
import { registerIlink } from '../ilink-lifecycle'
import { registerPolling } from '../polling-lifecycle'

/**
 * 权限卡、自改、终端会话要经 CC 开口那道门(wired 里才造)⇒ lazy。别的模块不拿整个 adapter,只 needs 它交出的窄口
 * (`wechat.send` …,src/ports/wechat.ts;架构终态 A6)。
 */
export function ilinkAdapterModule(f: Foundation): DaemonModule<IlinkAdapter> {
  const { stateDir, db } = f
  return {
    name: 'ilink-adapter',
    needs: ['network-gate'],
    lazy: ['wired'],
    init(ctx): IlinkAdapter {
      const wired = ctx.late<WiredDeps>('wired')
      return makeIlinkAdapter({ stateDir, accounts: f.accounts, db, conversationStore: f.conversationStore, networkGate: ctx.get<GuardRuntime>('network-gate').gate, speech: () => wired()?.speech ?? null })
    },
    ports: ILINK_PORTS,
  } satisfies DaemonModule<IlinkAdapter>
}

/** 回复交付(spec 2026-10-03-reply-delivery):daemon 负责送达的那一条路,必须是同一个实例。 */
export function replyDeliveryModule(f: Foundation): DaemonModule<ReturnType<typeof makeReplyDeliveryRuntime>> {
  return {
    name: 'reply-delivery',
    needs: [W.send],
    init(ctx) {
      const wxSend = ctx.get<WechatSend>(W.send)
      return makeReplyDeliveryRuntime({
        sendText: (c, t) => wxSend.sendMessage(c, t),
        sink: { captureReply: (c, r) => f.replySinks.captureReply?.(c, r) ?? false },
        isSinkOpen: (c) => f.replySinks.isOpen?.(c) ?? false,
        observe: (c, t) => f.outboundTaps.observe(c, t),
        chatPrefs: (c) => f.chatPrefs.get(c),
        log: (t, l, x) => log(t, l, x),
      })
    },
  } satisfies DaemonModule<ReturnType<typeof makeReplyDeliveryRuntime>>
}

export function ilinkModule() {
  return lifecycleModule('ilink', (ctx) => registerIlink(ctx.get<WiredDeps>('wired').ilinkDeps), { required: true, needs: ['wired'] })
}

export function pollingModule() {
  return lifecycleModule('polling', (ctx) => registerPolling({ ...ctx.get<WiredDeps>('wired').pollingDeps, runPipeline: ctx.get<PipelineModule>('pipeline').run }), { required: true, needs: ['wired', 'pipeline'] })
}

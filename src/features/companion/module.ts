/**
 * 陪伴接进 daemon 的那一份(模块清单在 index.ts):路由那个模块 + 四拍的三个定时模块。只有 daemon-modules.ts import 这个文件。
 * 四拍的模块在表里的位置没动(关机顺序快照);候选登记表在 wiring/tick-bodies.ts。
 */
import type { DaemonModule } from '../../daemon/modules/container'
import { lifecycleModule } from '../../daemon/modules/lifecycle-module'
import type { Foundation } from '../../daemon/foundation'
import type { WiredDeps } from '../../daemon/wiring'
import { WECHAT_PORTS as W, type WechatCompanionControls } from '../../ports/wechat'
import { companionFeature, registerCompanionPush, registerCompanionIntrospect, registerIngest } from './index'

/**
 * 只挂 `/v1/companion/status|enable|disable|snooze|import-local|thoughts`(MCP 的 companion_* 工具开机就来)。
 * 开关那一口还是 ilink 适配器造的(改配置 + 起停),原样交过去。
 */
export function companionModule(f: Foundation): DaemonModule<void> {
  const { stateDir } = f
  return companionFeature({
    needs: [W.companion],
    deps: (ctx) => {
      const wxCompanion = ctx.get<WechatCompanionControls>(W.companion)
      return {
        stateDir,
        companion: { enable: () => wxCompanion.enable(), disable: () => wxCompanion.disable(), status: () => wxCompanion.status(), snooze: (m) => wxCompanion.snooze(m), setImportLocal: (e) => wxCompanion.setImportLocal(e) },
      }
    },
  })
}

export function companionPushModule() {
  return lifecycleModule('companion.push', (ctx) => registerCompanionPush(ctx.get<WiredDeps>('wired').companionPushDeps), { needs: ['wired'] })
}
export function companionIntrospectModule() {
  return lifecycleModule('companion.introspect', (ctx) => registerCompanionIntrospect(ctx.get<WiredDeps>('wired').companionIntrospectDeps), { needs: ['wired'] })
}
export function companionIngestModule() {
  return lifecycleModule('companion.ingest', (ctx) => registerIngest(ctx.get<WiredDeps>('wired').companionIngestDeps), { needs: ['wired'] })
}

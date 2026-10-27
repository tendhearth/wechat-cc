/**
 * 记忆接进 daemon 的那一份(模块清单在 index.ts):路由那个模块 + 每晚整理那一拍。只有 daemon-modules.ts import 这个文件。
 */
import { log } from '../../lib/log'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { WiredDeps } from '../../daemon/wiring'
import { ownerChatIdOf } from '../../daemon/owner-chat'
import { memoryFeature, memoryNightlyFeature, makeMemoryLlmOps, type MemoryFeature, type MemoryLlmOps } from './index'

/**
 * `/v1/memory/*` 自己挂(MCP 的 memory_* 工具、桌面记忆页开机就来)。bootstrap 的提示词要它的素材(needs),它的 LLM 操作要
 * bootstrap 的执行者登记、每晚整理要 wired 造的运行时 —— 环的那一头经 lazy 现取,没有 ⇒ 路由照旧 503(搬家前是 internal-api 的 provide)。
 */
export function memoryModule(f: Foundation): DaemonModule<MemoryFeature> {
  const { stateDir, db } = f
  return memoryFeature({
    needs: [],
    lazy: ['bootstrap', 'wired'],
    deps: (ctx) => {
      const boot = ctx.late<Bootstrap>('bootstrap')
      const wired = ctx.late<WiredDeps>('wired')
      // daemon 自己跑的 LLM 记忆操作(spec 2026-07-23):桌面 / CLI 的路由走这一份(不在编译出来的 CLI 里)。
      let llm: MemoryLlmOps | null = null
      return {
        stateDir, db, memory: f.memoryFS, log: (t, l) => log(t, l),
        memoryLlm: () => {
          const b = boot()
          if (!b) return null
          return llm ??= makeMemoryLlmOps({ stateDir, db, getMode: (c) => b.coordinator.getMode(c), registry: b.registry })
        },
        memoryNightly: () => wired()?.memoryNightly ?? null,
        // LLM 记忆路由的 chat_id 缺省:access.json 里唯一的 admin。
        resolveAdminChatId: () => ownerChatIdOf(stateDir),
      }
    },
  })
}

/** 每晚整理长期记忆 memory.md(2026-09-25)。15 分钟一次「该不该跑」。 */
export function memoryNightlyModule(): DaemonModule {
  return memoryNightlyFeature({
    needs: ['wired', 'bootstrap'],
    runtime: (ctx) => ctx.get<WiredDeps>('wired').memoryNightly,
    holdBusy: (ctx) => (l) => ctx.get<Bootstrap>('bootstrap').holdBusy(l),
    log: (t, l) => log(t, l),
  })
}

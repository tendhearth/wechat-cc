/**
 * 记忆 —— 一个功能一个目录(架构终态 A5)。CC 对每个对话记下的东西:画像 / 笔记(MCP 的 memory_* 工具读写)、
 * 每晚整理的长期记忆 memory.md、主人原话与更正、今天的草稿、证据审阅、LLM 合成的概览 / 画像 / 小像。
 *
 *  - `fs-routes.ts`:`/v1/memory/{read,write,list,delete}`(MCP 记忆工具走这四条;会话只能碰自己那个对话);
 *  - `routes.ts`:LLM 记忆操作与每晚整理(立即运行 / 看 / 改);`review-routes.ts`:证据审阅;
 *  - `owner-routes.ts`:桌面记忆页看 / 改的原样文件、画像、本机项目记忆(F6 起桌面不再起 CLI 读这些);
 *  - `nightly*` / `curated-doc` / `memory-text` / `sources` / `today-draft`:每晚整理和它的文件格式;
 *  - `llm-ops.ts`:概览 / 画像 / 小像;`gardener.ts`:伙伴反省时理笔记;`recall` / `snapshot`:回忆与快照;
 *  - `prompt-reads.ts`:每次起会话现读的记忆素材(bootstrap `needs: ['memory']` 拿);
 *  - `wire.ts`:每晚整理的运行时 —— 它要 CC 开口那道门,门在 wired 里才造,所以 wired 经这里调 `wireMemory`;
 *  - 这个文件:模块清单。`memory`(必需,紧跟 internal-api:这些路由以前随 internal-api 一起就在)
 *    挂全部 `/v1/memory/*`、交出提示词素材;定时那一拍是 `memory-nightly`(名字、位置都没动)。
 * 记忆文件那一层(MemoryFS)是通用的 store,在 `src/adapters/store/memory-fs.ts`(社交、伙伴、信都在读写);
 * 记忆编辑的纯函数 `lib/memory-edit.ts` 留在 lib(CLI 也用)。它要的东西(`MemoryFeatureDeps`)由 daemon-modules.ts 填。
 */
import type { Db } from '../../lib/db'
import type { MemoryFS } from '../../adapters/store/memory-fs'
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import { lifecycleModule } from '../../daemon/modules/lifecycle-module'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { memoryFsRoutes } from './fs-routes'
import { memoryRoutes } from './routes'
import { memoryReviewRoutes } from './review-routes'
import { memoryOwnerRoutes } from './owner-routes'
import { makeMemoryPromptReads, type MemoryPromptReads } from './prompt-reads'
import { registerMemoryNightly } from './nightly-lifecycle'
import type { MemoryLlmOps } from './llm-ops'
import type { MemoryNightlyRuntime } from './nightly-runtime'
import { importMemoryOnBoot } from './fact-import'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'

export { wireMemory, type WireMemoryDeps } from './wire'
export { makeMemoryLlmOps, resolveCheapEval, type MemoryLlmOps } from './llm-ops'
export { MEMORY_FILENAME, parseMemoryDoc, renderForPrompt } from './curated-doc'
export { makeMemoryImportCommand } from './import-command'
export { formatNightlyReply, type NightlyRunResult } from './nightly-notify'
export { MEMORY_LOG_FILE, ownerMemoryRoot, readNightlyState } from './nightly'
export type { CuratedView, MemoryNightlyRuntime, MemoryVerdict } from './nightly-runtime'
export { runGarden } from './gardener'
export { buildMemorySnapshot } from './snapshot'
export { recallFromMemory } from './recall'
export type { MemoryPromptReads } from './prompt-reads'

export interface MemoryFeature {
  /** 每次起会话现读的记忆素材(bootstrap 的提示词用)。 */
  promptReads: MemoryPromptReads
}

export interface MemoryFeatureDeps {
  stateDir: string
  db: Db
  /** 整个记忆目录那一份(地基里造的)。 */
  memory: MemoryFS
  /** LLM 记忆操作:bootstrap 起来以前是 null(路由照旧 503 memory_not_wired)。 */
  memoryLlm: () => MemoryLlmOps | null
  /** 每晚整理的运行时:wired 起来以前是 null(路由照旧 503 memory_nightly_not_wired)。 */
  memoryNightly: () => Pick<MemoryNightlyRuntime, 'runNow' | 'view' | 'edit'> | null
  /** 请求里没写 chat_id ⇒ access.json 里唯一的 admin。 */
  resolveAdminChatId: () => string | null
  log: (tag: string, line: string) => void
}

export function memoryFeature(o: { needs: readonly string[]; lazy?: readonly string[]; deps: (ctx: ModuleCtx) => MemoryFeatureDeps }): DaemonModule<MemoryFeature> {
  return {
    name: 'memory',
    needs: ['internal-api', ...o.needs],
    ...(o.lazy ? { lazy: o.lazy } : {}),
    init(ctx) {
      const d = o.deps(ctx)
      // 架构终态 G3:记忆文件 → 主库的表,开机一次、在任何记忆读写之前;按对话逐个,核对不过的对话留在文件路径上。
      // 出错只记日志,不挡开机(G3 时还没人读表)。
      try { importMemoryOnBoot({ store: makeMemoryFactsStore(d.db), stateDir: d.stateDir, now: () => Date.now(), log: d.log }) }
      catch (e) { d.log('MEMORY_IMPORT', `skipped: ${e instanceof Error ? e.message : String(e)}`) }
      ctx.get<InternalApiLifecycle>('internal-api').mount('memory', {
        ...memoryFsRoutes({ memory: d.memory, db: d.db, log: d.log }),
        ...memoryRoutes({ stateDir: d.stateDir, memoryLlm: d.memoryLlm, memoryNightly: d.memoryNightly, resolveAdminChatId: d.resolveAdminChatId }),
        ...memoryReviewRoutes({ stateDir: d.stateDir, db: d.db, resolveAdminChatId: d.resolveAdminChatId }),
        ...memoryOwnerRoutes({ stateDir: d.stateDir, db: d.db, resolveAdminChatId: d.resolveAdminChatId }),
      })
      return { promptReads: makeMemoryPromptReads({ stateDir: d.stateDir, memory: d.memory }) }
    },
  }
}

/** 每晚整理那一拍(15 分钟看一次「该不该跑」):要 wired 造好的运行时。 */
export function memoryNightlyModule(o: {
  needs: readonly string[]
  runtime: (ctx: ModuleCtx) => MemoryNightlyRuntime
  holdBusy: (ctx: ModuleCtx) => (label: string) => () => void
  log: (tag: string, line: string) => void
}): DaemonModule {
  return lifecycleModule('memory-nightly', (ctx) => registerMemoryNightly({ runtime: o.runtime(ctx), holdBusy: o.holdBusy(ctx), log: o.log }), { needs: o.needs })
}

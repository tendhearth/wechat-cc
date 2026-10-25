/**
 * 工作台(「一起做」)—— 一个功能一个目录(架构终态 A5)。主人在桌面 / 手机 / 微信交办的任务:起执行者、记事件、
 * 收成果、审改动、回退、交接、额度接手,做完经 CC 开口那道门告诉主人。
 *
 *  - `service.ts` + `service/*`:服务本身和它的十个域(依赖图写在 service.ts 顶部);
 *  - `wire.ts`:把服务接起来(执行者登记表、额度监视、经验、放行规则那道门、回报);`workbench-api.ts`:API 执行者;
 *  - `wire-notifications.ts` / `wire-artifacts.ts`:任务那几句微信通知、主人点名要的成果文件;
 *  - `wechat-control.ts` 与 `wechat-*`:微信「任务 …」那一族命令;`task-reference.ts`:主人原话里指的是哪一件;
 *  - `routes.ts`:桌面的 44 条 `/v1/workbench/*`(路由表标了 module: 'workbench');
 *  - 这个文件:模块清单。它要的东西(`WireWorkbenchDeps`)由组装的地方(daemon-modules.ts)从上游模块里填。
 *
 * 有意留在 src/core/workbench 的:store(`store.ts` 与它的十几张子表)和执行者、协调器、「一件事」、自改也在用的零件
 * (权限 / 提问 / 原生历史 / 模型目录 / 能力表 / 子进程环境 / 文件夹占用 / 附件 / 补充 / 成果读取 …)。
 * 适配器(src/adapters/executors)和 core 不许依赖功能目录,它们要的这些就不能搬进来;等 E3 拆 core 时
 * 分进 ports / domain / adapters/store。
 *
 * 必需模块(搬家前就是):「做过的事」、wired、通知 / 成果两个模块都 needs 它。没起来时 44 条路由由模块门回
 * 503 workbench_not_wired(和搬家前处理器里写的一样,见 protocol routes.ts 的 MODULE_UNAVAILABLE_CODE)。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { WECHAT_PORTS, type WechatWorkbenchTransport } from '../../ports/wechat'
import type { SpeechPolicy } from '../../daemon/speech/policy'
import { log } from '../../lib/log'
import { wireWorkbench } from './wire'
import { workbenchRoutes } from './routes'
import { wireWorkbenchNotifications } from './wire-notifications'
import { wireWorkbenchArtifacts } from './wire-artifacts'
import type { WorkbenchService } from './service'

export type { WorkbenchService, EntryResult } from './service'
export type { ReviewCommentInput } from './service/review-lines'
export { makeProjectLessons, LESSONS_MAX, LESSON_MAX_CHARS, type ProjectLessons } from './project-lessons'
// 微信「任务 …」那一族(命令表、入站去重 / 记消息、指称解析都要认它)
export { isWechatTaskCommand, wechatTaskMessageKey, type WechatMessageIdentity, type WechatWorkbenchReply } from './wechat-control'
export { resolveTaskReference, makeCheapJudge, FOCUS_TTL_MS, type TaskCandidate, type TaskJudge, type FocusState } from './task-reference'
export { QUOTA_TAKEOVER_DEFAULT_REQUEST, quotaTakeoverText } from './quota-takeover'
// 换一家来审(定时那边起只读轮时用同一套措辞)
export { buildReviewText, reviewMissNote } from './review-request'

/** wireWorkbench 要的,除了 internal-api(模块自己从 needs 里拿)。 */
export type WireWorkbenchDeps = Omit<Parameters<typeof wireWorkbench>[0], 'internalApi'>

export function workbenchFeature(o: {
  /** 要含 'internal-api'(路由自己挂、窄口自己交)。 */
  needs: readonly string[]
  lazy?: readonly string[]
  deps: (ctx: ModuleCtx) => WireWorkbenchDeps
  /** 交办入口的主人(路由里的 entry context);以前经 InternalApiDeps.resolveAdminChatId。 */
  resolveAdminChatId: () => string | null
}): DaemonModule<WorkbenchService> {
  return {
    name: 'workbench',
    needs: o.needs,
    ...(o.lazy ? { lazy: o.lazy } : {}),
    init(ctx) {
      const internalApi = ctx.get<InternalApiLifecycle>('internal-api')
      const service = wireWorkbench({ ...o.deps(ctx), internalApi })
      ctx.own('stop', () => service.shutdown())
      internalApi.mount('workbench', workbenchRoutes({ workbench: service, resolveAdminChatId: o.resolveAdminChatId }))
      // GET /v1/matters 的「已暂停(网络未受保护)」标记:internal-api 只留这一个窄口
      internalApi.provide({ workbenchSuspended: () => service.networkSuspended() })
      return service
    },
  }
}

/** 造好了、但开动的时刻由别的模块定(工作台通知要排在开机清扫之后)。 */
export interface DeferredStart { start(): void }

/**
 * 工作台的微信通知:**停**在 polling 之后(关机时先停入站,再把任务那几句送完,再冲 ilink);
 * **开动**却放在开机最后(startup-sweeps 那一步):补发停机期间做完的任务那几句,要排在「CC 回来了」之后。
 */
export function workbenchNotificationsModule(o: { needs: readonly string[]; speech: (ctx: ModuleCtx) => Pick<SpeechPolicy, 'say'> }): DaemonModule<DeferredStart> {
  return {
    name: 'workbench-notifications',
    needs: o.needs,
    init(ctx) {
      let n: ReturnType<typeof wireWorkbenchNotifications> | null = null
      ctx.own('stop', async () => { await n?.close() })
      return { start: () => {
        n = wireWorkbenchNotifications({ workbench: ctx.get<WorkbenchService>('workbench'), ilink: ctx.get<WechatWorkbenchTransport>(WECHAT_PORTS.workbench), speech: o.speech(ctx) })
        void n.wake().catch(() => log('WORKBENCH', 'Task notifications are waiting for storage recovery.'))
      } }
    },
  }
}

/** 主人点名要的成果文件(「任务 X 文件 <id>」):和通知一样停在 polling 之后、开在开机最后。 */
export function workbenchArtifactsModule(o: { needs: readonly string[] }): DaemonModule<DeferredStart> {
  return {
    name: 'workbench-artifacts',
    needs: o.needs,
    init(ctx) {
      let a: ReturnType<typeof wireWorkbenchArtifacts> | null = null
      ctx.own('stop', async () => { await a?.close() })
      return { start: () => { a = wireWorkbenchArtifacts({ workbench: ctx.get<WorkbenchService>('workbench'), ilink: ctx.get<WechatWorkbenchTransport>(WECHAT_PORTS.workbench) }) } }
    },
  }
}

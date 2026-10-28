/**
 * 社交 / 笔友信箱 —— 一个功能一个目录(架构终态 A5)。CC 和别人家的 CC 之间的那一层:心愿与明信片、介绍、串门、
 * 笔友信(经 A2A 推或经中继信箱投),以及收到这些时告诉主人的那一句。
 *
 *  - `wire-social.ts`:把下面这些接起来(判官、信道、信件、串门、心愿、介绍、来信分发);`social-module.ts`:两个模块
 *    (`social` 开关就是 social_enabled;`mailbox-poller` 是笔友信箱的轮询);
 *  - `penpal-*` / `mailbox-*`(除了下面说的两样)/ `postletter-route` / `mailbox-letter-handler`:信件和信箱的收发;
 *  - `wish*` / `intro*` / `wire-visit` / `social-judge` / `owner-grounding`:三种交互和判官;`*-command.ts`:微信里的几条命令的解析;
 *  - `routes.ts` + `routes-penpal.ts`:路由表里标了 `module: 'social'` 的那几条,模块自己挂;
 *  - 这个文件:模块清单 + 外面要用的几样(命令解析、类型、配对要的「告诉主人」)。
 *
 * 有意不在这里的(见 docs/architecture-end-state-2026-10-25.md 进度表「A5 · 社交」那一行):
 *  - A2A 传输(`core/a2a-*`、bootstrap 里的 a2a registry / client / server)—— 手(乙)、终端会话远程、delegate、
 *    `wechat-cc agent` 都在用,不是社交独有;
 *  - 配对(`core/pairing*`、`bootstrap/wire-pairing.ts`、`/v1/pair/*`)和它用的信道 / 信箱底子(`core/penpal-channel-store`、
 *    `core/penpal-crypto`、`core/mailbox-client`、`core/mailbox-crypto`)—— 开关是 mailbox_relays 不是 social_enabled,
 *    CLI(`wechat-cc pair` / 手的配对)也直接用;
 *  - 关系视图 / 社交总开关 / 入站开关三条路由 —— 社交关着也要能用,留在 internal-api,只经 `socialView` 窄口读。
 */
import type { DaemonModule, EnabledCtx, ModuleCtx } from '../../daemon/modules/container'
import { liftModule } from '../../daemon/modules/lift'
import { socialModule, mailboxPollerModule, type SocialApi } from './social-module'
import type { SocialDeps } from './wire-social'

export { INERT_SOCIAL, type SocialApi } from './social-module'
export type { SocialDeps, SocialWiring, SocialService, SocialLog } from './wire-social'
export type { WishService } from './wire-wish'
export type { IntroService } from './wire-intro'
export type { LetterStore, LetterRow } from './penpal-letter-store'
export type { WishRecord } from './wish'
// 微信命令的解析(命令表在 daemon/wiring/command-router.ts)
export { parseLetterCommand } from './penpal-letter-command'
export { parseVisitCommand } from './visit-command'
export { parseSeekCommand } from './seek-command'
export { parseIntroCommand } from './intro-command'
// 配对成了 / 失败时告诉主人一句(bootstrap/wire-pairing.ts),和社交通知同一道门
export { makeTellOwnerAs, type TellOwnerDeps } from './social-tell'

export interface SocialFeatureOpts {
  /** 外面那一层(bootstrap 那一组)给的上游;有 internal-api 时要把它也写上(挂路由用)。 */
  needs: readonly string[]
  wants?: readonly string[]
  lazy?: readonly string[]
  /** 从上游算出社交要的东西(开关读的配置快照也在里面)。 */
  deps: (up: EnabledCtx) => SocialDeps
  /** 挂路由 + 交窄口的那几口;只有 bootstrap 这一组的测试容器里没有 internal-api ⇒ 不给,不挂。 */
  api?: (ctx: ModuleCtx) => SocialApi
  /** 笔友信箱轮询(`mailbox-poller`,needs social)。 */
  mailbox: {
    needs: readonly string[]
    deps: (up: EnabledCtx) => Parameters<typeof mailboxPollerModule>
  }
}

/** 两个模块:`social`、`mailbox-poller`(名字、开关、顺序和搬家前一样;关机顺序快照不变)。 */
export function socialFeature(o: SocialFeatureOpts): DaemonModule[] {
  return [
    liftModule({ name: 'social', needs: o.needs, ...(o.wants ? { wants: o.wants } : {}), ...(o.lazy ? { lazy: o.lazy } : {}) },
      (up) => socialModule(o.deps(up), o.api)),
    liftModule({ name: 'mailbox-poller', needs: [...o.mailbox.needs, 'social'] },
      (up) => mailboxPollerModule(...o.mailbox.deps(up))),
  ]
}

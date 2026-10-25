/**
 * 每日打猎 —— 一个功能一个目录(架构终态 A5)。主人开了(chat-prefs `hunt: true`,10-21 起默认关)的话,CC 每天替他上网
 * 找 1-2 条他真会感兴趣的东西发过去;发出去的那段旁听下来、拆成条目进背包(伙伴日志)。
 *
 *  - `action.ts`:陪伴候选 `huntAction`(daemon/companion/contributions.ts 的贡献点);wiring/tick-bodies.ts 的候选表登记它;
 *  - `default-off.ts`:默认关那次的一次性开机步骤(老装机主人「没设过 = 开」写成显式的开);
 *  - 这个文件:模块清单。init 里只跑那一步,在 internal-api 开门、任何伙伴那一拍之前。
 *
 * 不在这里的(都不是打猎独有的):
 *  - 背包本身:表在 `src/adapters/store/journal-store.ts`(四种条目、好几个写手),读写路由在 `src/features/journal`;
 *    拆猎物的纯函数在 `src/domain/hunt-catch.ts`(store 的 recordHunt 用它);
 *  - 提示文字 `buildHuntText`:wiring/tick-texts.ts,和推送 / 问候 / 定时共用一套口吻常量;
 *  - 开关本身:chat-prefs 的 `hunt`(/set、设置面板改的是同一份对话设置);冷却在 companion/calibration,登记在 care-ledger,
 *    日程判断的候选名在 domain/companion-plan —— 陪伴那一层按动作 id 认它,贡献点那份说明里写了为什么 id 不动。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import { pinHuntForExistingOwner } from './default-off'

export { huntAction, type HuntActionDeps } from './action'

export type HuntFeatureDeps = Parameters<typeof pinHuntForExistingOwner>[0]

export function huntFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => HuntFeatureDeps }): DaemonModule<void> {
  return {
    name: 'hunt',
    needs: [...o.needs],
    init(ctx) {
      // 打猎改成默认关(收敛清单 ②,主人 10-21 定):第一次带着新默认开机时,把正在每天打猎的主人(主动关心开着、没单独设过)
      // 写成显式的开,不让他跟着被关掉。只做一次(default-off.ts);以前在地基里做,现在是这个模块的 init。
      pinHuntForExistingOwner(o.deps(ctx))
    },
  }
}

/**
 * 社交现在是什么状态、关着时跟主人怎么说 —— 只在这里写一份(第三批 3b 第 3 步 3-2;微信命令、/set visit 都读它)。
 *
 * 三种,跟模块容器的状态一致(bootstrap/social-module.ts):
 *  - off:主人没开(`social_enabled` 或 `social_disclosure_policy` 缺一个)⇒ 告诉他去哪开;
 *  - degraded:开着,但没起来(比如没有便宜模型)⇒ 说没起来、去哪看原因,**不劝他去开**,开关本来就开着;
 *  - ok。
 * 别把坏了说成关了(9d 评审 #545 同一条):两句话不一样。
 */
export type SocialState = 'ok' | 'off' | 'degraded'

export function socialState(cfg: { social_enabled?: boolean; social_disclosure_policy?: unknown }, wired: boolean): SocialState {
  if (!cfg.social_enabled || !cfg.social_disclosure_policy) return 'off'
  return wired ? 'ok' : 'degraded'
}

export const SOCIAL_OFF_LINE = '社交现在关着,去设置里打开。'
export const SOCIAL_DEGRADED_LINE = '社交开着,但现在没起来,原因在「CC 现在怎么样」里。'

/** 社交不是 ok 时,对主人说的那一句。 */
export function socialUnavailableLine(state: Exclude<SocialState, 'ok'>): string {
  return state === 'off' ? SOCIAL_OFF_LINE : SOCIAL_DEGRADED_LINE
}

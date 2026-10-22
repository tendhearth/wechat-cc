/**
 * 社交现在是什么状态、关着时跟主人怎么说 —— 只在这里写一份(第三批 3b 第 3 步 3-2;微信命令、/set visit 都读它)。
 *
 * **以开机时社交模块的状态为准**(`/v1/health.subsystems` 里的 social,跟路由门、「CC 现在怎么样」读的是同一份;9d 评审 #546)。
 * 现在的配置只用来看一件事:开机以后开关有没有改过。
 *  - ok:起着(哪怕之后关了开关,重启前照常能用);
 *  - degraded:开着,但没起来 ⇒ 说没起来、去哪看原因,**不劝他去开**,开关本来就开着;
 *  - pending:开机时关着,刚被打开(桌面「启用社交」/ `wechat-cc social enable`),还没重启 ⇒ 说重启后才生效;
 *  - off:关着 ⇒ 告诉他去哪开。
 * 别把坏了说成关了,也别在状态页说 off 时这里说「没起来」:说法要跟状态页对得上。
 * 不说「空闲时会自己重启」:空闲自动重启只看代码是不是旧了,改开关不会触发它(桌面的提示也是「重启后生效」)。
 */
export type SocialState = 'ok' | 'off' | 'degraded' | 'pending'

type ModuleStatus = { name: string; state: 'ok' | 'degraded' | 'off' }

export function socialState(
  statuses: readonly ModuleStatus[] | undefined,
  cfg: { social_enabled?: boolean; social_disclosure_policy?: unknown },
  wired: boolean,
): SocialState {
  const enabledNow = !!cfg.social_enabled && !!cfg.social_disclosure_policy
  const atBoot = statuses?.find(s => s.name === 'social')?.state
  if (atBoot === undefined) return !enabledNow ? 'off' : wired ? 'ok' : 'degraded'   // 没有模块状态可读(老接线 / 测试):按配置猜
  if (atBoot === 'ok') return 'ok'
  if (atBoot === 'degraded') return 'degraded'
  return enabledNow ? 'pending' : 'off'
}

export const SOCIAL_OFF_LINE = '社交现在关着,去设置里打开。'
export const SOCIAL_DEGRADED_LINE = '社交开着,但现在没起来,原因在「CC 现在怎么样」里。'
export const SOCIAL_PENDING_LINE = '社交刚打开,重启 CC 后才生效。'

/** 社交不是 ok 时,对主人说的那一句。 */
export function socialUnavailableLine(state: Exclude<SocialState, 'ok'>): string {
  return state === 'off' ? SOCIAL_OFF_LINE : state === 'degraded' ? SOCIAL_DEGRADED_LINE : SOCIAL_PENDING_LINE
}

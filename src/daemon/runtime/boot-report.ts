/**
 * 开机走完之后的那几行(从 main.ts 抽出来,2026-10-26):日志里写清这次的权限模式,有可选子系统没起来就跟主人说一句。
 */
import { log } from '../../lib/log'
import type { SubsystemStatus } from '../subsystems'
import { SUBSYSTEM_NAMES } from '../capabilities'
import { ownerChatIdOf } from '../owner-chat'
import type { SpeechPolicy } from '../speech/policy'

export function reportBoot(d: {
  stateDir: string
  dangerously: boolean
  accounts: number
  degraded: SubsystemStatus[]
  speech: Pick<SpeechPolicy, 'tell'>
}): void {
  // 外部集成反馈 #6:这个 flag 的语义像"跳过工具确认",实际是全局提权
  // (resolveEffectiveTier 对 admin / trusted 会话都返回 admin;访客不提权)。日志明说,让 operator 看清 blast radius。
  const modeStr = d.dangerously
    ? 'mode=dangerouslySkipPermissions=true — 注意:此模式下 admin / trusted 会话均按 admin 处理(全局提权),不只是跳过确认;访客仍按访客档'
    : 'mode=strict (Phase 1 permission relay active)'
  log('DAEMON', `started pid=${process.pid} accounts=${d.accounts} ${modeStr}`)
  if (d.dangerously) log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
  // Subsystem degraded-boot (spec 2026-08-17 §3) — 启动完成后的一次性管理员汇总。只报 degraded(off 是常态,不扰人);
  // 发送失败只落日志,绝不影响启动结果。
  if (d.degraded.length === 0) return
  log('SUBSYS', `boot completed degraded: ${d.degraded.map(s => `${s.name}(${s.error ?? '?'})`).join(', ')}`)
  const adminChatId = ownerChatIdOf(d.stateDir)
  if (!adminChatId) return
  // 给主人看的是功能名(和「CC 现在怎么样」同一张表),原始错误只在上面那行日志里。
  const names = [...new Set(d.degraded.map(s => SUBSYSTEM_NAMES[s.name] ?? s.name))].join('、')
  // 经 CC 开口那道门(boot_notice 归 report);「CC 现在怎么样」里同样看得到这几样
  void d.speech.tell('boot_notice', adminChatId, `这次开机有几样没起来：${names}。其它功能照常。`)
    .then(sent => { if (!sent) log('SUBSYS', 'admin degraded summary not sent (deferred by speech policy or send failed)') })
    .catch(err => log('SUBSYS', `admin degraded summary send failed: ${err instanceof Error ? err.message : String(err)}`))
}

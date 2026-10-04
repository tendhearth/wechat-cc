// @ts-check

/** @typedef {import('../../../../src/core/agent-provider').AgentRuntimeSnapshot} RuntimeSnapshot */

/** 网络守护冻住了这条 run(主人 2026-10-03):桌面 / 手机 / 微信同一句。 */
export const NETWORK_SUSPENDED_LABEL = '已暂停(网络未受保护)'

/** Presentation only; retained idle is not proof that native queues are empty.
 * @param {string} status @param {RuntimeSnapshot} [runtime] @param {string} [phase] @param {{since:number}|null} [networkSuspended] */
export function workbenchRuntimePresentation(status, runtime, phase, networkSuspended) {
  // 冻住压过一切运行时观察:进程停着,快照里的「执行中」不是真的在跑。
  if (networkSuspended && (status === 'running' || status === 'cancelling')) return { status:'paused', label:NETWORK_SUSPENDED_LABEL }
  // 后台给了 phase 就以它为准 —— 「已答复」是两家执行者统一的完成语义(docs/cc-workbench.md
  // 回合与会话一节);没有 phase 的旧后台仍从运行时快照推。
  if (phase === 'replied') return { status:'retained', label:'已答复' }
  if (status !== 'running' || !runtime?.retained) return null
  if (runtime.backgroundCount > 0) return { status:'running', label:`后台执行中 · ${runtime.backgroundCount}` }
  if (runtime.foreground === 'idle') return { status:'retained', label:'会话保留中' }
  return null
}

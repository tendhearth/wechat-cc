// @ts-check

/** @typedef {import('../../../../src/core/agent-provider').AgentRuntimeSnapshot} RuntimeSnapshot */

/** Presentation only; retained idle is not proof that native queues are empty.
 * @param {string} status @param {RuntimeSnapshot} [runtime] @param {string} [phase] */
export function workbenchRuntimePresentation(status, runtime, phase) {
  // 后台给了 phase 就以它为准 —— 「已答复」是两家执行者统一的完成语义(docs/cc-workbench.md
  // 回合与会话一节);没有 phase 的旧后台仍从运行时快照推。
  if (phase === 'replied') return { status:'retained', label:'已答复' }
  if (status !== 'running' || !runtime?.retained) return null
  if (runtime.backgroundCount > 0) return { status:'running', label:`后台执行中 · ${runtime.backgroundCount}` }
  if (runtime.foreground === 'idle') return { status:'retained', label:'会话保留中' }
  return null
}

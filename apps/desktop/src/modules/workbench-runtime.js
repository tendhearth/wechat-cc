// @ts-check

/** @typedef {import('../../../../src/core/agent-provider').AgentRuntimeSnapshot} RuntimeSnapshot */

/** Presentation only; retained idle is not proof that native queues are empty.
 * @param {string} status @param {RuntimeSnapshot} [runtime] */
export function workbenchRuntimePresentation(status, runtime) {
  if (status !== 'running' || !runtime?.retained) return null
  if (runtime.backgroundCount > 0) return { status:'running', label:`后台执行中 · ${runtime.backgroundCount}` }
  if (runtime.foreground === 'idle') return { status:'retained', label:'会话保留中' }
  return null
}

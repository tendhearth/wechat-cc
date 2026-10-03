/**
 * 工作台执行者这一轮**真正**连到哪里(评审 #193 P1-1)。
 *
 * 不按任务记录的模型、也不按此刻的配置判:会话起来以后,看会话自己报的目标(Claude 子进程拿到的
 * 端点、codex app-server 的环境、cursor-agent 自报的当前模型……);会话不报,就用起它的那个 provider
 * 按同一份 SpawnContext 报的目标。都报不出来 ⇒ unresolved ⇒ 网络闸门按需要保护(fail closed)。
 */
import type { AgentExecutionChoice, AgentProvider, AgentSession } from '../../agent-provider'
import { providerCallTarget } from '../../provider-registry'
import { sessionCallTarget, type CallTarget } from '../../../lib/network-gate'

export function liveRunTarget(
  run: { session?: AgentSession | null; task: { providerId: string }; execution: AgentExecutionChoice },
  provider?: AgentProvider | null,
): CallTarget {
  if (run.session && typeof run.session.callTarget === 'function') return sessionCallTarget(run.session, run.task.providerId)
  return providerCallTarget(provider, run.task.providerId, 'session', { execution: { ...run.execution } })
}

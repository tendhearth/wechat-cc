/**
 * 测试用:一条入站消息在「命令」这一站与派发之间走的那一段(重构第二批步 2)。
 * 控制命令(配对 / 回信 / 派 / 认识 / 访客)从派发里挪到了命令表;直接调 dispatch 的老测试改走这里,顺序与真流水线一致:
 * 先查命令表,接走就停;否则才进派发。
 */
import type { InboundMsg } from '../../core/prompt-format'

export async function inboundTurn(
  d: { commands?: { registry: { handle(m: InboundMsg): Promise<string | null> } }; dispatch: { coordinator: { dispatch(m: InboundMsg): Promise<void> } } },
  msg: InboundMsg,
): Promise<void> {
  if (await d.commands?.registry.handle(msg)) return
  return d.dispatch.coordinator.dispatch(msg)
}

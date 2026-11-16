import { capabilitiesFor } from './capability-matrix'
import { isKnownProviderId } from '../lib/provider-ids'

/** 本轮答话目标；与持久 Mode 无关。只由 daemon 的可信路由填写。 */
export type AnswerTarget = Readonly<
  | { kind: 'cc'; reason: string }
  | { kind: 'oneoff'; provider: string; reason: string }
  | { kind: 'matter'; matterId: string; reason: string }
  | { kind: 'clarify'; provider?: string; candidates?: readonly { provider: string; name: string }[]; reason: string }
>

/** 仅进程内共享的投递回执。排队时允许纠正，提交后绝不自动重放。 */
export interface AnswerRouteReceipt {
  readonly requestId: string
  target: AnswerTarget
  state: 'pending' | 'submitted' | 'sent' | 'cancelled'
}

export const oneoffSessionAlias = (requestId: string): string => `__oneoff__:${requestId}`

/** 共享长期令牌不能把本轮的记忆/切换能力收回，尚不支持隔离代答。 */
export const supportsOneoffAnswer = (provider: string): boolean => !isKnownProviderId(provider) || capabilitiesFor(provider).adminMcpTools

/** 独立临时会话仅带当前句与这些硬规矩，不调用 CC 的个人记忆指令构造器。 */
export const ONEOFF_INSTRUCTIONS = [
  '你是本句被点名的答话者，只回答用户当前这一句。',
  '只根据本句及其附件工作，不读取主人的私人对话、陪伴或情绪记忆、话题记忆或其他任务。',
  '遵守当前工作区的硬规矩和权限边界；缺信息、权限或依赖时说明具体缺项。',
  '回复直接输出文本，不调用微信发消息、发文件、记忆或社交工具，不替用户发布或发送。',
  '不改变 CC 的持久模式、默认后端、设置或事项焦点。',
  '不要声称完成没有做过的操作或检查。',
].join('\n')

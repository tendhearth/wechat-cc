/**
 * 手机订阅主题的数据形状(与 src/daemon/phone-topic-sources.ts 的四个来源一一对应)。
 * 事件只带小摘要与版本号,大内容照旧用 req 拉。daemon 的测试拿真实快照对着这里 parse,防漂移。
 */
import z from 'zod'

export const HomeTopic = z.object({
  unread: z.number(),
  presenceState: z.object({ level: z.string(), activity: z.string() }).nullable(),
  nextCursor: z.string().nullable(),
})
export const ApprovalItem = z.object({ taskId: z.string(), kind: z.enum(['permission', 'question']), id: z.string(), summary: z.string() })
export const ApprovalsTopic = z.array(ApprovalItem)
export const AgentsTopic = z.object({
  running: z.number(), waiting: z.number(),
  tasks: z.array(z.object({ id: z.string(), title: z.string(), phase: z.string() })),
})
export const MatterTopic = z.union([
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), kind: z.string(), version: z.number(), phase: z.string() }),
])
export type HomeTopicT = z.infer<typeof HomeTopic>
export type ApprovalItemT = z.infer<typeof ApprovalItem>
export type AgentsTopicT = z.infer<typeof AgentsTopic>
export type MatterTopicT = z.infer<typeof MatterTopic>

/** T4:三端共用的话题泡泡契约。closed 是收起,不是事情完成。 */
import z from 'zod'
const Id = z.string().min(1).max(128)
export const TopicsListQuery = z.object({ view: z.enum(['recent', 'all']).default('recent'), q: z.string().trim().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(6), cursor: z.string().max(1024).optional() })
export const TopicDetailQuery = z.object({ id: Id, section: z.enum(['entries', 'matters', 'messages']).optional(), limit: z.coerce.number().int().min(1).max(20).optional(), cursor: z.string().max(1024).optional() })
export const TopicOpenRequest = z.object({ id: Id, requestId: Id })
export const TopicsSubscribeQuery = z.object({ since: z.string().max(128).optional(), wait_ms: z.coerce.number().int().min(0).max(30000).default(25000) })
export const TopicActivity = z.object({ running: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(), unread: z.number().int().nonnegative(), lastActiveAt: z.number().nullable() })
export type TopicActivityT = z.infer<typeof TopicActivity>
export const TopicSession = z.object({ id: Id, kind: z.enum(['task','terminal']), title: z.string(), executor: z.string(), activity: z.enum(['running','waiting','unread','idle']), latestStep: z.string(), updatedAt: z.number(), requestId: z.string().nullable() })
export type TopicSessionT = z.infer<typeof TopicSession>
export const TopicSummary = z.object({
  mergedInto: Id.nullable().optional(),
  id: Id, title: z.string(), description: z.string(), summary: z.string(), bubbleState: z.enum(['open', 'closed']),
  lastRecalledAt: z.string().nullable(), lastOpenedByOwnerAt: z.string().nullable(), activityRevision: z.number(),
  activity: TopicActivity.optional(),
  matterSummary: z.object({ waiting: z.number(), running: z.number(), total: z.number() }),
})
export const TopicsSnapshot = z.object({ revision: z.string(), recentIds: z.array(Id).max(8), openIds: z.array(Id).max(64), hasMoreOpen: z.boolean() })
const Page = z.object({ total: z.number(), nextCursor: z.string().nullable() })
export const TopicBubbleEntry = z.object({ id: Id, threadId: Id, kind: z.enum(['fact', 'decision', 'commitment', 'progress', 'conclusion']), line: z.string(), body: z.string(), due: z.string().nullable(), status: z.enum(['live', 'done', 'superseded']), source: z.string(), matterId: z.string().nullable(), supersededBy: z.string().nullable(), createdTs: z.string(), updatedTs: z.string(), recalled: z.boolean() })
export const TopicBubbleMatter = z.object({ session: TopicSession.optional(), kind: z.enum(['task', 'terminal', 'act', 'chat']).optional(), detailRoute: z.string().optional(), id: Id, title: z.string(), state: z.string(), archivedAt: z.number().nullable() })
export const TopicBubbleMessage = z.object({ id: z.string(), ts: z.string(), speaker: z.enum(['owner', 'cc']), excerpt: z.string(), source: z.enum(['recall', 'episode']) })
export const TopicsListResponse = z.object({ topics: z.array(TopicSummary), nextCursor: z.string().nullable(), revision: z.string() })
export const TopicDetailResponse = z.object({ topic: TopicSummary, entries: z.array(TopicBubbleEntry), matters: z.array(TopicBubbleMatter), messages: z.array(TopicBubbleMessage), pages: z.object({ entries: Page, matters: Page, messages: Page }), revision: z.string() })
export const TopicOpenResponse = z.object({ id: Id, bubbleState: z.enum(['open', 'closed']), revision: z.string() })
export const TopicRenameRequest = z.object({id:Id,title:z.string().trim().min(1).max(120)}).strict()
export const TopicMergeRequest = z.object({id:Id,into:Id}).strict()
export const TopicDeleteRequest = z.object({id:Id}).strict()
export const TopicWrongRequest = TopicDeleteRequest
export const TopicEditResponse = z.object({ ok: z.literal(true), message: z.string().optional() })
export const TOPIC_BUBBLE_RESPONSES = {
  'POST /v1/memory/topics/rename': TopicEditResponse,
  'POST /v1/memory/topics/merge': TopicEditResponse,
  'POST /v1/memory/topics/delete': TopicEditResponse,
  'POST /v1/memory/topics/entry/wrong': TopicEditResponse,
  'GET /v1/memory/topics': TopicsListResponse,
  'GET /v1/memory/topics/detail': TopicDetailResponse,
  'POST /v1/memory/topics/open': TopicOpenResponse,
  'GET /v1/subscribe/topics': TopicsSnapshot,
} as const

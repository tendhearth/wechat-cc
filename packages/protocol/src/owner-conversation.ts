import z from 'zod'

const Id = z.string().min(1).max(256)
export const ConversationWindowQuery = z.object({
  anchor: Id.optional(), before: Id.optional(), after: Id.optional(),
  q: z.string().trim().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(30),
}).refine(p => [p.anchor, p.before, p.after].filter(Boolean).length <= 1)
export type ConversationWindowInput = z.infer<typeof ConversationWindowQuery>
export const ConversationWorkQuery=z.object({cursor:z.string().max(1024).optional(),limit:z.coerce.number().int().min(1).max(50).default(30)})
export type ConversationWorkInput=z.infer<typeof ConversationWorkQuery>
export const ConversationMessage = z.object({ messageId: Id, kind: z.enum(['user', 'text']), text: z.string(), createdAt: z.number(), source: z.string(), replyExtras: z.unknown().optional(),truncated:z.boolean().optional() })
export const ConversationWindow = z.object({ scope:z.string().optional(),messages: z.array(ConversationMessage), earlier: Id.nullable(), later: Id.nullable(), anchor: Id.nullable() })
export const ConversationWork = z.object({ scope:z.string().optional(),nextCursor:z.string().nullable().optional(),references: z.array(z.object({ id: Id, matterId: Id, messageId: Id.nullable(), kind: z.enum(['task', 'terminal', 'act']), title: z.string(), createdAt: z.number(), detailRoute: z.string() })), results: z.array(z.object({ id: Id, matterId: Id, turnId: Id, messageId: Id.nullable(), text: z.string(),truncated:z.boolean().optional(), createdAt: z.number() })) })
export const ProtocolCapabilities = z.object({ routes: z.literal('v1').optional(), topics: z.literal('v1').optional() })
export const ConversationEvents = z.object({ scope:z.string().optional(),running:z.object({turnId:Id,runId:Id.nullable()}).nullable(),events:z.array(z.object({id:Id,turnId:Id.nullable(),cursor:z.number(),kind:z.string(),text:z.string(),truncated:z.boolean().optional(),createdAt:z.number()})),cursor:z.number() })
export const OWNER_CONVERSATION_RESPONSES = {
  'GET /v1/matter/owner-chat/events': ConversationEvents,
  'POST /v1/matter/owner-chat/stop': z.object({stopped:z.literal(true)}),
  'GET /v1/protocol/capabilities': ProtocolCapabilities,
  'GET /v1/matter/owner-chat/window': ConversationWindow,
  'GET /v1/matter/owner-chat/work': ConversationWork,
} as const

/**
 * places.ts —— 「地方」的线上形状(设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
 *
 * 正面上半:主人做的每个项目一行,位置由主人定、不按状态重排,新的加在末尾。
 * 一行只给三样:名字、一句现状、时间;外加「在等你」(圆点 + 行上直接答)和「说了话你还没看」(加粗)。
 * daemon 的 src/domain/places.ts 算;不带本地化文字,状态词由端上按 STATUS_TABLE 查。
 */
import z from 'zod'
import { STATUS_KEYS } from './status-table'

export const PLACE_OPINION_MAX = 40
export const PLACE_QUESTION_REASON_MAX = 24
export const PlaceOpinion = z.object({
  ccOpinion: z.string().min(1).max(PLACE_OPINION_MAX),
  questionReason: z.string().min(1).max(PLACE_QUESTION_REASON_MAX),
})
export type PlaceOpinionT = z.infer<typeof PlaceOpinion>

export const PlaceWaiting = z.object({
  /** 这一条挂在哪一行名单上("matter:<id>" | "terminal:<sessionId>")。 */
  itemKey: z.string(),
  /** permission / question:工作台里能就地答的;terminal:终端会话自己停着问,要打开那一件去答。 */
  kind: z.enum(['permission', 'question', 'terminal']),
  matterId: z.string().optional(),
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  ...PlaceOpinion.partial().shape,
  summary: z.string(),
  /** 这个地方一共有几条在等你。 */
  count: z.number().int().min(1),
})
export type PlaceWaitingT = z.infer<typeof PlaceWaiting>

export const SessionRecap = z.object({
  text: z.string(),
  source: z.enum(['claude', 'cc']),
  at: z.number(),
  awayFrom: z.number(),
})
export type SessionRecapT = z.infer<typeof SessionRecap>
export const RecapSettingsRequest = z.object({ recap: z.boolean() }).strict()
export const RecapSettingsResponse = RecapSettingsRequest.extend({ ok: z.literal(true) })

export const Place = z.object({
  /** "p:<16 位 hex>",由项目根目录算出,三端拿它当行的稳定身份。 */
  key: z.string(),
  name: z.string(),
  /** 现状那一句的原料:等你时是那条请求,否则是最近那件事的标题 / 终端最近一句;这个地方还没动过 ⇒ null。 */
  line: z.string().nullable(),
  /** line 那件事现在的状态(端上查 STATUS_TABLE 出词);line 为 null 时也为 null。 */
  status: z.enum(STATUS_KEYS).nullable(),
  waiting: PlaceWaiting.nullable(),
  recap: SessionRecap.optional(),
  /** 有至少一件在干。 */
  moving: z.boolean(),
  /** 带回来了、哪一端都还没看过。 */
  unseen: z.boolean(),
  /** 「坐回来」:主人上次看过这一行以后,除了 line 说的那件,还有几件也动过;没看过这一行 / 没别的动 ⇒ 0。 */
  alsoChanged: z.number().int().min(0).optional(),
  updatedAt: z.number().nullable(),
  /** 点这一行时,把说话筛成这个地方用:最近的事、它们是从哪条消息分出来的、挂着的终端会话。 */
  matterIds: z.array(z.string()),
  messageIds: z.array(z.string()),
  sessionIds: z.array(z.string()),
  sessions: z.array(z.object({
    sessionId: z.string(),
    matterId: z.string().optional(),
    agent: z.string(),
    status: z.enum(['waiting', 'working', 'replied', 'done']),
    updatedAt: z.number(),
    endedAt: z.number().nullable(),
  })).max(30).optional(),
})
export type PlaceT = z.infer<typeof Place>

export const LabsRequest = z.object({ placeMap: z.boolean() }).strict()
export const LabsResponse = LabsRequest.extend({ ok: z.literal(true) })
export type LabsRequestT = z.infer<typeof LabsRequest>

export const PlacesResponse = z.object({
  places: z.array(Place),
  hidden: z.array(Place.pick({ key: true, name: true })).optional(),
  version: z.string(),
  labs: z.object({ placeMap: z.literal(true) }).optional(),
})
export type PlacesResponseT = z.infer<typeof PlacesResponse>

export const PlaceMoveRequest = z.object({ key: z.string().regex(/^p:[a-f0-9]{16}$/), to: z.number().int().min(0) }).strict()
export const PlaceHideRequest = z.object({ key: z.string().regex(/^p:[a-f0-9]{16}$/), hidden: z.boolean() }).strict()
export const PlaceSeenRequest = z.object({ key: z.string().regex(/^p:[a-f0-9]{16}$/) }).strict()
export const PlaceWriteResponse = z.object({ ok: z.literal(true) })

export const PlaceMapBranch = z.enum(['open','active','decided','done','noted'])
export type PlaceMapBranchT = z.infer<typeof PlaceMapBranch>
export const PlaceMapPinRequest = z.object({
  key: PlaceMoveRequest.shape.key,
  itemId: z.string().min(1),
  branch: PlaceMapBranch.nullable(),
}).strict()
export type PlaceMapPinRequestT = z.infer<typeof PlaceMapPinRequest>

export const PlaceMapItem = z.object({
  id: z.string(),
  kind: z.enum(['fact', 'decision', 'commitment', 'progress', 'conclusion', 'session', 'task', 'ask']),
  status: z.string(),
  pin: PlaceMapBranch.optional(),
  line: z.string(),
  body: z.string().optional(),
  topic: z.object({ id: z.string(), title: z.string() }).optional(),
  from: z.object({
    source: z.enum(['chat', 'work', 'delegate', 'terminal', 'task']),
    matterId: z.string().optional(),
    sessionId: z.string().optional(),
    at: z.number(),
  }),
})
export type PlaceMapItemT = z.infer<typeof PlaceMapItem>

export const PlaceOutlineRequest = PlaceSeenRequest
export const PlaceOutlineRunResponse = z.object({
  ok: z.literal(true),
  state: z.enum(['running', 'ready', 'empty']),
  unchanged: z.literal(true).optional(),
})
export type PlaceOutlineRunResponseT = z.infer<typeof PlaceOutlineRunResponse>

const PlaceOutlineSource = z.object({
  kind: z.enum(['session', 'entry']),
  sessionId: z.string().optional(),
  matterId: z.string().optional(),
  agent: z.string().optional(),
  at: z.number().optional(),
})
const PlaceOutlineAspects = z.array(z.object({
  name: z.string(),
  items: z.array(z.object({
    id: z.string(), line: z.string(), status: PlaceMapBranch,
    sources: z.array(PlaceOutlineSource),
  })),
}))
export const PlaceOutline = z.object({
  state: z.enum(['none', 'running', 'ready', 'empty', 'failed']),
  at: z.number().optional(),
  error: z.enum(['no_private_model', 'bad_output', 'stale', 'interrupted', 'unavailable']).optional(),
  stale: z.boolean().optional(),
  canRun: z.boolean(),
  aspects: PlaceOutlineAspects.optional(),
})
export type PlaceOutlineT = z.infer<typeof PlaceOutline>
export type PlaceOutlineSourceT = z.infer<typeof PlaceOutlineSource>

export const PlaceMapResponse = z.object({
  ok: z.literal(true),
  place: Place.pick({ key: true, name: true }),
  items: z.array(PlaceMapItem),
  truncated: z.boolean(),
  revision: z.string(),
  outline: PlaceOutline.optional(),
})
export type PlaceMapResponseT = z.infer<typeof PlaceMapResponse>

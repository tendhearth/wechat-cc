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

export const Place = z.object({
  /** "p:<16 位 hex>",由项目根目录算出,三端拿它当行的稳定身份。 */
  key: z.string(),
  name: z.string(),
  /** 现状那一句的原料:等你时是那条请求,否则是最近那件事的标题 / 终端最近一句;这个地方还没动过 ⇒ null。 */
  line: z.string().nullable(),
  /** line 那件事现在的状态(端上查 STATUS_TABLE 出词);line 为 null 时也为 null。 */
  status: z.enum(STATUS_KEYS).nullable(),
  waiting: PlaceWaiting.nullable(),
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
})
export type PlaceT = z.infer<typeof Place>

export const PlacesResponse = z.object({ places: z.array(Place), version: z.string() })
export type PlacesResponseT = z.infer<typeof PlacesResponse>

export const PlaceMoveRequest = z.object({ key: z.string().regex(/^p:[a-f0-9]{16}$/), to: z.number().int().min(0) }).strict()
export const PlaceHideRequest = z.object({ key: z.string().regex(/^p:[a-f0-9]{16}$/), hidden: z.boolean() }).strict()
export const PlaceSeenRequest = z.object({ key: z.string().regex(/^p:[a-f0-9]{16}$/) }).strict()
export const PlaceWriteResponse = z.object({ ok: z.literal(true) })

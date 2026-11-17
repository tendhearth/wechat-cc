/**
 * roster.ts —— 「在做」名单的线上形状(设计稿 docs/superpowers/specs/2026-11-17-butler-layout-design.md §4.1)。
 * daemon 的 src/domain/roster.ts 算,`GET /v1/roster` 回(桌面用 operator 令牌;App / 已配对网页用设备令牌从面板那一口进来,同一个处理器)。
 * 不带任何本地化文字:状态词、分组标题都由端上按 STATUS_TABLE 查。
 */
import z from 'zod'
import { STATUS_KEYS } from './status-table'

export const RosterAgent = z.object({ id: z.string(), name: z.string().optional(), current: z.boolean() })

export const RosterItem = z.object({
  /** "matter:<id>" | "terminal:<sessionId>",三端用它当行的稳定身份。 */
  key: z.string(),
  kind: z.enum(['matter', 'terminal']),
  /** matter 行 = 事的 id;terminal 行 = 会话 id。 */
  id: z.string(),
  title: z.string(),
  /** 文件夹显示名(话题 = 项目);只给目录名,不给完整路径。 */
  project: z.string().optional(),
  group: z.enum(['waiting', 'working', 'back']),
  status: z.enum(STATUS_KEYS),
  agents: z.array(RosterAgent),
  /** 计划了多棒时才有;index 从 1 数。 */
  relay: z.object({ index: z.number().int().min(1), total: z.number().int().min(1) }).optional(),
  /** 等你时:等得最久的那一条请求 + 一共几条。终端自己在问的会话没有 requestId,不带这项。 */
  waiting: z.object({ kind: z.enum(['permission', 'question']), requestId: z.string(), summary: z.string(), count: z.number().int().min(1) }).optional(),
  /** 在做却 30 分钟没动静(QUIET_AFTER_MS)。 */
  quiet: z.boolean(),
  updatedAt: z.number(),
  /** 带回来了、哪一端都还没看过;终端会话恒 false。 */
  unseen: z.boolean(),
  terminal: z.object({ sessionId: z.string(), code: z.string(), liveWindow: z.boolean().optional(), actionable: z.boolean().optional(), summary: z.string().nullable().optional() }).optional(),
})
export type RosterItemT = z.infer<typeof RosterItem>

export const RosterResponse = z.object({ items: z.array(RosterItem), version: z.string() })
export type RosterResponseT = z.infer<typeof RosterResponse>

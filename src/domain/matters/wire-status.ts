/**
 * matters/wire-status.ts — 线上旧 `Matter.status` 的取值(v60 的列;v102 删列后只在线上,packages/protocol/src/wire-compat.ts 第一行)。
 * 单独一个文件:ports/matters.ts 要这个类型,而推它的式子(legacy-status.ts)要 ports 的类型 —— 放一起就成环。
 */
export type LegacyMatterStatus = 'open' | 'replied' | 'done' | 'archived'
export const LEGACY_MATTER_STATUSES: readonly LegacyMatterStatus[] = Object.freeze(['open', 'replied', 'done', 'archived'])

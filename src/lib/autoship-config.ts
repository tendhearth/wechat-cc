import { join } from 'node:path'
import z from 'zod'
import { readJsonObject, updateJsonFile } from './json-file'

const clockTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
const windowShape = z.object({ start: clockTime, end: clockTime })
  .refine(({ start, end }) => start !== end, '自动部署窗口的起止时间必须不同')

const shape = z.object({
  auto_ship: z.boolean().optional(),
  auto_ship_interval_min: z.number().optional(),
  auto_ship_window: windowShape.optional(),
  /** 窗外也放行:这台电脑没人碰过这么多分钟(缺省 30)。 */
  auto_ship_idle_min: z.number().optional(),
  repo_url: z.string().optional(),
})

export type AutoshipConfig = z.infer<typeof shape>

const configPath = (stateDir: string) => join(stateDir, 'self-change', 'autoship-config.json')

export function loadAutoshipConfig(stateDir: string): AutoshipConfig {
  return shape.parse(readJsonObject(configPath(stateDir)))
}

export function patchAutoshipConfig(stateDir: string, patch: Partial<AutoshipConfig>): void {
  updateJsonFile(configPath(stateDir), raw => { Object.assign(raw, patch); shape.parse(raw) }, { mode: 0o600 })
}

const DEFAULT_WINDOW = { start: '01:00', end: '07:00' }

export const DEFAULT_IDLE_MIN = 30

/**
 * 本地墙上时钟，含起点、不含终点。跨午夜时取两段的并集。
 * 窗外但这台电脑已经 `auto_ship_idle_min` 分钟没人碰(键鼠) ⇒ 也放行:Mac 夜里多半睡着,
 * 睡着时 daemon 的定时器不走,只认夜间窗几乎装不上(2026-11-28 实测)。探不到空闲时长(null)按「有人」算。
 */
export function autoshipWindowStatus(config: AutoshipConfig, now: number, idleSeconds?: number | null): string | null {
  const { start, end } = config.auto_ship_window ?? DEFAULT_WINDOW
  const idleMin = Math.max(5, config.auto_ship_idle_min ?? DEFAULT_IDLE_MIN)
  if (typeof idleSeconds === 'number' && Number.isFinite(idleSeconds) && idleSeconds >= idleMin * 60) return null
  const date = new Date(now)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (start < end ? clock >= start && clock < end : clock >= start || clock < end) return null
  const next = new Date(date)
  if (clock >= start) next.setDate(next.getDate() + 1)
  next.setHours(Number(start.slice(0, 2)), Number(start.slice(3)), 0, 0)
  return `当前在自动部署时间窗 ${start}–${end} 之外,电脑也不是没人用够 ${idleMin} 分钟。下次窗口从本地时间 ${next.toLocaleString('zh-CN', { hour12: false })} 开始。`
}

import { join } from 'node:path'
import z from 'zod'
import { readJsonObject, updateJsonFile } from './json-file'

const shape = z.object({
  auto_ship: z.boolean().optional(),
  auto_ship_interval_min: z.number().optional(),
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

/**
 * 项目登记(别名 → 文件夹,state/projects.json)。架构终态 A6:以前挂在 ilink 适配器上(`ilink.projects` /
 * `ilink.loadProjects`),可它跟微信一点关系都没有 —— 只是读写一个文件。现在是地基里的一样东西,谁要谁拿。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addProject, listProjects, setCurrent, removeProject } from '../lib/project-registry'
import { readJsonFile } from '../lib/read-json-file'
import type { WechatProjectsDep } from './wechat-tool-deps'

export interface ProjectsSnapshot { projects: Record<string, { path: string; last_active: number }>; current: string | null }

export interface Projects extends WechatProjectsDep {
  /** 整份快照(各项目最后用过的时间是毫秒);文件没有 / 读坏了 ⇒ 空。 */
  load(): ProjectsSnapshot
}

export function makeProjects(stateDir: string): Projects {
  const projectsFile = join(stateDir, 'projects.json')
  return {
    list() {
      return listProjects(projectsFile).map(v => ({ alias: v.alias, path: v.path, current: v.is_current }))
    },
    async switchTo(alias) {
      try {
        setCurrent(projectsFile, alias)
        const entry = listProjects(projectsFile).find(v => v.alias === alias)
        if (!entry) return { ok: false as const, reason: `alias '${alias}' not found after switch` }
        return { ok: true as const, path: entry.path }
      } catch (err) {
        return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
      }
    },
    async add(alias, path) { addProject(projectsFile, alias, path) },
    async remove(alias) { removeProject(projectsFile, alias) },
    load() {
      if (!existsSync(projectsFile)) return { projects: {}, current: null }
      try {
        // 容忍 BOM(PowerShell 写的 UTF-8 带 BOM,裸 JSON.parse 会炸;仓库守卫 read-json-file.test 管着)
        const parsed = readJsonFile<{
          projects?: Record<string, { path: string; last_active: string }>
          current?: string | null
        }>(projectsFile)
        const out: Record<string, { path: string; last_active: number }> = {}
        for (const [alias, entry] of Object.entries(parsed.projects ?? {})) {
          out[alias] = { path: entry.path, last_active: new Date(entry.last_active).getTime() }
        }
        return { projects: out, current: parsed.current ?? null }
      } catch {
        return { projects: {}, current: null }
      }
    },
  }
}

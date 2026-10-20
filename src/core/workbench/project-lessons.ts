/**
 * 项目经验(第二轮对标 ★2,对标 Devin Knowledge):主人写给某个项目的几句话(「这个仓库用 bun,不要 npm」),
 * 不管哪家执行者来做这个项目都照着做 —— 各家自己的记忆文件换一家就丢,「不绑一家」要求经验放在 CC 这边。
 * v1 只存在 daemon(project-lessons.json,按源项目路径),不写进主人的仓库。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WorkbenchStore } from './store'

export const LESSONS_FILE = 'project-lessons.json'
export const LESSONS_MAX = 10
export const LESSON_MAX_CHARS = 200

export interface Lesson { id: string; text: string; at: number }
type All = Record<string, Lesson[]>

export function lessonsBlock(lessons: readonly Lesson[]): string | null {
  return lessons.length ? `这个项目的经验(主人写的,所有执行者都照着做):\n${lessons.map(l => `- ${l.text}`).join('\n')}` : null
}

/** 一件事的源项目:独立工作区算它的源项目;随手交办(managed)没有项目 ⇒ null。读不到任务也 ⇒ null。 */
export function lessonSourcePath(store: Pick<WorkbenchStore, 'get' | 'worktrees'>, taskId: string): string | null {
  try { const task = store.get(taskId); return store.worktrees.get(taskId)?.projectPath ?? (task.workspaceKind === 'managed' ? null : task.path) } catch { return null }
}

export function makeProjectLessons(stateDir: string, now: () => number = Date.now) {
  const file = join(stateDir, LESSONS_FILE)
  const read = (): All => {
    if (!existsSync(file)) return {}
    try { const v = readJsonFile<unknown>(file); return v && typeof v === 'object' && !Array.isArray(v) ? v as All : {} } catch { return {} }
  }
  const write = (all: All) => { mkdirSync(stateDir, { recursive: true }); const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, JSON.stringify(all, null, 1) + '\n'); renameSync(tmp, file) }
  const norm = (t: string) => t.replace(/[ \t]+/g, ' ').trim()
  return {
    list(projectPath: string): Lesson[] { const v = read()[projectPath]; return Array.isArray(v) ? v.filter(l => l && typeof l.text === 'string') : [] },
    add(projectPath: string, raw: string): { ok: true; lesson: Lesson } | { ok: false; error: 'invalid' | 'duplicate' | 'full' } {
      const text = norm(raw)
      // 一行、有上限、不带尖括号(经验进每家执行者的指令,不让它伪造标签)
      if (!text || /[\r\n<>]/.test(text) || [...text].length > LESSON_MAX_CHARS) return { ok: false, error: 'invalid' }
      const all = read(), cur = all[projectPath] ?? []
      if (cur.some(l => l.text === text)) return { ok: false, error: 'duplicate' }
      if (cur.length >= LESSONS_MAX) return { ok: false, error: 'full' }
      const lesson = { id: randomBytes(4).toString('hex'), text, at: now() }
      all[projectPath] = [...cur, lesson]; write(all)
      return { ok: true, lesson }
    },
    /** 按 id 删(手机:列表可能是旧的,按编号会删错)。 */
    removeById(projectPath: string, id: string): boolean {
      const all = read(), cur = all[projectPath] ?? []
      const i = cur.findIndex(l => l.id === id)
      if (i < 0) return false
      cur.splice(i, 1)
      if (cur.length) all[projectPath] = cur; else delete all[projectPath]
      write(all); return true
    },
    /** 按编号删(从 1 开始,同 list 的顺序)。 */
    remove(projectPath: string, n: number): boolean {
      const all = read(), cur = all[projectPath] ?? []
      if (!Number.isInteger(n) || n < 1 || n > cur.length) return false
      cur.splice(n - 1, 1)
      if (cur.length) all[projectPath] = cur; else delete all[projectPath]
      write(all); return true
    },
  }
}
export type ProjectLessons = ReturnType<typeof makeProjectLessons>

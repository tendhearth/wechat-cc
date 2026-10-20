/**
 * 独立工作区的脚本(2026-10-20,对标 Conductor):仓库根 `tendhearth.json` 里的
 *   {"scripts":{"setup":"…","run":"…","archive":"…"}}
 * setup = 工作区建好后跑一次(装依赖、拷配置),run = 主人点「运行」时起的开发服务,archive = 删工作区前收尾。
 *
 * 读法钉死在「建工作区时的提交」(workbench_worktrees.script_sha):`git cat-file blob <sha>:tendhearth.json`,
 * 从不读工作树 —— 执行者在工作区里改了 tendhearth.json、甚至提交到分支上,要跑的脚本都不会变,批准过的内容就是要跑的内容。
 * 这里只读、只算,不执行(执行见 script-runner.ts)。
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { git, headSha } from './worktree-workspaces'

export const SCRIPTS_FILE = 'tendhearth.json'
export const SCRIPTS_FILE_MAX_BYTES = 64 * 1024
export const SCRIPT_MAX_BYTES = 4 * 1024
export const SCRIPT_KINDS = ['setup', 'run', 'archive'] as const
export type ScriptKind = typeof SCRIPT_KINDS[number]
/** 没写 / 空串 ⇒ null。 */
export type ScriptsConfig = Record<ScriptKind, string | null>

export type ParsedScripts = { config: ScriptsConfig } | { config: null; reason: string }

/** 解析 tendhearth.json 的文本。不认识的键一律忽略;没有 scripts ⇒ 三项都是 null(不算坏)。 */
export function parseScriptsConfig(text: string): ParsedScripts {
  if (Buffer.byteLength(text, 'utf8') > SCRIPTS_FILE_MAX_BYTES) return { config: null, reason: 'file_too_large' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { config: null, reason: 'invalid_json' } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, reason: 'not_object' }
  const scripts = (raw as Record<string, unknown>).scripts
  const config: ScriptsConfig = { setup: null, run: null, archive: null }
  if (scripts === undefined || scripts === null) return { config }
  if (typeof scripts !== 'object' || Array.isArray(scripts)) return { config: null, reason: 'scripts_not_object' }
  for (const kind of SCRIPT_KINDS) {
    const value = (scripts as Record<string, unknown>)[kind]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return { config: null, reason: `${kind}_not_string` }
    if (Buffer.byteLength(value, 'utf8') > SCRIPT_MAX_BYTES) return { config: null, reason: `${kind}_too_large` }
    if (value.trim()) config[kind] = value
  }
  return { config }
}

/** 内容哈希:批准按 (仓库, 哈希) 记,脚本改一个字就要重新批。键序固定,不受文件里的写法影响。 */
export function scriptsHash(config: ScriptsConfig): string {
  return createHash('sha256').update(JSON.stringify({ setup: config.setup, run: config.run, archive: config.archive })).digest('hex')
}

/** 批准记录的仓库键:真实路径;win32 大小写不敏感 ⇒ 小写。 */
export function repoKeyOf(repoRoot: string): string {
  let path: string
  try { path = realpathSync.native(repoRoot) } catch { try { path = realpathSync(repoRoot) } catch { path = repoRoot } }
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** 建工作区时记下的 script_sha:工作区当前 HEAD;git 出错 ⇒ null(只是没有脚本,不拦建任务)。 */
export function pinnedScriptSha(root: string): string | null {
  try { return headSha(root) || null } catch { return null }
}

/** none = 这个提交里没有 tendhearth.json;invalid = 有但读不懂 / 超限 / 提交不在。 */
export type PinnedScripts =
  | { kind: 'none' }
  | { kind: 'ok'; config: ScriptsConfig; hash: string }
  | { kind: 'invalid'; reason: string }

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const CACHE_MAX = 256
// 提交内容不可变 ⇒ (仓库, 提交) 的结果可以一直缓存;git 自己出错的不缓存(下次再试)。
const cache = new Map<string, PinnedScripts>()

/** 按建工作区时的提交读脚本(`git cat-file`,不碰工作树)。 */
export function readPinnedScripts(repoRoot: string, sha: string): PinnedScripts {
  if (!SHA.test(sha)) return { kind: 'invalid', reason: 'invalid_sha' }
  const key = `${repoRoot}\0${sha}`
  const hit = cache.get(key)
  if (hit) return hit
  let result: PinnedScripts
  try { git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]) } catch { return { kind: 'invalid', reason: 'commit_missing' } }
  let type = ''
  try { type = git(repoRoot, ['cat-file', '-t', `${sha}:${SCRIPTS_FILE}`]) } catch { /* 这个提交里没有 */ }
  if (!type) result = { kind: 'none' }
  else if (type !== 'blob') result = { kind: 'invalid', reason: 'not_a_file' }
  else {
    try {
      // 先看大小再读:超限的不往内存里拉
      const size = Number(git(repoRoot, ['cat-file', '-s', `${sha}:${SCRIPTS_FILE}`]))
      if (!Number.isFinite(size) || size > SCRIPTS_FILE_MAX_BYTES) result = { kind: 'invalid', reason: 'file_too_large' }
      else {
        const parsed = parseScriptsConfig(git(repoRoot, ['cat-file', 'blob', `${sha}:${SCRIPTS_FILE}`]))
        result = parsed.config ? { kind: 'ok', config: parsed.config, hash: scriptsHash(parsed.config) } : { kind: 'invalid', reason: parsed.reason }
      }
    } catch { return { kind: 'invalid', reason: 'read_failed' } }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, result)
  return result
}

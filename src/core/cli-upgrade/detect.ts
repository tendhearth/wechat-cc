/**
 * 探测:装的是哪个版本、最新是哪个版本。只读 —— 不装、不写任何东西。
 *
 * 查最新走官方发布元数据(网络守护不管下载 / 元数据,它只管模型调用),失败由调用方退避
 * (no-retry-storm:断网时不能一分钟打一次)。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import type { CliSpec } from './specs'
import { parseVersion } from './version'

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean; error?: string }
/** 跑一个外部命令。注入点:测试用临时目录里的假 CLI,永远不碰主人真装的那几个。 */
export type CommandRunner = (cmd: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<RunResult>

/** 缺省实现:execFile(不经 shell),stdin 关掉(升级器不许等人敲字),超时杀掉。 */
export const defaultRunner: CommandRunner = (cmd, args, opts) => new Promise((resolve) => {
  try {
    const child = execFile(cmd, [...args], {
      timeout: opts?.timeoutMs ?? 15_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
      const code = e ? (typeof e.code === 'number' ? e.code : null) : 0
      resolve({
        code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(e?.killed ? { timedOut: true } : {}),
        ...(e && typeof e.code !== 'number' ? { error: e.message } : {}),
      })
    })
    child.stdin?.end()
  } catch (err) {
    resolve({ code: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) })
  }
})

/** `<bin> --version` → 版本号;打不出来 ⇒ null(二进制坏了 / 不存在)。 */
export async function installedVersion(spec: CliSpec, bin: string, run: CommandRunner): Promise<string | null> {
  const r = await run(bin, ['--version'], { timeoutMs: 15_000 })
  if (r.code !== 0) return null
  return parseVersion(spec, `${r.stdout}\n${r.stderr}`)
}

export interface LatestResult { version: string | null; error?: string; source: string }

export interface LatestDeps {
  fetch: typeof globalThis.fetch
  homeDir: string
  timeoutMs?: number
}

/**
 * Claude Code 的更新频道:`~/.claude/settings.json` 的 `autoUpdatesChannel`(stable / latest,缺省 latest)。
 * 对着主人选的频道比,不然 stable 频道的人会被我们「升」到 latest 上。
 */
export function claudeUpdateChannel(homeDir: string): 'latest' | 'stable' {
  try {
    const p = join(homeDir, '.claude', 'settings.json')
    if (!existsSync(p)) return 'latest'
    const s = readJsonFile<{ autoUpdatesChannel?: unknown }>(p)
    return s.autoUpdatesChannel === 'stable' ? 'stable' : 'latest'
  } catch { return 'latest' }
}

const CURSOR_VERSION_IN_SCRIPT = /downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{5,})\//

export async function latestVersion(spec: CliSpec, deps: LatestDeps): Promise<LatestResult> {
  const src = spec.latest
  const timeoutMs = deps.timeoutMs ?? 15_000
  if (src.kind === 'none') return { version: null, source: 'none' }
  try {
    if (src.kind === 'npm') {
      const url = `https://registry.npmjs.org/-/package/${src.pkg}/dist-tags`
      const res = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
      if (!res.ok) return { version: null, error: `HTTP ${res.status}`, source: url }
      const tags = await res.json() as Record<string, unknown>
      const tag = spec.id === 'claude' ? claudeUpdateChannel(deps.homeDir) : 'latest'
      const v = typeof tags[tag] === 'string' ? tags[tag] as string : typeof tags.latest === 'string' ? tags.latest as string : null
      return v ? { version: v, source: `npm ${src.pkg}@${tag}` } : { version: null, error: 'no dist-tag', source: url }
    }
    const res = await deps.fetch(src.url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { version: null, error: `HTTP ${res.status}`, source: src.url }
    const m = CURSOR_VERSION_IN_SCRIPT.exec(await res.text())
    return m ? { version: m[1]!, source: src.url } : { version: null, error: 'version not found in install script', source: src.url }
  } catch (err) {
    return { version: null, error: err instanceof Error ? err.message : String(err), source: src.kind === 'npm' ? `npm ${src.pkg}` : src.url }
  }
}

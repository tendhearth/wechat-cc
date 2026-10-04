/**
 * 安装布局 → 能不能退回、怎么退回。
 *
 * 三家官方安装器都把旧版本留在磁盘上,入口是一个指向「当前版本」的符号链接:
 *
 *  - Claude Code(原生安装):`~/.local/bin/claude` → `~/.local/share/claude/versions/<ver>`(单个可执行文件)
 *  - Codex(standalone 安装器):`~/.codex/packages/standalone/current` → `releases/<ver>-<triple>`,
 *    `~/.local/bin/codex` → `current/bin/codex`
 *  - cursor-agent:`~/.local/bin/cursor-agent`(和 `agent`)→ `~/.local/share/cursor-agent/versions/<ver>/cursor-agent`
 *
 * 退回 = 把那个链接**原子地**改指回旧版本(建临时链接再 rename),和安装器自己切版本是同一个动作;
 * 不下载、不改任何二进制。agy 是单个文件、升级器原地替换,不留旧版本 ⇒ 退不回,只能给主人手动步骤。
 * npm / brew 等其它装法:Claude 还能用官方 `claude install <ver>`;其余退不回。
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { CliSpec } from './specs'
import { compareVersions } from './version'

export type Layout =
  | { kind: 'claude-versions'; link: string; versionsDir: string }
  | { kind: 'codex-standalone'; currentLink: string; releasesDir: string }
  | { kind: 'cursor-versions'; links: string[]; versionsDir: string }
  /** SDK 自带的 claude(node_modules 里)—— 不是主人装的 CLI,我们不碰。 */
  | { kind: 'bundled' }
  | { kind: 'other'; realPath: string | null }

function linkTarget(p: string): string | null {
  try {
    if (!lstatSync(p).isSymbolicLink()) return null
    const t = readlinkSync(p)
    return isAbsolute(t) ? t : resolve(dirname(p), t)
  } catch { return null }
}

function real(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

const has = (p: string, ...parts: string[]) => p.includes(`${sep}${parts.join(sep)}${sep}`)

export function detectLayout(spec: CliSpec, binPath: string): Layout {
  const rp = real(binPath)
  if (rp && /node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk/.test(rp)) return { kind: 'bundled' }
  if (spec.id === 'claude') {
    const t = linkTarget(binPath)
    if (t && basename(dirname(t)) === 'versions' && has(t, 'claude', 'versions')) {
      return { kind: 'claude-versions', link: binPath, versionsDir: dirname(t) }
    }
  }
  if (spec.id === 'codex' && rp && has(rp, '.codex', 'packages', 'standalone', 'releases')) {
    const i = rp.indexOf(`${sep}releases${sep}`)
    const root = rp.slice(0, i)
    const currentLink = join(root, 'current')
    if (linkTarget(currentLink)) return { kind: 'codex-standalone', currentLink, releasesDir: join(root, 'releases') }
  }
  if (spec.id === 'cursor') {
    const t = linkTarget(binPath)
    if (t && basename(t) === 'cursor-agent' && basename(dirname(dirname(t))) === 'versions') {
      const versionsDir = dirname(dirname(t))
      // 官方安装脚本同时建 cursor-agent 和 agent 两个链接;两个都指进同一个 versions 才一起改。
      const links = [binPath]
      const sibling = join(dirname(binPath), 'agent')
      const st = linkTarget(sibling)
      if (st && dirname(dirname(st)) === versionsDir) links.push(sibling)
      return { kind: 'cursor-versions', links, versionsDir }
    }
  }
  return { kind: 'other', realPath: rp }
}

/** 这个布局下磁盘上还留着哪些版本(给「没记下升级前版本」时挑一个退回目标用)。 */
export function versionsOnDisk(spec: CliSpec, layout: Layout): string[] {
  try {
    if (layout.kind === 'claude-versions') return readdirSync(layout.versionsDir).filter(n => !n.startsWith('.'))
    if (layout.kind === 'cursor-versions') return readdirSync(layout.versionsDir).filter(n => !n.startsWith('.') && existsSync(join(layout.versionsDir, n, 'cursor-agent')))
    if (layout.kind === 'codex-standalone') {
      return readdirSync(layout.releasesDir).filter(n => !n.startsWith('.')).map(n => n.replace(/-(?:aarch64|x86_64|arm64|x64)-.*$/, ''))
    }
  } catch { /* 读不出就当没有 */ }
  void spec
  return []
}

/** 比 `current` 旧的版本里最新的那一个。 */
export function previousOnDisk(spec: CliSpec, layout: Layout, current: string): string | null {
  const older = versionsOnDisk(spec, layout).filter(v => compareVersions(spec, v, current) < 0)
  older.sort((a, b) => compareVersions(spec, b, a))
  return older[0] ?? null
}

/** 原子改指:先在同目录建临时链接,再 rename 盖过去 —— 任何一刻入口都指着一个完整的版本。 */
export function repointSymlink(link: string, target: string): void {
  const tmp = `${link}.cc-rollback-${process.pid}-${Date.now()}`
  try { unlinkSync(tmp) } catch { /* 没有就算了 */ }
  symlinkSync(target, tmp)
  try { renameSync(tmp, link) } catch (err) { try { unlinkSync(tmp) } catch { /* ignore */ } ; throw err }
}

export type RollbackPlan =
  | { kind: 'repoint'; links: Array<{ link: string; target: string }> }
  | { kind: 'install'; args: string[] }
  | { kind: 'impossible'; reason: string }

/** 退回到 `version` 要做什么。只看磁盘,不动任何东西。 */
export function planRollback(spec: CliSpec, layout: Layout, version: string): RollbackPlan {
  if (layout.kind === 'claude-versions') {
    const target = join(layout.versionsDir, version)
    if (existsSync(target)) return { kind: 'repoint', links: [{ link: layout.link, target }] }
  }
  if (layout.kind === 'codex-standalone') {
    let dirs: string[] = []
    try { dirs = readdirSync(layout.releasesDir) } catch { /* ignore */ }
    const hit = dirs.find(d => d === version || d.startsWith(`${version}-`))
    if (hit && existsSync(join(layout.releasesDir, hit))) {
      return { kind: 'repoint', links: [{ link: layout.currentLink, target: join(layout.releasesDir, hit) }] }
    }
  }
  if (layout.kind === 'cursor-versions') {
    const target = join(layout.versionsDir, version, 'cursor-agent')
    if (existsSync(target)) return { kind: 'repoint', links: layout.links.map(link => ({ link, target })) }
  }
  if (layout.kind === 'bundled') return { kind: 'impossible', reason: 'SDK 自带的二进制,不归自动升级管' }
  if (spec.installVersionArgs) return { kind: 'install', args: spec.installVersionArgs(version) }
  if (spec.id === 'agy') return { kind: 'impossible', reason: 'agy 的升级器原地替换二进制,不保留旧版本' }
  return { kind: 'impossible', reason: `本机磁盘上没有 ${version},而且这种装法没有官方「装指定版本」的命令` }
}

/** 给主人的手动退回步骤(自动退不回时)。 */
export function manualRollbackSteps(spec: CliSpec, version: string | null): string {
  const v = version ?? '<上一个能用的版本>'
  switch (spec.id) {
    case 'claude': return `终端里跑 \`claude install ${v}\`,然后 \`wechat-cc selftest chat --provider claude\` 确认。`
    case 'codex': return `standalone 装法:把 ~/.codex/packages/standalone/current 改指回 releases/${v}-<平台>;npm 装法:\`npm i -g @openai/codex@${v}\`。然后 \`wechat-cc selftest chat --provider codex\` 确认。`
    case 'cursor': return `把 ~/.local/bin/cursor-agent(和 agent)改指回 ~/.local/share/cursor-agent/versions/${v}/cursor-agent,然后 \`wechat-cc selftest chat --provider cursor\` 确认。`
    case 'agy': return `agy 不保留旧版本:先在微信里用别的 provider(/claude 等),等 agy 出修复版后 \`wechat-cc cli upgrade agy\`。`
  }
}

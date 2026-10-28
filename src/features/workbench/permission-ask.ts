/**
 * permission-ask.ts — 一起做的一条权限请求 → 放行规则的请求(spec 2026-10-19-permission-rules-design)。
 *
 * 项目根:开着的独立工作区 = 它的根(写文件只有在这里才算低风险,10-19 定);否则 = 任务路径。都先 realpath
 * (Windows 走 .native),目录没了 ⇒ null(没有任何「项目内」待遇)。一起做的任务都是主人建的 —— 建任务的路由全是
 * admin、微信建任务只认主人那条对话 —— 所以 tier 一律 admin。
 */
import { isIssueIntent } from './issue-intake'
import { realpathSync } from 'node:fs'
import type { PermissionAsk } from '../../domain/permission-rules/types'
import type { PermissionFacts } from '../../adapters/workbench/permissions'

const INTENT_MAX = 2000

function real(path: string): string | null {
  try { return realpathSync.native(path) } catch { try { return realpathSync(path) } catch { return null } }
}

export function workbenchAsk(
  task: { id: string; path: string; providerId: string },
  worktree: { root: string; removedAt: number | null } | null,
  intent: string | null,
  facts: PermissionFacts,
): PermissionAsk {
  const isolated = !!worktree && worktree.removedAt == null
  const project = real(isolated ? worktree!.root : task.path)
  const ask: PermissionAsk = {
    surface: 'workbench', provider: task.providerId, tool: facts.tool,
    cwd: facts.cwd ?? null, project, isolatedWorktree: isolated && project !== null, tier: 'admin', scope: task.id,
  }
  if (facts.command) ask.command = facts.command
  if (facts.paths?.length) ask.paths = facts.paths
  if (facts.description) ask.description = facts.description
  const said = intent?.trim()
  if (said) ask.intent = said.slice(0, INTENT_MAX)
  if (isIssueIntent(intent)) ask.untrustedIntent = true
  return ask
}

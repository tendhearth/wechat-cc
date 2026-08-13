/**
 * Optional MCP client to a local `hearth` server — pushes distilled
 * knowledge into hearth's vault (memory-infra Phase 1, wechat-cc side).
 *
 * Independence is the whole point: hearth is a separate project the
 * operator may not have installed or running. `connectHearth` returns
 * `null` (never throws) both when the feature is off in config AND when
 * hearth is unreachable (not installed, wrong path, crashed on spawn,
 * doesn't answer listTools, ...). Callers treat `null` as "no hearth
 * this cycle" and skip the push — wechat-cc's own behavior never
 * depends on hearth being present.
 */
import { createMcpToolBridge, type McpStdioSpec, type McpToolBridge } from '../../core/openai-mcp-bridge'

/**
 * Structural shape of a hearth change-plan. wechat-cc builds one of these
 * (from knowledge-distill) and passes it through to hearth's
 * `vault_plan_submit` tool essentially opaquely — hearth owns validation.
 */
export interface HearthChangePlan {
  change_id?: string
  source_id?: string
  ops?: unknown[]
  risk?: string
  requires_review?: boolean
  [key: string]: unknown
}

export interface HearthClient {
  submit(plan: unknown): Promise<{ change_id: string; requires_review: boolean }>
  applyForOwner(changeId: string, ownerId: string, channel: string): Promise<{ ok: boolean; requires_review?: boolean }>
  close(): Promise<void>
}

export interface HearthConfig {
  hearth_enabled: boolean
  hearth_vault: string | null
  hearth_cmd: string | null
}

const DEFAULT_HEARTH_CMD = 'hearth mcp serve'

function specFromCmd(cmd: string | null, vault: string): McpStdioSpec {
  const [command, ...args] = (cmd ?? DEFAULT_HEARTH_CMD).trim().split(/\s+/)
  return {
    command: command ?? 'hearth',
    args,
    env: { HEARTH_VAULT: vault },
  }
}

export async function connectHearth(
  cfg: HearthConfig,
  opts?: { log?: (tag: string, msg: string) => void; makeBridge?: (specs: Record<string, McpStdioSpec>) => Promise<McpToolBridge> },
): Promise<HearthClient | null> {
  if (!cfg.hearth_enabled || !cfg.hearth_vault) return null

  const spec = specFromCmd(cfg.hearth_cmd, cfg.hearth_vault)
  // Note: createMcpToolBridge's real signature (src/core/openai-mcp-bridge.ts)
  // only accepts { makeClient? }, not a `log` option as the brief sketched —
  // logging on connect failure happens below in this function instead.
  const makeBridge = opts?.makeBridge ?? ((specs: Record<string, McpStdioSpec>) => createMcpToolBridge(specs))

  let bridge: McpToolBridge
  try {
    bridge = await makeBridge({ hearth: spec })
  } catch (err) {
    opts?.log?.('HEARTH', `hearth unreachable, skipping (feature stays dormant): ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  return {
    async submit(plan) {
      const text = await bridge.call('vault_plan_submit', { change_plan: plan })
      const parsed = JSON.parse(text) as { change_id: string; requires_review: boolean }
      return { change_id: parsed.change_id, requires_review: parsed.requires_review }
    },
    async applyForOwner(changeId, ownerId, channel) {
      const text = await bridge.call('vault_apply_for_owner', { change_id: changeId, owner_id: ownerId, channel })
      const parsed = JSON.parse(text) as { ok: boolean; requires_review?: boolean }
      return { ok: parsed.ok, requires_review: parsed.requires_review }
    },
    async close() {
      await bridge.close().catch(() => {})
    },
  }
}

/**
 * wire-plugins.ts — wechat / delegate stdio MCP specs + the decoupled plugin
 * lane. 从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,spec
 * 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,只参数化。
 *
 * 产物是后面三块的输入:knowledge(loadedPlugins)、model-options(claude 的
 * wechat/delegate spec + pluginMcpForClaude)、instructions(delegateStdioByProvider
 * + knowledgePluginNames),以及 registerProviders 的各家 spec。
 */
import type { ProviderId } from '../../core/conversation'
import { capabilitiesFor, capabilityProviderIds } from '../../core/capability-matrix'
import { wechatStdioMcpSpec, delegateStdioMcpSpec, type McpStdioSpec } from './mcp-specs'
import { loadPlugins, pluginMcpSpecs } from '../plugins/registry'
import { resolveBundledPlugins } from '../plugins/paths'
import { buildPluginsHealth, pluginsHealthWarning, type PluginsHealth } from '../plugins/health'
// JSON import — version field is read at module init. resolveJsonModule is
// on in tsconfig, and `with { type: 'json' }` is the spec'd syntax.
import selfPkg from '../../../package.json' with { type: 'json' }
import type { BootstrapDeps, BootstrapCtx } from './types'

export interface PluginsSlice {
  wechatStdioForClaude: McpStdioSpec | null
  wechatStdioForCodex: McpStdioSpec | null
  wechatStdioForCursor: McpStdioSpec | null
  wechatStdioForOpenai: McpStdioSpec | null
  wechatStdioForGemini: McpStdioSpec | null
  wechatStdioForAgy: McpStdioSpec | null
  delegateStdioByProvider: Partial<Record<ProviderId, McpStdioSpec>>
  delegateStdioForClaude: McpStdioSpec | null
  delegateStdioForCodex: McpStdioSpec | null
  delegateStdioForCursor: McpStdioSpec | null
  delegateStdioForOpenai: McpStdioSpec | null
  loadedPlugins: ReturnType<typeof loadPlugins>
  pluginMcp: ReturnType<typeof pluginMcpSpecs>
  knowledgePluginNames: string[]
  pluginMcpForClaude: Record<string, { type: 'stdio' } & McpStdioSpec>
  /** GET /v1/health.plugins — what was actually loaded at boot (src/daemon/plugins/health.ts). */
  pluginsHealth: PluginsHealth
}

export function wirePlugins(
  deps: Pick<BootstrapDeps, 'internalApi'>,
  ctx: Pick<BootstrapCtx, 'stateDir' | 'log'>,
): PluginsSlice {
  // RFC 03 §5 — standalone wechat-mcp stdio server. When deps.internalApi is
  // wired, both providers receive a `wechat` MCP server spec that spawns
  // the wechat-mcp child with token-auth env vars.
  const wechatStdioForClaude: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'claude') : null
  const wechatStdioForCodex: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'codex') : null

  // RFC 03 P4 — delegate-mcp stdio server. Loaded alongside wechat-mcp so the
  // primary agent can call `delegate_<peer>(prompt)` to consult the OTHER
  // provider once. The peer is fixed per-spawn AND sourced from each provider's
  // ProviderCapabilities.defaultPeer — the single declaration site, so adding a
  // provider needs no edit here (its delegate spec is built iff it declares a
  // defaultPeer). Replaces the old per-provider literals + a 2-provider ternary.
  const delegateStdioByProvider: Partial<Record<ProviderId, McpStdioSpec>> = {}
  if (deps.internalApi) {
    for (const p of capabilityProviderIds()) {
      const peer = capabilitiesFor(p).defaultPeer
      if (peer) delegateStdioByProvider[p] = delegateStdioMcpSpec(deps.internalApi, peer)
    }
  }
  const delegateStdioForClaude: McpStdioSpec | null = delegateStdioByProvider.claude ?? null
  const delegateStdioForCodex: McpStdioSpec | null = delegateStdioByProvider.codex ?? null
  const delegateStdioForCursor: McpStdioSpec | null = delegateStdioByProvider.cursor ?? null
  const wechatStdioForCursor: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'cursor') : null
  const delegateStdioForOpenai: McpStdioSpec | null = delegateStdioByProvider.openai ?? null
  const wechatStdioForOpenai: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'openai') : null
  const wechatStdioForGemini: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'gemini') : null
  const wechatStdioForAgy: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'agy') : null

  // Decoupled plugin lane — third-party MCP tool providers
  // spawned as stdio children exactly like wechat/delegate, but discovered
  // from `{stateDir}/plugins/<name>/` (drop-in, survives upgrades) or the
  // bundled `plugins/` dir. wechat-cc never imports plugin code; the process
  // boundary + MCP wire protocol are the only coupling, so a plugin can be
  // any language. USER plugins default DISABLED (a manifest spawns a process
  // = arbitrary code; enable via dashboard / plugins.json); BUNDLED default
  // ENABLED. Unlike installUserMcp (which pollutes the human's global
  // ~/.claude.json), this injects only into the daemon-spawned providers.
  // Where the bundled plugins come from is logged on EVERY boot (2026-09-30):
  // from 09-11 the packaged daemon found none and said nothing for three weeks.
  const bundled = resolveBundledPlugins(ctx.stateDir)
  ctx.log('BOOT', bundled
    ? `plugin: bundled plugins dir ${bundled.dir} (via ${bundled.via})`
    : 'plugin: no bundled plugins dir found (env / `wechat-cc plugin source` pointer / app resources / repo all empty)')
  const loadedPlugins = loadPlugins({
    stateDir: ctx.stateDir,
    bundledDir: bundled?.dir ?? null,
    hostVersion: selfPkg.version,
    log: (m) => ctx.log('BOOT', `plugin: ${m}`),
  })
  const pluginsHealth = buildPluginsHealth({ stateDir: ctx.stateDir, resolution: bundled, loaded: loadedPlugins })
  const pluginsWarning = pluginsHealthWarning(pluginsHealth)
  if (pluginsWarning) ctx.log('BOOT', `plugin: ${pluginsWarning}`)
  const pluginMcp = pluginMcpSpecs(loadedPlugins)
  // Names of ACTUALLY-registered plugins (enabled AND ready — same gate
  // pluginMcpSpecs applies above), daemon-global (computed once at boot, NOT
  // per-chat), threaded into buildSystemPrompt's `knowledgePlugins` arg
  // (knowledge-orchestration design Task 2). Deliberately == Object.keys(
  // pluginMcp) rather than a looser `enabled`-only filter: a bundled
  // knowledge plugin (e.g. wxsearch) defaults ENABLED but is commonly NOT
  // READY (its healthcheck requires wxvault's decrypted output, which a
  // fresh install/dev box won't have yet) — mentioning it in the prompt
  // before its tools actually exist would send the agent at tools that
  // don't exist. Unknown plugin names are harmless — buildSystemPrompt
  // silently ignores anything outside KNOWN_KNOWLEDGE_PLUGINS.
  const knowledgePluginNames = Object.keys(pluginMcp)
  // Claude's SDK wants each server tagged `type: 'stdio'`; codex/cursor take
  // the bare {command,args,env} shape (structurally identical to McpStdioSpec).
  const pluginMcpForClaude = Object.fromEntries(
    Object.entries(pluginMcp).map(([k, s]) => [k, { type: 'stdio' as const, ...s }]),
  )

  return {
    wechatStdioForClaude, wechatStdioForCodex, wechatStdioForCursor, wechatStdioForOpenai, wechatStdioForGemini, wechatStdioForAgy,
    delegateStdioByProvider, delegateStdioForClaude, delegateStdioForCodex, delegateStdioForCursor, delegateStdioForOpenai,
    loadedPlugins, pluginMcp, knowledgePluginNames, pluginMcpForClaude, pluginsHealth,
  }
}

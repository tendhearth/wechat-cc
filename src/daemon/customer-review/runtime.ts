import type { Lifecycle } from '../../lib/lifecycle'
import type { Db } from '../../lib/db'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ProviderId } from '../../core/conversation'
import { createMcpToolBridge, type McpStdioSpec, type McpToolBridge } from '../../core/openai-mcp-bridge'
import { loadPlugins, pluginMcpSpecs } from '../plugins/registry'
import { bundledPluginsDir } from '../plugins/paths'
import { makeCustomerReviewStore } from './store'
import { makeCustomerReviewService, type CustomerReviewService } from './service'
import { WxvaultCustomerChatSource } from './wxvault-source'
import selfPkg from '../../../package.json' with { type: 'json' }

export interface CustomerReviewRuntime extends Lifecycle {
  service: CustomerReviewService
}

export interface StartCustomerReviewRuntimeDeps {
  stateDir: string
  db: Db
  registry: ProviderRegistry
  defaultProviderId: ProviderId
  log?: (tag: string, line: string) => void
}

export interface StartCustomerReviewRuntimeOptions {
  loadSpecs?: () => Record<string, McpStdioSpec>
  connect?: (specs: Record<string, McpStdioSpec>) => Promise<McpToolBridge>
}

function evaluator(deps: StartCustomerReviewRuntimeDeps): {
  provider: ProviderId
  evaluate: (prompt: string) => Promise<string>
} | null {
  const preferred = deps.registry.get(deps.defaultProviderId)?.provider.cheapEval
  if (preferred) return { provider: deps.defaultProviderId, evaluate: preferred }

  const fallback = deps.registry.getCheapEval()
  if (!fallback) return null
  const owner = deps.registry.list().find(id => deps.registry.get(id)?.provider.cheapEval === fallback)
  return owner ? { provider: owner, evaluate: fallback } : null
}

/**
 * Optional daemon runtime. Missing wxvault/model leaves the rest of wechat-cc
 * healthy and simply keeps Customer Review unwired (HTTP routes return 503).
 */
/**
 * How long the wxvault MCP handshake may hold up daemon boot.
 *
 * WHY THIS EXISTS: this runtime starts BEFORE wireMain(), so nothing polls
 * WeChat until it returns. The MCP SDK's own fallback is 60s per request and
 * boot needs two (initialize + listTools) — so a wxvault python child stuck on
 * a Full-Disk-Access prompt or a missing dependency used to mean ~2 minutes of
 * a totally unresponsive bot, with only a `CUSTOMER_REVIEW disabled:` line in
 * channel.log to explain it. An optional feature must not be able to do that.
 */
const CONNECT_TIMEOUT_MS = 8_000

export async function startCustomerReviewRuntime(
  deps: StartCustomerReviewRuntimeDeps,
  options: StartCustomerReviewRuntimeOptions = {},
): Promise<CustomerReviewRuntime | null> {
  // Whole-body guard: everything below is best-effort. Before this, a throw
  // from evaluator()/loadPlugins()/bundledPluginsDir() — all outside the inner
  // try — propagated to main.ts's catch, which shuts the daemon down. An
  // optional workspace must never be able to take the bot offline.
  try {
    return await startCustomerReviewRuntimeInner(deps, options)
  } catch (err) {
    deps.log?.('CUSTOMER_REVIEW', `disabled: startup failed — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function startCustomerReviewRuntimeInner(
  deps: StartCustomerReviewRuntimeDeps,
  options: StartCustomerReviewRuntimeOptions = {},
): Promise<CustomerReviewRuntime | null> {
  const evalConfig = evaluator(deps)
  if (!evalConfig) {
    deps.log?.('CUSTOMER_REVIEW', 'disabled: no one-shot evaluation provider is available')
    return null
  }

  const specs = options.loadSpecs?.() ?? pluginMcpSpecs(loadPlugins({
    stateDir: deps.stateDir,
    bundledDir: bundledPluginsDir(),
    hostVersion: selfPkg.version,
  }))
  const wxvault = specs.wxvault
  if (!wxvault) {
    deps.log?.('CUSTOMER_REVIEW', 'disabled: wxvault plugin is not enabled and ready')
    return null
  }

  let bridge: McpToolBridge | null = null
  try {
    const connect = (options.connect ?? createMcpToolBridge)({ wxvault })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      bridge = await Promise.race([
        connect,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`wxvault MCP handshake exceeded ${CONNECT_TIMEOUT_MS}ms`)),
            CONNECT_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      // The losing connect may still resolve later; close it so a late bridge
      // does not leave an orphaned python child holding the decrypted sqlite.
      void connect.then(late => { if (late !== bridge) void late.close().catch(() => {}) }).catch(() => {})
    }
    const tools = new Set(bridge.tools.map(tool => tool.name))
    if (!tools.has('list_conversations') || !tools.has('get_messages')) {
      await bridge.close()
      deps.log?.('CUSTOMER_REVIEW', 'disabled: wxvault does not expose the required read tools')
      return null
    }

    const service = makeCustomerReviewService({
      source: new WxvaultCustomerChatSource(bridge, { messageLimit: 2000 }),
      store: makeCustomerReviewStore(deps.db),
      evaluate: evalConfig.evaluate,
      provider: evalConfig.provider,
      messageLimit: 2000,
    })
    deps.log?.('CUSTOMER_REVIEW', `ready: wxvault + ${evalConfig.provider}`)
    let stopped = false
    return {
      name: 'customer-review',
      service,
      async stop() {
        if (stopped) return
        stopped = true
        await bridge!.close()
      },
    }
  } catch (error) {
    await bridge?.close().catch(() => {})
    deps.log?.('CUSTOMER_REVIEW', `disabled: wxvault connection failed (${error instanceof Error ? error.name : 'unknown error'})`)
    return null
  }
}

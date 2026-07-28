import type { Lifecycle } from '../../lib/lifecycle'
import type { Db } from '../../lib/db'
import type { ProviderRegistry } from '../../core/provider-registry'
import type { ProviderId } from '../../core/conversation'
import { createMcpToolBridge, type McpStdioSpec, type McpToolBridge } from '../../core/openai-mcp-bridge'
import { loadPlugins, pluginMcpSpecs } from '../plugins/registry'
import { bundledPluginsDir } from '../plugins/paths'
import { makeCustomerReviewStore } from './store'
import { makeCustomerReviewService, type CustomerReviewService } from './service'
import { WxvaultCustomerChatSource, CustomerChatSourceError } from './wxvault-source'
import type { CustomerChatSource, CustomerContact, CustomerMessage, CustomerMessageQuery } from './types'
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

  // Resolve the fallback by scanning the registry in the same preference order
  // getCheapEval() uses, rather than asking it for a function and then trying
  // to recognise that function again by reference identity. provider-registry
  // documents that a future provider may need `.bind(entry.provider)` — the day
  // that happens, identity comparison fails, `owner` is undefined, and the
  // whole workspace silently disables itself (routes 503) instead of merely
  // mislabelling which model ran.
  for (const id of deps.registry.list()) {
    const evaluate = deps.registry.get(id)?.provider.cheapEval
    if (evaluate) return { provider: id, evaluate }
  }
  return null
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

  const connect = options.connect ?? createMcpToolBridge

  /** Open a bridge, bounded by CONNECT_TIMEOUT_MS, and verify its tools. */
  async function openBridge(): Promise<McpToolBridge> {
    const pending = connect({ wxvault: wxvault! })
    let timer: ReturnType<typeof setTimeout> | undefined
    let bridge: McpToolBridge | undefined
    try {
      bridge = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`wxvault MCP handshake exceeded ${CONNECT_TIMEOUT_MS}ms`)),
            CONNECT_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      // A connect that lost the race may still resolve; close it so no orphaned
      // python child is left holding the decrypted sqlite open.
      const settled = bridge
      void pending.then(late => { if (late !== settled) void late.close().catch(() => {}) }).catch(() => {})
    }
    const tools = new Set(bridge.tools.map(tool => tool.name))
    if (!tools.has('list_conversations') || !tools.has('get_messages')) {
      await bridge.close().catch(() => {})
      throw new CustomerChatSourceError('WXVAULT_ERROR', 'wxvault does not expose the required read tools')
    }
    return bridge
  }

  const store = makeCustomerReviewStore(deps.db)
  // An analysis interrupted by a restart owns no in-memory task any more, and
  // markAnalyzing refuses to re-enter from `analyzing` — so without this the
  // row sits at 分析中 forever and 重新分析 answers INVALID_REVIEW_TRANSITION.
  const reclaimed = await store.reclaimStranded()
  if (reclaimed > 0) {
    deps.log?.('CUSTOMER_REVIEW', `reclaimed ${reclaimed} review(s) stranded in analyzing by a restart`)
  }

  const service = makeCustomerReviewService({
    source: new TransientWxvaultSource(openBridge),
    store,
    evaluate: evalConfig.evaluate,
    provider: evalConfig.provider,
    messageLimit: 2000,
  })
  deps.log?.('CUSTOMER_REVIEW', `ready: wxvault + ${evalConfig.provider} (connects on demand)`)
  return {
    name: 'customer-review',
    service,
    async stop() { /* nothing is held open between requests */ },
  }
}

/**
 * Opens a wxvault bridge per operation and closes it again.
 *
 * WHY NOT ONE LONG-LIVED BRIDGE (which is what this shipped as): wxvault's
 * macOS backend is a plain `Archive` — it loads contacts/conversations into
 * memory once and keeps sqlite handles open on the decrypted message DBs
 * (`RefreshingArchive` is Windows-only). Holding that for the daemon's whole
 * life meant two things, both bad:
 *
 *  - The workspace served the daemon's BOOT-TIME snapshot forever. A review of
 *    "the last 3 months" silently returned nothing after the daemon started —
 *    for a product whose entire premise is reading current WeChat history.
 *  - The desktop runs `plugin setup wxvault` on every launch, and that rewrites
 *    the decrypted DBs in place (`open(dec_path,"wb")`, truncate + rewrite, not
 *    an atomic rename). A held-open handle reading mid-rewrite yields
 *    `database disk image is malformed` or garbage rows.
 *
 * Every other wxvault consumer in this codebase already uses a transient
 * bridge — see the ingest tick's note about not opening a second set of MCP
 * processes on the same sqlite. This makes customer review behave the same,
 * and as a side effect keeps daemon boot off the MCP handshake entirely.
 *
 * The cost is one python spawn per operation. Reviews are minutes of
 * sequential LLM calls, so it does not register there; evidence expansion pays
 * it too, which is acceptable until it proves otherwise.
 */
export class TransientWxvaultSource implements CustomerChatSource {
  constructor(private readonly open: () => Promise<McpToolBridge>) {}

  private async withSource<T>(fn: (source: WxvaultCustomerChatSource) => Promise<T>): Promise<T> {
    const bridge = await this.open()
    try {
      return await fn(new WxvaultCustomerChatSource(bridge, { messageLimit: 2000 }))
    } finally {
      await bridge.close().catch(() => {})
    }
  }

  searchContacts(query: string): Promise<CustomerContact[]> {
    return this.withSource(source => source.searchContacts(query))
  }

  getMessages(input: CustomerMessageQuery): Promise<CustomerMessage[]> {
    return this.withSource(source => source.getMessages(input))
  }
}

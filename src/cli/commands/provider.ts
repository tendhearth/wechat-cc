// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { loadAgentConfig, saveAgentConfig, withModelForProvider, activeModel, type AgentConfig, type AgentProviderKind } from '../../lib/agent-config'
import { PROVIDER_IDS, isKnownProviderId } from '../../lib/provider-ids'
import { parseBoolValue } from '../flags'
import { ProviderShowOutput } from '../schema'
const providerShowCmd = defineCommand({
  meta: { name: 'show', description: 'Show selected agent provider' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  run({ args }) {
    const config = loadAgentConfig(STATE_DIR)
    // Read via activeModel(), not config.model directly: cursor/openai keep
    // their pin in cursorModel/openaiModel, and the generic `model` field can
    // hold a stale value left over from a previous claude/codex selection
    // (intentionally retained on provider switch — see computeProviderSetOutcome
    // — so switching back to claude/codex remembers its model). Reading
    // config.model unconditionally would print that stale value for the
    // wrong provider.
    if (args.json) console.log(JSON.stringify(ProviderShowOutput.parse(config), null, 2))
    else console.log(`provider: ${config.provider}${activeModel(config) ? ` (${activeModel(config)})` : ''} unattended=${config.dangerouslySkipPermissions}`)
  },
})

export interface ProviderSetArgs {
  provider: string
  model?: string
  baseUrl?: string
  unattended?: string
  autoStart?: string
  closeStopsDaemon?: string
}

export type ProviderSetOutcome =
  | { ok: true; config: AgentConfig; message: string; warning?: string }
  | { ok: false; error: string }

/**
 * Pure decision logic for `provider set` — no filesystem/env I/O beyond the
 * `env` param, so it's unit-testable without touching the real STATE_DIR
 * (which on a dev machine is the operator's live ~/.claude/channels/wechat
 * agent-config.json — tests must never write there).
 */
export function computeProviderSetOutcome(
  args: ProviderSetArgs,
  existing: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProviderSetOutcome {
  // 名单来自 lib/provider-ids(唯一事实源)。以前这里手写五家、漏了 agy:桌面
  // 「大脑」菜单选 agy → `provider set agy` 被拒 →「切换 provider 失败」。
  if (!isKnownProviderId(args.provider)) {
    return { ok: false, error: `provider must be one of ${PROVIDER_IDS.join(' | ')} (got: ${args.provider})` }
  }
  const provider: AgentProviderKind = args.provider
  const unattended = parseBoolValue(args.unattended)
  const autoStart = parseBoolValue(args.autoStart)
  const closeStopsDaemon = parseBoolValue(args.closeStopsDaemon)

  const warning = provider !== 'openai' && args.baseUrl !== undefined
    ? `--base-url is ignored for provider '${provider}' (only 'openai' uses it)`
    : undefined

  let next: AgentConfig = {
    ...existing,
    provider,
    ...(unattended !== undefined ? { dangerouslySkipPermissions: unattended } : {}),
    ...(autoStart !== undefined ? { autoStart } : {}),
    ...(closeStopsDaemon !== undefined ? { closeStopsDaemon } : {}),
  }
  // Persist an explicit --model into the field the target provider actually
  // reads (claude/codex share the generic `model`; cursor/openai each keep
  // their own). withModelForProvider is the single source of truth for that
  // mapping — writing straight into the generic `model` field for every
  // provider (the old behavior) was a latent bug: it silently no-opped
  // `provider set cursor --model ...` since cursor never reads `model`.
  if (args.model !== undefined) {
    next = withModelForProvider(next, provider, args.model)
  }
  // When switching provider, drop a stale model from the previous provider
  // unless the caller explicitly set one.
  if (existing.provider !== provider && args.model === undefined) {
    delete (next as Partial<AgentConfig>).model
  }

  if (provider === 'openai') {
    const baseUrl = args.baseUrl ?? existing.openaiBaseUrl
    if (!baseUrl) {
      return { ok: false, error: 'provider set openai: 需要 --base-url,例如 https://api.deepseek.com/v1;API key 走环境变量 WECHAT_OPENAI_API_KEY' }
    }
    if (!(args.model ?? existing.openaiModel)) {
      return { ok: false, error: 'provider set openai: 需要 --model,例如 deepseek-chat 或 kimi-k2.7-code' }
    }
    next = { ...next, openaiBaseUrl: baseUrl }
  }

  let message = `provider set: ${next.provider}${activeModel(next) ? ` (${activeModel(next)})` : ''} unattended=${next.dangerouslySkipPermissions} autoStart=${next.autoStart} closeStopsDaemon=${next.closeStopsDaemon}`
  if (provider === 'openai') {
    message += ` baseUrl=${next.openaiBaseUrl}`
    message += env.WECHAT_OPENAI_API_KEY
      ? `\n✓ 已检测到 WECHAT_OPENAI_API_KEY`
      : `\n记得设置 WECHAT_OPENAI_API_KEY(未检测到则 daemon 不会注册该 provider)`
  }

  return { ok: true, config: next, message, ...(warning ? { warning } : {}) }
}

const providerSetCmd = defineCommand({
  meta: { name: 'set', description: 'Switch agent provider (claude|codex|cursor|openai|gemini|agy), optionally with --model + --base-url + --unattended + --auto-start + --close-stops-daemon' },
  args: {
    provider: { type: 'positional', required: true, description: 'claude | codex | cursor | openai | gemini | agy', valueHint: 'claude|codex|cursor|openai|gemini|agy' },
    model: { type: 'string', description: 'Override default model (openai: required the first time, unless already stored)' },
    'base-url': { type: 'string', description: 'OpenAI-compatible API base URL — openai only, e.g. https://api.deepseek.com/v1 (required the first time, unless already stored)', valueHint: 'https://api.deepseek.com/v1' },
    // String, not boolean: matches the legacy parseBoolFlag tri-state semantics
    // (true / false / undefined). Citty's boolean type can't represent
    // "absent" vs "explicit false", and provider-set treats omitting
    // --unattended as "don't change the existing dangerouslySkipPermissions
    // setting" — distinct from an explicit `--unattended false`.
    unattended: { type: 'string', description: 'true | false | yes | no | on | off (omit to leave unchanged)', valueHint: 'true|false' },
    'auto-start': { type: 'string', description: 'true | false (omit to leave unchanged) — register service for boot/login auto-start', valueHint: 'true|false' },
    'close-stops-daemon': { type: 'string', description: 'true | false (omit to leave unchanged) — when true, closing the GUI window stops the daemon', valueHint: 'true|false' },
  },
  run({ args }) {
    const existing = loadAgentConfig(STATE_DIR)
    const outcome = computeProviderSetOutcome(
      { provider: args.provider, model: args.model, baseUrl: args['base-url'], unattended: args.unattended, autoStart: args['auto-start'], closeStopsDaemon: args['close-stops-daemon'] },
      existing,
    )
    if (!outcome.ok) {
      console.error(outcome.error)
      process.exit(2)
    }
    if (outcome.warning) console.error(outcome.warning)
    saveAgentConfig(STATE_DIR, outcome.config)
    console.log(outcome.message)
  },
})

export const providerCmd = defineCommand({
  meta: { name: 'provider', description: 'Agent provider config (claude / codex / cursor / openai / gemini / agy)' },
  subCommands: {
    show: providerShowCmd,
    set: providerSetCmd,
  },
})

/**
 * Tri-state boolean parser for citty string args that need to mirror the
 * legacy parseBoolFlag semantics: true / false / undefined. Used by
 * `provider set --unattended` (and reusable for any future flag where
 * "absent" is a distinct meaning from "explicit false").
 */


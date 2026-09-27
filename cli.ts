#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { defineCommand, runMain } from 'citty'
import selfPkg from './package.json' with { type: 'json' }
import { VERSION_LINE } from './src/lib/app-version'
import { STATE_DIR } from './src/lib/config'
import { loadAgentConfig, saveAgentConfig, withModelForProvider, activeModel, type AgentConfig, type AgentProviderKind } from './src/lib/agent-config'
import { PROVIDER_IDS, isKnownProviderId } from './src/lib/provider-ids'
import { analyzeDoctor, defaultDoctorDeps, printDoctor, probeFsAccessWarning, probeOutboundWarning, serviceStatus, setupStatus } from './src/cli/doctor'
import { buildServicePlan, installService, startService, stopService, uninstallService } from './src/cli/service-manager'
import { appMainBinaryPath, compiledBinaryPath, compiledRepoRoot, isCompiledBundle } from './src/lib/runtime-info'
import { delegateMemoryOp, type CliApiInfo } from './src/lib/cli-llm-eval'
import {
  DoctorOutput, SetupPollOutput, SetupStatusOutput, SetupQrJsonOutput,
  ServiceStatusOutput, ServiceInstallOutput, ServiceStartOutput, ServiceStopOutput, ServiceUninstallOutput,
  AccountRemoveOutput, DaemonKillOutput, ProviderShowOutput,
  MemoryListOutput, MemoryReadOutput, MemoryWriteOutput, MemoryProfileOutput, MemoryProfileStatusOutput,
  EventsListOutput, ObservationsListOutput, ObservationsArchiveOutput, MilestonesListOutput,
  SessionsListProjectsOutput, SessionsListChatsOutput, SessionsReadJsonlOutput, SessionsDeleteOutput, SessionsSearchOutput,
  DemoSeedOutput, DemoUnseedOutput, ReplyOutput,
  UpdateCheckOutput, UpdateApplyOutput, ConversationsListOutput,
  GuardStatusOutput, GuardEnableOutput, GuardDisableOutput,
  AvatarInfoOutput, AvatarSetOutput, AvatarRemoveOutput,
  LogOutput,
} from './src/cli/schema'
// 跨族帮手(2026-09-27 cli 拆分 Task 1 从这里搬出去的)。
import { emitJson } from './src/cli/output'
import { parseBoolValue, parseTimeoutMsFlag, parseBudgetUsdFlag, parseCountFlag } from './src/cli/flags'
import { readStdin } from './src/cli/stdin'
import { restartDaemonAndWait } from './src/cli/daemon-restart'
import { HELP_TEXT } from './src/cli/help'
// 命令族(2026-09-27 cli 拆分:每族一个文件,cli.ts 只登记)。
import { memoryCmd } from './src/cli/commands/memory'
import { selfCmd } from './src/cli/commands/self'
import { pluginCmd } from './src/cli/commands/plugin'
import { handCmd } from './src/cli/commands/hand'
import { sessionsCmd } from './src/cli/commands/sessions'
import { dialogueCmd } from './src/cli/commands/dialogue'

// PR4 batch 3c: parseCliArgs + CliArgs union deleted. All subcommands now
// flow through citty (see `cittyRoot` below). The previous gate
// `MIGRATED_COMMANDS.has(first)` is gone — citty handles unknown commands
// by printing its auto-generated usage. Bare `wechat-cc` / `--help` /
// `-h` / `help` is intercepted in main() and renders HELP_TEXT.


/**
 * citty migration — batch 1.
 *
 * Subcommands listed in `MIGRATED_COMMANDS` go through the citty root below;
 * everything else still falls through to legacy `parseCliArgs` + the
 * executor switch in `main()`. Each batch will move ~5-10 more commands from
 * the legacy switch into `cittyRoot.subCommands` until the legacy parser is
 * empty.
 *
 * Subcommand `run` handlers preserve the dynamic-import pattern
 * (`await import('./src/cli/X.ts')`) so cold-start cost stays the same.
 */
const statusListRun = async (cmd: 'status' | 'list'): Promise<void> => {
  const { runStatus } = await import('./src/cli/cli-status.ts')
  await runStatus(cmd)
}

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show daemon status + accounts' },
  async run() { await statusListRun('status') },
})

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List bound accounts' },
  async run() { await statusListRun('list') },
})

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Deprecated since v1.0 — use `wechat-cc service install`',
  },
  args: {
    user: { type: 'boolean', description: 'legacy --user scope (ignored)' },
  },
  run() {
    // `wechat-cc install [--user]` was the v0.x entrypoint that wrote a
    // wechat MCP server entry into ~/.claude.json so Claude Code would
    // spawn the channel as a child MCP. v1.0+ flipped the model: the
    // daemon now drives Claude via the Agent SDK directly, so an MCP
    // entry serves no purpose. Tell the user the new path instead of
    // silently writing a broken entry.
    console.error('wechat-cc install is deprecated since v1.0.')
    console.error('Use `wechat-cc service install` to register the daemon (macOS launchd / Linux systemd / Windows ScheduledTask),')
    console.error('or open the desktop app and walk through the setup wizard.')
    process.exit(2)
  },
})

const doctorCmd = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose install/setup state' },
  args: {
    json: { type: 'boolean', description: 'machine-readable output' },
  },
  async run({ args }) {
    const report = analyzeDoctor(defaultDoctorDeps())
    if (args.json) console.log(JSON.stringify(DoctorOutput.parse(report), null, 2))
    else {
      printDoctor(report)
      const warn = await probeOutboundWarning(report.checks.daemon)
      if (warn) console.log(warn)
      const fsWarn = await probeFsAccessWarning(report.checks.daemon)
      if (fsWarn) console.log(fsWarn)
    }
  },
})

const setupStatusCmd = defineCommand({
  meta: { name: 'setup-status', description: 'Machine-readable setup status for desktop UI' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (vs single-line text)' },
  },
  run({ args }) {
    const deps = defaultDoctorDeps()
    const status = setupStatus(deps)
    if (args.json) console.log(JSON.stringify(SetupStatusOutput.parse(status), null, 2))
    else console.log(status.bound ? 'wechat: bound' : 'wechat: not bound')
  },
})

// ── PR4 batch 2 — read-only inspection commands ─────────────────────
//
// Same defineCommand pattern as batch 1 (status / list / etc.) but with
// nested subCommands for namespaces that have multiple verbs
// (`events list`, `observations list|archive`, etc.). Citty's `--help`
// auto-generates per-level usage so users get correct help on either
// `wechat-cc events --help` or `wechat-cc events list --help`.
//
// Each leaf does the same work the legacy switch did — preserved
// verbatim so behavior diff is zero. Only argv parsing moves.

const eventsListCmd = defineCommand({
  meta: { name: 'list', description: 'Tail Companion decisions log (push/skip/observation/milestone)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    limit: { type: 'string', description: 'Max events to return (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 50
    const limit = Number.isFinite(limitNum) ? limitNum : 50
    const { makeEventsStore } = await import('./src/daemon/events/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeEventsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'events.jsonl'),
    })
    const list = await store.list({ limit })
    console.log(args.json ? JSON.stringify(EventsListOutput.parse({ ok: true, events: list }), null, 2) : list.map(e => `${e.ts} ${e.kind} ${e.trigger}`).join('\n'))
  },
})

const eventsCmd = defineCommand({
  meta: { name: 'events', description: 'Companion decisions log' },
  subCommands: { list: eventsListCmd },
})

const observationsListCmd = defineCommand({
  meta: { name: 'list', description: 'List observations (active by default; --include-archived for the archive)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    'include-archived': { type: 'boolean', description: 'Show archived items instead of active' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const includeArchived = Boolean(args['include-archived'])
    const { makeObservationsStore } = await import('./src/daemon/observations/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeObservationsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'observations.jsonl'),
    })
    const list = includeArchived ? await store.listArchived() : await store.listActive()
    console.log(args.json ? JSON.stringify(ObservationsListOutput.parse({ ok: true, observations: list }), null, 2) : list.map(o => `${o.ts} ${o.body}`).join('\n'))
  },
})

const observationsArchiveCmd = defineCommand({
  meta: { name: 'archive', description: 'Mark an observation archived (user "ignore")' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    obsId: { type: 'positional', required: true, description: 'Observation id (obs_…)', valueHint: 'obs-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeObservationsStore } = await import('./src/daemon/observations/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeObservationsStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'observations.jsonl'),
    })
    await store.archive(args.obsId)
    console.log(args.json ? JSON.stringify(ObservationsArchiveOutput.parse({ ok: true, archived: args.obsId }), null, 2) : `archived ${args.obsId}`)
  },
})

const observationsCmd = defineCommand({
  meta: { name: 'observations', description: 'Companion observations (per chat)' },
  subCommands: {
    list: observationsListCmd,
    archive: observationsArchiveCmd,
  },
})

const milestonesListCmd = defineCommand({
  meta: { name: 'list', description: 'Per-chat milestones (id-deduped)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { makeMilestonesStore } = await import('./src/daemon/milestones/store')
    const { openWechatDb } = await import('./src/lib/db')
    const memoryRoot = join(STATE_DIR, 'memory')
    const db = openWechatDb(STATE_DIR)
    const store = makeMilestonesStore(db, args.chatId, {
      migrateFromFile: join(memoryRoot, args.chatId, 'milestones.jsonl'),
    })
    const list = await store.list()
    console.log(args.json ? JSON.stringify(MilestonesListOutput.parse({ ok: true, milestones: list }), null, 2) : list.map(m => `${m.ts} ${m.body}`).join('\n'))
  },
})

const milestonesCmd = defineCommand({
  meta: { name: 'milestones', description: 'Per-chat milestone fires' },
  subCommands: { list: milestonesListCmd },
})

const conversationsListCmd = defineCommand({
  meta: { name: 'list', description: 'Read-only snapshot of conversations + identities' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Read-only snapshot of conversations. Used by the desktop dashboard
    // (P5.2) to display per-chat mode badges. PR5 Task 22: identity now
    // sources from conversationStore.getIdentity (user_names.json was
    // deprecated in Task 21); envelope grows user_id/account_id alongside
    // user_name so the dashboard table can render account/user columns.
    const { makeConversationStore } = await import('./src/core/conversation-store')
    const { openWechatDb } = await import('./src/lib/db')
    const db = openWechatDb(STATE_DIR)
    const store = makeConversationStore(db, { migrateFromFile: join(STATE_DIR, 'conversations.json') })
    const conversations = Object.entries(store.all()).map(([chat_id, rec]) => {
      const id = store.getIdentity(chat_id)
      return {
        chat_id,
        user_id: id?.user_id ?? null,
        account_id: id?.account_id ?? null,
        user_name: id?.last_user_name ?? null,
        mode: rec.mode,
      }
    })
    if (args.json) console.log(JSON.stringify(ConversationsListOutput.parse({ ok: true, conversations }), null, 2))
    else console.log(conversations.map(c => `${c.chat_id} ${c.user_name ?? ''} ${c.mode.kind}`).join('\n'))
  },
})

const conversationsCmd = defineCommand({
  meta: { name: 'conversations', description: 'Per-chat conversation modes (RFC 03)' },
  subCommands: { list: conversationsListCmd },
})

const logsCmd = defineCommand({
  meta: { name: 'logs', description: "Tail the daemon's channel.log (default --tail 50)" },
  args: {
    tail: { type: 'string', description: 'Number of trailing entries (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope (parsed entries)' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe buffer truncation in compiled binaries)' },
  },
  async run({ args }) {
    const tailNum = args.tail ? Number.parseInt(args.tail, 10) : 50
    const tail = Number.isFinite(tailNum) ? tailNum : 50
    const outFile = args['out-file']
    const { tailLog, formatLogsForCli } = await import('./src/cli/logs.ts')
    const { LogsOutput } = await import('./src/cli/schema.ts')
    const result = tailLog(STATE_DIR, tail)
    // JSON success path routes through emitJson so --out-file is honoured —
    // bun --compile pipes drop bytes on MB-sized payloads (sessions hit the
    // same wall and use this pattern; see lib.rs:22-26 for the rationale).
    if (args.json && result.ok) {
      emitJson(LogsOutput.parse(result), outFile)
      return
    }
    const out = formatLogsForCli(result, Boolean(args.json))
    if (out.stdout) console.log(out.stdout)
    if (out.stderr) console.error(out.stderr)
    if (out.exitCode !== 0) process.exit(out.exitCode)
  },
})

// ── wechat-cc log <tag> <msg> [--fields <json>] [--json] ─────────────────────
// Fire-and-forget log writer for external callers (e.g. the desktop frontend).
// Used by RECONNECT_DIAGNOSE telemetry (Step 4).
const logCmd = defineCommand({
  meta: { name: 'log', description: 'Write a structured log line to channel.log (for frontend telemetry)' },
  args: {
    tag: { type: 'positional', required: true, description: 'Log tag (e.g. RECONNECT_DIAGNOSE)', valueHint: 'tag' },
    msg: { type: 'positional', required: true, description: 'Human-readable log message', valueHint: 'msg' },
    fields: { type: 'string', description: 'Structured fields as a JSON object string (e.g. \'{"code":1}\')' },
    json: { type: 'boolean', description: 'Emit { ok: true } JSON envelope on stdout' },
  },
  async run({ args }) {
    const { runLogCommand } = await import('./src/cli/log.ts')
    let result: { ok: true }
    try {
      result = runLogCommand({ tag: args.tag, msg: args.msg, fieldsJson: args.fields })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`log: ${msg}`)
      process.exit(2)
    }
    if (args.json) console.log(JSON.stringify(LogOutput.parse(result)))
  },
})


const avatarInfoCmd = defineCommand({
  meta: { name: 'info', description: "Show stored avatar metadata for a key (chat / bot / user)" },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { avatarInfo } = await import('./src/core/avatar/store')
    const info = avatarInfo(STATE_DIR, args.key)
    if (args.json) console.log(JSON.stringify(AvatarInfoOutput.parse({ ok: true, ...info })))
    else console.log(`${args.key}: ${info.exists ? info.path : '(no avatar)'}`)
  },
})

const avatarSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set avatar from base64 (PNG/JPG)' },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    base64: { type: 'string', required: true, description: 'Base64-encoded image bytes' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { setAvatar } = await import('./src/core/avatar/store')
    try {
      const result = setAvatar(STATE_DIR, args.key, args.base64)
      if (args.json) console.log(JSON.stringify(AvatarSetOutput.parse(result)))
      else console.log(`set ${args.key} → ${result.path}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify(AvatarSetOutput.parse({ ok: false, error: msg })))
      else console.error(`avatar set failed: ${msg}`)
      process.exit(1)
    }
  },
})

const avatarRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Remove stored avatar for a key' },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAvatar } = await import('./src/core/avatar/store')
    const result = removeAvatar(STATE_DIR, args.key)
    if (args.json) console.log(JSON.stringify(AvatarRemoveOutput.parse(result)))
    else console.log(`removed ${args.key}`)
  },
})

const avatarCmd = defineCommand({
  meta: { name: 'avatar', description: 'Avatar metadata + binary set/remove (per chat / bot / user key)' },
  subCommands: {
    info: avatarInfoCmd,
    set: avatarSetCmd,
    remove: avatarRemoveCmd,
  },
})

const guardStatusCmd = defineCommand({
  meta: { name: 'status', description: "Live one-shot probe — current external IP + reachability" },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Live one-shot probe (independent of any running daemon's
    // scheduler). Useful for both the dashboard status row and
    // operator debugging — `wechat-cc guard status --json` from
    // any terminal returns the current external IP + reachability.
    const { loadGuardConfig } = await import('./src/daemon/guard/store')
    const { fetchPublicIp, probeReachable } = await import('./src/daemon/guard/probe')
    const cfg = loadGuardConfig(STATE_DIR)
    const ipRes = await fetchPublicIp({ url: cfg.ipify_url })
    const probeRes = await probeReachable(cfg.probe_url)
    const out = {
      enabled: cfg.enabled,
      ip: ipRes.ip,
      reachable: probeRes.reachable,
      probe_url: cfg.probe_url,
      ip_error: ipRes.error ?? null,
      probe_error: probeRes.error ?? null,
      probe_ms: probeRes.ms,
    }
    if (args.json) console.log(JSON.stringify(GuardStatusOutput.parse(out), null, 2))
    else {
      console.log(`enabled: ${out.enabled}`)
      console.log(`ip:      ${out.ip ?? '?'}${out.ip_error ? ` (${out.ip_error})` : ''}`)
      console.log(`probe:   ${out.reachable ? 'reachable' : 'UNREACHABLE'} (${cfg.probe_url})${out.probe_error ? ` — ${out.probe_error}` : ''}`)
    }
  },
})

async function setGuardEnabled(enabled: boolean, json: boolean): Promise<void> {
  const { loadGuardConfig, saveGuardConfig } = await import('./src/daemon/guard/store')
  const cfg = loadGuardConfig(STATE_DIR)
  cfg.enabled = enabled
  saveGuardConfig(STATE_DIR, cfg)
  if (json) console.log(JSON.stringify((enabled ? GuardEnableOutput : GuardDisableOutput).parse({ ok: true, enabled: cfg.enabled })))
  else console.log(`guard: ${cfg.enabled ? 'enabled' : 'disabled'}`)
}

const guardEnableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable network-guard scheduler (next daemon start)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) { await setGuardEnabled(true, Boolean(args.json)) },
})

const guardDisableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable network-guard scheduler' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) { await setGuardEnabled(false, Boolean(args.json)) },
})

const guardCmd = defineCommand({
  meta: { name: 'guard', description: 'Network-guard config + live probe' },
  subCommands: {
    status: guardStatusCmd,
    enable: guardEnableCmd,
    disable: guardDisableCmd,
  },
})

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

const providerCmd = defineCommand({
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


const accountRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Decommission a bound bot — wipes account dir + related state. Restart daemon afterwards.' },
  args: {
    botId: { type: 'positional', required: true, description: 'Bot id', valueHint: 'bot-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAccount } = await import('./src/cli/account-remove.ts')
    // Best-effort SQLite session_state cleanup. The legacy file path is
    // dead post-PR7 migration; without this hook every `account remove`
    // on a previously-expired bot leaves an orphan SQLite row forever.
    let clearSessionStateBot: ((botId: string) => boolean) | undefined
    try {
      const { openWechatDb } = await import('./src/lib/db')
      const { makeSessionStateStore } = await import('./src/core/session-state')
      const db = openWechatDb(STATE_DIR)
      const store = makeSessionStateStore(db)
      clearSessionStateBot = (botId: string) => {
        if (!store.isExpired(botId)) return false
        store.clear(botId)
        return true
      }
    } catch { /* db absent / migration not run yet — fall through to legacy-file-only cleanup */ }
    try {
      const result = removeAccount({
        stateDir: STATE_DIR,
        ...(clearSessionStateBot ? { clearSessionStateBot } : {}),
      }, args.botId)
      if (args.json) {
        console.log(JSON.stringify(AccountRemoveOutput.parse({ ok: true, ...result, restartRequired: true }), null, 2))
      } else {
        console.log(`removed: ${result.botId}`)
        for (const r of result.removed) console.log(`  - ${r}`)
        for (const w of result.warnings) console.log(`  ! ${w}`)
        console.log('\nrestart daemon for the change to take effect.')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify(AccountRemoveOutput.parse({ ok: false, error: msg })))
      else console.error(`account remove failed: ${msg}`)
      process.exit(1)
    }
  },
})

const accountExportCmd = defineCommand({
  meta: { name: 'export', description: 'Export a bound bot (encrypted) so another machine can drive it — no re-scan' },
  args: {
    'bot-id': { type: 'string', description: 'Which account (default: the sole bound one)' },
    passphrase: { type: 'string', required: true, description: 'Encrypts the bundle (you type the same on import)' },
    out: { type: 'string', description: 'Output file (default: <botId>.wccaccount)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { resolveAccountId, exportAccount, markMultiDevice } = await import('./src/cli/account-transfer.ts')
    try {
      const id = resolveAccountId(STATE_DIR, args['bot-id'])
      const blob = exportAccount(STATE_DIR, id, args.passphrase)
      // Exporting = this bot is now shared → mark the source too, so when the
      // other device takes over, THIS machine also stands by gracefully.
      markMultiDevice(STATE_DIR, id)
      const outPath = args.out ?? join(process.cwd(), `${id}.wccaccount`)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(outPath, blob, { mode: 0o600 })
      if (args.json) { console.log(JSON.stringify({ ok: true, botId: id, out: outPath, bytes: blob.length })); return }
      console.log(`exported ${id} → ${outPath} (${blob.length}B, encrypted)`)
      console.log('⚠ 这个文件含你 bot 的完整凭证 — 安全传到另一台机器,用同一口令 `account import` 导入。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`account export failed: ${msg}`); process.exit(1)
    }
  },
})

const accountImportCmd = defineCommand({
  meta: { name: 'import', description: 'Import an account bundle from another machine — drive the same bot without re-scanning' },
  args: {
    file: { type: 'positional', required: true, description: 'The .wccaccount bundle', valueHint: 'file' },
    passphrase: { type: 'string', required: true, description: 'The passphrase used on export' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { importAccount } = await import('./src/cli/account-transfer.ts')
    try {
      const { readFileSync } = await import('node:fs')
      const blob = readFileSync(args.file)
      const res = importAccount(STATE_DIR, blob, args.passphrase)
      if (args.json) { console.log(JSON.stringify({ ok: true, ...res })); return }
      console.log(`imported ${res.botId}${res.overwritten ? ' (overwrote existing)' : ''}`)
      console.log('\n重启 daemon 即接管该 bot(会从另一台手里接管会话,对方退到后台)。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`account import failed: ${msg}`); process.exit(1)
    }
  },
})

const accountTakeoverCmd = defineCommand({
  meta: { name: 'takeover', description: 'Take over the bot session on THIS machine (re-poll a stood-by account) — no daemon restart' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { requestTakeover } = await import('./src/cli/account-transfer.ts')
    const { existsSync, readFileSync } = await import('node:fs')
    try {
      const { pid } = requestTakeover({
        readPid: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
        kill: (pidNum, sig) => process.kill(pidNum, sig),
      }, STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, pid })); return }
      console.log(`已通知本机 daemon (pid ${pid}) 接管 —— 重读账号、重启待命的轮询。`)
      console.log('几秒后这台成为活跃端,另一台会优雅待命。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`account takeover failed: ${msg}`); process.exit(1)
    }
  },
})

// 外部集成反馈 #5 (2026-08-26):allowlist 此前只有"加人"路径(管理员聊天流程),
// 移除要手编 access.json。list/remove 补齐;daemon 的 5s TTL 缓存意味着改动
// 数秒内生效,无需重启。
const accessListCmd = defineCommand({
  meta: { name: 'list', description: 'Show access.json: admins / trusted / allowFrom' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { loadAccess } = await import('./src/lib/access.ts')
    const a = loadAccess()
    if (args.json) { console.log(JSON.stringify({ ok: true, dmPolicy: a.dmPolicy, admins: a.admins ?? [], trusted: a.trusted ?? [], allowFrom: a.allowFrom })); return }
    console.log(`dmPolicy: ${a.dmPolicy}`)
    console.log(`admins (${(a.admins ?? []).length}):`); for (const u of a.admins ?? []) console.log(`  ${u}`)
    console.log(`trusted (${(a.trusted ?? []).length}):`); for (const u of a.trusted ?? []) console.log(`  ${u}`)
    console.log(`allowFrom (${a.allowFrom.length}):`); for (const u of a.allowFrom) console.log(`  ${u}`)
  },
})

const accessRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Remove a userId from allowFrom (admins refuse — self-lockout guard). Takes effect within ~5s, no restart.' },
  args: {
    userId: { type: 'positional', required: true, description: 'The chat/user id to remove', valueHint: 'xxx@im.wechat' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAllowFrom } = await import('./src/lib/access.ts')
    const r = removeAllowFrom(args.userId)
    if (args.json) { console.log(JSON.stringify({ ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) })); if (!r.ok) process.exitCode = 1; return }
    if (r.ok) console.log(`✅ 已移除 ${args.userId}(daemon 数秒内生效)`)
    else { console.log(r.reason === 'is_admin' ? `❌ ${args.userId} 是管理员,拒绝移除(防自锁)。` : `❌ ${args.userId} 不在 allowFrom 里。`); process.exitCode = 1 }
  },
})

const accessCmd = defineCommand({
  meta: { name: 'access', description: 'Allowlist management (list / remove) — the add path stays in the admin chat flow' },
  subCommands: { list: accessListCmd, remove: accessRemoveCmd },
})

const accountCmd = defineCommand({
  meta: { name: 'account', description: 'Account management (export/import + takeover for multi-device, decommission a bound bot)' },
  subCommands: { remove: accountRemoveCmd, export: accountExportCmd, import: accountImportCmd, takeover: accountTakeoverCmd },
})

const companionPushCmd = defineCommand({
  meta: { name: 'push', description: 'Fire a companion push tick NOW (instead of waiting for the ~20min scheduler) — nudges any due agenda follow-up' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { requestPushTick } = await import('./src/cli/companion-push.ts')
    const { existsSync, readFileSync } = await import('node:fs')
    try {
      const { pid } = requestPushTick({
        readPid: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
        kill: (pidNum, sig) => process.kill(pidNum, sig),
      }, STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, pid })); return }
      console.log(`已通知本机 daemon (pid ${pid}) 立刻跑一次 push tick —— 若有到点的 agenda 跟进会主动发。`)
      console.log('查看结果：wechat-cc logs（或 tail channel.log 看 SCHED / COMPANION）。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`companion push failed: ${msg}`); process.exit(1)
    }
  },
})

// ── hook — 终端 claude / codex 会话的事件推到微信(spec 2026-09-09-cli-hook-push)──
// 两家的 hooks 各拉起一个 `wechat-cc hook <source>` 子进程,stdin 是 hook JSON。
// 永远 exit 0、永远不阻塞 CLI:daemon 没跑 / 网络不通 / 400 一律静默
// (WECHAT_CC_HOOK_DEBUG=1 时把结果打到 stderr)。
function hookRelayCmd(source: 'claude' | 'codex') {
  return defineCommand({
    meta: { name: source, description: `${source} 的 hook 出口(stdin 收 hook JSON,转给本机 daemon)` },
    async run() {
      const { shouldSkipHook, normalizeHookPayload, postCliEvent, parsePermissionRequest, relayPermission, permissionDecisionOutput, withMachineContext } = await import('./src/cli/hook.ts')
      const debug = process.env['WECHAT_CC_HOOK_DEBUG'] === '1'
      try {
        // 回环守卫:daemon 自己拉起的 claude / codex 也会触发同一份 hooks。
        if (shouldSkipHook(process.env)) { if (debug) console.error('hook: skipped (daemon child)'); return }
        const raw = await readStdin()
        let parsed: unknown = null
        try { parsed = JSON.parse(raw) } catch { if (debug) console.error('hook: stdin is not JSON'); return }
        // PermissionRequest:去微信问主人;拿到 y/n 就往 stdout 写答复(两家同形状)。
        // 主人在场 / 没答 / daemon 没跑 → 什么都不写,终端自己弹提示;顺手按老规矩
        // 压一条「等你批准」提醒(刚发过卡片的话 daemon 那头会压掉)。
        const perm = parsePermissionRequest(source, parsed)
        if (perm) {
          const r = await relayPermission(STATE_DIR, await withMachineContext(perm))
          if (debug) console.error(`hook: permission ${JSON.stringify(r)}`)
          if (r.decision) { process.stdout.write(permissionDecisionOutput(r.decision) + '\n'); return }
          await postCliEvent(STATE_DIR, await withMachineContext({ source, kind: 'permission' as const, session_id: perm.session_id, cwd: perm.cwd, text: perm.summary ? `${perm.tool_name}: ${perm.summary}` : perm.tool_name }))
          return
        }
        const ev = normalizeHookPayload(source, parsed)
        if (!ev) { if (debug) console.error('hook: event ignored'); return }
        // prompt / session_end 不用探空闲(它们本身就说明有人在);stop / permission 要。
        const r = await postCliEvent(STATE_DIR, ev.kind === 'stop' || ev.kind === 'permission' ? await withMachineContext(ev) : ev)
        if (debug) console.error(`hook: ${JSON.stringify(r)}`)
      } catch (err) {
        if (debug) console.error(`hook: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
}

function hookTargets(args: { claude?: boolean; codex?: boolean }): ('claude' | 'codex')[] {
  const both = !args.claude && !args.codex
  return [...(both || args.claude ? ['claude' as const] : []), ...(both || args.codex ? ['codex' as const] : [])]
}

async function hookFileFor(source: 'claude' | 'codex'): Promise<string> {
  const { claudeSettingsPath, codexHooksPath } = await import('./src/cli/hook.ts')
  const { homedir } = await import('node:os')
  return source === 'claude' ? claudeSettingsPath(homedir()) : codexHooksPath(homedir(), process.env)
}

const hookInstallCmd = defineCommand({
  meta: { name: 'install', description: '把 wechat-cc 的 hooks 写进 ~/.claude/settings.json 与 $CODEX_HOME/hooks.json(幂等;缺省两家都装)' },
  args: {
    claude: { type: 'boolean', description: '只装 Claude Code' },
    codex: { type: 'boolean', description: '只装 Codex CLI' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { installHooks, hookCommandLine } = await import('./src/cli/hook.ts')
    const cliEntry = fileURLToPath(import.meta.url)
    const out: Record<string, unknown> = {}
    for (const source of hookTargets(args)) {
      const file = await hookFileFor(source)
      const command = hookCommandLine({ execPath: process.execPath, compiled: isCompiledBundle(), cliEntry, source })
      try {
        const { changed } = installHooks(file, source, command)
        out[source] = { ok: true, file, changed, command }
        if (!args.json) console.log(`${changed ? '✅' : '✔'} ${source}: ${changed ? '已写入' : '已是最新'} ${file}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        out[source] = { ok: false, file, error: msg }
        if (!args.json) console.error(`❌ ${source}: ${msg}`)
      }
    }
    if (args.json) { console.log(JSON.stringify(out)); return }
    console.log('之后终端里的 claude / codex 跑完一个长回合,主人微信会收到一条(压 45s;期间你再敲一句就不发;一次提问最多推一条)。')
    console.log('停下来等批准时:你最近 3 分钟没在终端敲过字 ⇒ 微信里收到卡片,回「y 码」/「n 码」就替终端拍板(120s 内);否则终端自己问。')
    console.log('daemon 自己拉起的会话不会推(回环守卫)。查看:wechat-cc hook status;撤掉:wechat-cc hook uninstall。')
  },
})

const hookUninstallCmd = defineCommand({
  meta: { name: 'uninstall', description: '只删 wechat-cc 自己的 hook 条目,别人的原样保留' },
  args: {
    claude: { type: 'boolean', description: '只删 Claude Code 的' },
    codex: { type: 'boolean', description: '只删 Codex CLI 的' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { uninstallHooks } = await import('./src/cli/hook.ts')
    const out: Record<string, unknown> = {}
    for (const source of hookTargets(args)) {
      const file = await hookFileFor(source)
      try {
        const r = uninstallHooks(file, source)
        out[source] = { ok: true, file, ...r }
        if (!args.json) console.log(`${r.changed ? '✅' : '✔'} ${source}: ${r.changed ? `删了 ${r.removed} 条` : '本来就没装'}(${file})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        out[source] = { ok: false, file, error: msg }
        if (!args.json) console.error(`❌ ${source}: ${msg}`)
      }
    }
    if (args.json) console.log(JSON.stringify(out))
  },
})

const hookStatusCmd = defineCommand({
  meta: { name: 'status', description: '两家的 hook 装没装、命令行是什么' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { hookStatus } = await import('./src/cli/hook.ts')
    const out: Record<string, unknown> = {}
    for (const source of ['claude', 'codex'] as const) {
      const file = await hookFileFor(source)
      const st = hookStatus(file, source)
      out[source] = { file, ...st }
      if (!args.json) console.log(`${st.installed ? '✅' : '—'} ${source}: ${st.installed ? st.command : '未安装'}(${file})`)
    }
    if (args.json) console.log(JSON.stringify(out))
  },
})

const hookCmd = defineCommand({
  meta: { name: 'hook', description: '终端 claude / codex 会话的事件推到微信(hooks 出口):install / uninstall / status;claude / codex 由 hooks 自己调' },
  subCommands: { claude: hookRelayCmd('claude'), codex: hookRelayCmd('codex'), install: hookInstallCmd, uninstall: hookUninstallCmd, status: hookStatusCmd },
})

const companionIntrospectCmd = defineCommand({
  meta: { name: 'introspect', description: 'Fire introspection + CC Atelier tick NOW (instead of waiting for the daily schedule)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { requestIntrospectTick } = await import('./src/cli/companion-introspect.ts')
    const { existsSync, readFileSync } = await import('node:fs')
    try {
      const { pid } = requestIntrospectTick({
        readPid: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
        kill: (pidNum, sig) => process.kill(pidNum, sig),
      }, STATE_DIR)
      if (args.json) { console.log(JSON.stringify({ ok: true, pid })); return }
      console.log(`已通知本机 daemon (pid ${pid}) 立刻跑一次 introspect + Atelier tick。`)
      console.log('查看结果：wechat-cc logs（或 tail channel.log 看 INTROSPECT / ATELIER）。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
      console.error(`companion introspect failed: ${msg}`); process.exit(1)
    }
  },
})

const companionCmd = defineCommand({
  meta: { name: 'companion', description: 'Companion (proactive contact) controls' },
  subCommands: { push: companionPushCmd, introspect: companionIntrospectCmd },
})

// ── connection probe — wechat-cc connection probe [--json] ─────────────────
//
// Walks STATE_DIR/accounts/<id>/{account.json,token}, calls probeConnection
// for each bound account, and emits { accounts: ProbeResult[] }.
// On taken_over the daemon's SQLite session_state row is written so the
// dashboard's expiredBots list reflects it on next doctor poll.

const connectionProbeCmd = defineCommand({
  meta: { name: 'probe', description: 'Test whether THIS machine holds the live WeChat connection' },
  args: { json: { type: 'boolean', description: 'machine-readable output' } },
  async run({ args }) {
    const { ilinkGetUpdates } = await import('./src/lib/ilink')
    const { probeConnection } = await import('./src/daemon/connection-probe')
    const { openWechatDb } = await import('./src/lib/db')
    const { makeSessionStateStore } = await import('./src/core/session-state')
    const { readFileSync, existsSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')

    const PROBE_TIMEOUT_MS = 5000
    const dir = join(STATE_DIR, 'accounts')
    const ids = existsSync(dir) ? readdirSync(dir).filter(n => !n.includes('.superseded.')) : []

    // Open db only when accounts exist to avoid creating an empty db in a
    // non-existent STATE_DIR (the db file lives inside STATE_DIR).
    let db: import('./src/lib/db').Db | null = null
    const accounts: import('./src/daemon/connection-probe').ProbeResult[] = []
    try {
      if (ids.length > 0) db = openWechatDb(STATE_DIR)
      const store = db ? makeSessionStateStore(db) : null
      for (const id of ids) {
        const acctDir = join(dir, id)
        const metaPath = join(acctDir, 'account.json')
        const tokenPath = join(acctDir, 'token')
        if (!existsSync(metaPath) || !existsSync(tokenPath)) continue
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        const token = readFileSync(tokenPath, 'utf8').trim()
        const result = await probeConnection({
          account: { id, botId: meta.botId, baseUrl: meta.baseUrl, token },
          getUpdates: (baseUrl, tok, timeoutMs) => ilinkGetUpdates(baseUrl, tok, '', timeoutMs),
          markExpired: (accountId, reason) => store ? store.markExpired(accountId, reason) : false,
          clearExpired: (accountId) => store?.clear(accountId),
          probeTimeoutMs: PROBE_TIMEOUT_MS,
        })
        accounts.push(result)
      }
    } finally {
      db?.close()
    }

    const out = { accounts }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else if (accounts.length === 0) console.log('no bound accounts found')
    else for (const a of accounts) console.log(`${a.id}: ${a.state}${a.detail ? ` (${a.detail})` : ''}`)
  },
})

const connectionCmd = defineCommand({
  meta: { name: 'connection', description: "Inspect this machine's WeChat connection" },
  subCommands: { probe: connectionProbeCmd },
})

const daemonKillCmd = defineCommand({
  meta: { name: 'kill', description: 'Force-kill a daemon process by pid (verifies cmdline; SIGTERM 1.5s grace then SIGKILL)' },
  args: {
    pid: { type: 'positional', required: true, description: 'Process id (positive integer)', valueHint: 'pid' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const pid = Number.parseInt(args.pid, 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      console.error(`pid must be a positive integer (got: ${args.pid})`)
      process.exit(2)
    }
    const { killDaemonByPid, defaultKillDeps } = await import('./src/cli/daemon-kill.ts')
    const result = await killDaemonByPid(defaultKillDeps(), pid)
    if (args.json) console.log(JSON.stringify(DaemonKillOutput.parse(result), null, 2))
    else console.log(result.killed ? `killed pid ${result.pid}` : `failed: ${result.message}`)
    if (!result.killed) process.exit(1)
  },
})

const daemonKillResidualCmd = defineCommand({
  meta: {
    name: 'kill-residual',
    description: 'Read server.pid and kill the daemon if alive (covers manual `wechat-cc run` instances launchctl/systemd cannot reach)',
  },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { killResidualDaemon, defaultResidualKillDeps } = await import('./src/cli/daemon-kill.ts')
    const result = await killResidualDaemon(defaultResidualKillDeps(), join(STATE_DIR, 'server.pid'))
    if (args.json) console.log(JSON.stringify(DaemonKillOutput.parse(result), null, 2))
    else console.log(result.killed ? `killed pid ${result.pid}` : result.message)
    // Exit 0 for "nothing to kill" or successful kill — the desktop's restart
    // step treats those identically (lock is free, proceed to start). Only
    // exit 1 if we found a live daemon we couldn't kill (operator must
    // intervene before the next start succeeds).
    if (!result.killed && /still alive/.test(result.message)) process.exit(1)
  },
})

const daemonApiInfoCmd = defineCommand({
  meta: { name: 'api-info', description: 'Read internal-api-info.json (base URL + token) — used by the desktop GUI to call /v1/* endpoints' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (always emits JSON; flag is for CLI consistency)' },
    // NO --operator FLAG, deliberately. The admin operator credential is read
    // only by processes that hold it natively — the Tauri host (lib.rs:
    // agent_converse / agent_speak / agent_transcribe / customer_review_api)
    // and the dev server. Exposing it through the CLI would mean anything able
    // to run `wechat-cc` — including the webview, since the production
    // `wechat_cli_json` command applies no argument filtering — could obtain
    // admin authority and reach POST /v1/companion/converse, i.e. speak to
    // WeChat as the owner. A --operator flag existed briefly in 45a5211 and
    // was removed in the 2026-07-28 review.
  },
  async run({ args }) {
    const { existsSync, readFileSync } = await import('node:fs')
    const infoPath = join(STATE_DIR, 'internal-api-info.json')
    if (!existsSync(infoPath)) {
      console.log(JSON.stringify({ ok: false, error: 'daemon not running (internal-api-info.json not found)' }))
      process.exit(1)
    }
    let info: { baseUrl?: string; tokenFilePath?: string; operatorTokenFilePath?: string }
    try {
      info = JSON.parse(readFileSync(infoPath, 'utf8'))
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: `could not read internal-api-info.json: ${err instanceof Error ? err.message : String(err)}` }))
      process.exit(1)
    }
    if (!info.baseUrl || !info.tokenFilePath) {
      console.log(JSON.stringify({ ok: false, error: 'internal-api-info.json is malformed (missing baseUrl or tokenFilePath)' }))
      process.exit(1)
    }
    // Always the trusted token — see the note on the missing --operator flag.
    const credentialPath = info.tokenFilePath
    let token: string
    try {
      token = readFileSync(credentialPath, 'utf8').trim()
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: `could not read token file: ${err instanceof Error ? err.message : String(err)}` }))
      process.exit(1)
    }
    console.log(JSON.stringify({ ok: true, baseUrl: info.baseUrl, token }))
  },
})

const daemonA2AEnableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable the A2A inbound server (writes agent-config.json; restart needed)' },
  args: {
    host: { type: 'string', description: 'Bind host (default: 127.0.0.1)' },
    port: { type: 'string', description: 'Bind port (default: 8717)' },
  },
  async run({ args }) {
    const port = args.port ? Number.parseInt(args.port, 10) : 8717
    if (!Number.isFinite(port)) {
      console.error(`port must be a number; got ${JSON.stringify(args.port)}`)
      process.exit(1)
    }
    const { cmdDaemonA2AEnable } = await import('./src/cli/agent.ts')
    cmdDaemonA2AEnable(STATE_DIR, { host: args.host, port })
  },
})

const daemonA2ADisableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable the A2A inbound server (removes a2a_listen from agent-config.json; restart needed)' },
  async run() {
    const { cmdDaemonA2ADisable } = await import('./src/cli/agent.ts')
    cmdDaemonA2ADisable(STATE_DIR)
  },
})

const daemonA2AStatusCmd = defineCommand({
  meta: { name: 'status', description: 'Show A2A server config (on-disk) vs runtime (currently bound); flags drift' },
  async run() {
    const { cmdDaemonA2AStatus } = await import('./src/cli/agent.ts')
    cmdDaemonA2AStatus(STATE_DIR)
  },
})

const daemonA2ACmd = defineCommand({
  meta: { name: 'a2a', description: 'A2A inbound server config — enable, disable, status' },
  subCommands: {
    enable: daemonA2AEnableCmd,
    disable: daemonA2ADisableCmd,
    status: daemonA2AStatusCmd,
  },
})

const daemonCmd = defineCommand({
  meta: { name: 'daemon', description: 'Daemon process control' },
  subCommands: { kill: daemonKillCmd, 'kill-residual': daemonKillResidualCmd, 'api-info': daemonApiInfoCmd, a2a: daemonA2ACmd },
})

async function runDemo(verb: 'seed' | 'unseed', chatIdArg: string | undefined, json: boolean): Promise<void> {
  const { loadCompanionConfig } = await import('./src/daemon/companion/config')
  const cfg = loadCompanionConfig(STATE_DIR)
  const chatId = chatIdArg ?? cfg.default_chat_id
  if (!chatId) {
    const msg = 'no default chat configured — pass --chat-id or run setup first'
    console.error(json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
    process.exit(1)
  }
  const { seedDemo, unseedDemo } = await import('./src/daemon/demo/seed')
  const { openWechatDb } = await import('./src/lib/db')
  const db = openWechatDb(STATE_DIR)
  const fn = verb === 'seed' ? seedDemo : unseedDemo
  const result = await fn({ stateDir: STATE_DIR, chatId, db })
  const demoSchema = verb === 'seed' ? DemoSeedOutput : DemoUnseedOutput
  console.log(json ? JSON.stringify(demoSchema.parse({ ok: true, ...result }), null, 2) : JSON.stringify(result))
}

const demoSeedCmd = defineCommand({
  meta: { name: 'seed', description: 'Populate sample observations + milestones + events for first-impression / screenshot use' },
  args: {
    'chat-id': { type: 'string', description: 'Target chat (defaults to companion default_chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) { await runDemo('seed', args['chat-id'], Boolean(args.json)) },
})

const demoUnseedCmd = defineCommand({
  meta: { name: 'unseed', description: 'Remove items written by `demo seed`. Idempotent.' },
  args: {
    'chat-id': { type: 'string', description: 'Target chat (defaults to companion default_chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) { await runDemo('unseed', args['chat-id'], Boolean(args.json)) },
})

const demoCmd = defineCommand({
  meta: { name: 'demo', description: 'Seed/unseed demo data for the dashboard' },
  subCommands: {
    seed: demoSeedCmd,
    unseed: demoUnseedCmd,
  },
})

// ── PR4 batch 3c — heavy entry points ────────────────────────────────
//
// 6 commands, the rest of the legacy switch. After this batch the
// parseCliArgs function + CliArgs union can be deleted entirely; only
// the help fall-through remains, and that's served by citty's
// auto-generated root help.
//
// Notable shapes:
//   - `run` mutates process.argv before main.ts import (legacy --dangerously
//     dance preserved verbatim).
//   - `setup` either drives an interactive QR scan (imports setup.ts which
//     never returns) or returns a one-shot JSON envelope under --qr-json.
//   - `setup-poll --qrcode` is required.
//   - `service` keeps a positional action (status/install/start/stop/uninstall)
//     because all five share ~95% of the same setup; nesting into 5
//     subCommands would mean shared-helper-with-5-args. Tri-state
//     --unattended / --auto-start use parseBoolValue.
//   - `reply` has multi-word positional text — citty's positionals are
//     1-slot, so we declare none and read args._ (RawArgs._ — the
//     unconsumed positionals citty hands through). Stdin path preserved.
//   - `update --check` flips between probe + apply modes; same body
//     branches as the legacy case.

const runCmd = defineCommand({
  meta: { name: 'run', description: 'Start the daemon (foreground). --dangerously skips permission prompts.' },
  args: {
    dangerously: { type: 'boolean', description: 'Skip permission prompts (matches claude --dangerously-skip-permissions)' },
    // Legacy v0.x flags. Kept declared so citty doesn't reject them; warned
    // in run() to nudge users toward the new daemon model. Without these
    // declarations, `wechat-cc run --fresh` would error on parse.
    fresh: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    continue: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    channels: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    'mcp-config': { type: 'string', description: 'Legacy v0.x flag (ignored)' },
  },
  async run({ args }) {
    if (args.fresh) console.warn(`[wechat-cc] legacy flag ignored: --fresh (v1.0+ daemon doesn't spawn claude directly)`)
    if (args.continue) console.warn(`[wechat-cc] legacy flag ignored: --continue (v1.0+ daemon doesn't spawn claude directly)`)
    if (args.channels) console.warn(`[wechat-cc] legacy flag ignored: --channels (v1.0+ daemon doesn't spawn claude directly)`)
    if (args['mcp-config']) console.warn(`[wechat-cc] legacy flag ignored: --mcp-config (v1.0+ daemon doesn't spawn claude directly)`)
    // Run the daemon in-process by calling main.ts's exported main(). Used
    // to spawn `bun src/daemon/main.ts`, but that doesn't work in
    // `bun build --compile`d binaries where the source tree isn't on disk —
    // the compiled sidecar shipped inside the desktop bundle is the single
    // source of truth for both CLI and daemon. We must call main() EXPLICITLY:
    // a bare `await import(...)` won't trigger main() because import.meta.main
    // is false for any imported module under standard ESM semantics, so the
    // import-then-block pattern silently no-ops.
    if (args.dangerously && !process.argv.includes('--dangerously')) {
      process.argv.push('--dangerously')
    }
    const { main: runDaemon } = await import('./src/daemon/main.ts')
    await runDaemon()
    // main() returns after attaching signal handlers; the daemon's lifecycle
    // (HTTP server, polling intervals) keeps the event loop alive. Block here
    // so cli.ts's caller doesn't see a premature resolve.
    await new Promise(() => {})
  },
})

const setupCmd = defineCommand({
  meta: { name: 'setup', description: 'Scan QR + bind a WeChat bot' },
  args: {
    'qr-json': { type: 'boolean', description: 'Emit JSON envelope (one-shot QR fetch) instead of starting an interactive scan' },
  },
  async run({ args }) {
    if (args['qr-json']) {
      const { requestSetupQrCode } = await import('./src/cli/setup-flow.ts')
      console.log(JSON.stringify(SetupQrJsonOutput.parse(await requestSetupQrCode()), null, 2))
      return
    }
    // Same rationale as `run`: import setup.ts directly so the compiled
    // sidecar can drive the QR flow from inside Tauri-spawned shells too.
    await import('./setup.ts')
  },
})

const setupPollCmd = defineCommand({
  meta: { name: 'setup-poll', description: 'Poll a setup-status QR code (paired with `setup --qr-json`)' },
  args: {
    qrcode: { type: 'string', required: true, description: 'QR token returned from `setup --qr-json`' },
    'base-url': { type: 'string', description: 'Override ilink base URL (defaults to setup-flow internal default)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { pollSetupQrStatus } = await import('./src/cli/setup-flow.ts')
    // Best-effort: open the daemon's SQLite read-only-style so scenario
    // detection can distinguish 'reconnect' from 'redundant'. db.ts uses
    // WAL mode + 5s busy_timeout, so concurrent access from a running
    // daemon is safe. If the db doesn't exist yet (fresh install), fall
    // through with isExpired undefined — determineScenario then collapses
    // 'reconnect' into 'redundant', which is still truthful copy.
    let isExpired: ((botDirName: string) => boolean) | undefined
    try {
      const { openWechatDb } = await import('./src/lib/db')
      const { makeSessionStateStore } = await import('./src/core/session-state')
      const db = openWechatDb(STATE_DIR)
      const store = makeSessionStateStore(db)
      isExpired = (botDirName: string) => store.isExpired(botDirName)
    } catch { /* db absent or schema older than session_state migration — leave undefined */ }
    const result = await pollSetupQrStatus({
      qrcode: args.qrcode,
      ...(args['base-url'] !== undefined ? { baseUrl: args['base-url'] } : {}),
      stateDir: STATE_DIR,
      ...(isExpired ? { isExpired } : {}),
    })
    if (args.json) console.log(JSON.stringify(SetupPollOutput.parse(result), null, 2))
    else console.log(result.status)
  },
})

const serviceCmd = defineCommand({
  meta: {
    name: 'service',
    description: 'Daemon service management — register / start / stop / uninstall a launchd / systemd / ScheduledTask entry',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description: 'status | install | start | stop | uninstall',
      valueHint: 'status|install|start|stop|uninstall',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
    // Tri-state strings (parseBoolValue inside run): true / false / undefined.
    // Citty's boolean type can't distinguish "absent" from "explicit false",
    // and service install treats omission as "leave existing config alone".
    unattended: { type: 'string', description: 'true | false | yes | no | on | off — persist into agent-config (omit to leave unchanged)' },
    'auto-start': { type: 'string', description: 'true | false | yes | no | on | off — register for boot/login auto-start' },
  },
  async run({ args }) {
    const validActions = ['status', 'install', 'start', 'stop', 'uninstall'] as const
    type ServiceAction = typeof validActions[number]
    const action = args.action as ServiceAction
    if (!validActions.includes(action)) {
      console.error(`service action must be one of ${validActions.join(' | ')} (got: ${args.action})`)
      process.exit(2)
    }
    const unattended = parseBoolValue(args.unattended)
    const autoStart = parseBoolValue(args['auto-start'])
    // If the caller passed --unattended or --auto-start, persist them into
    // agent-config first so it's the source of truth (re-installs from the
    // GUI re-pick the same values).
    if (unattended !== undefined || autoStart !== undefined) {
      const existing = loadAgentConfig(STATE_DIR)
      saveAgentConfig(STATE_DIR, {
        ...existing,
        ...(unattended !== undefined ? { dangerouslySkipPermissions: unattended } : {}),
        ...(autoStart !== undefined ? { autoStart } : {}),
      })
    }
    const config = loadAgentConfig(STATE_DIR)
    // Compiled-bundle mode: launch the daemon via the same self-contained
    // binary (no external bun + cli.ts source). Source mode: legacy
    // `bunPath cli.ts run` ExecStart. compiledBinaryPath/compiledRepoRoot
    // both return non-null only in compiled mode — see runtime-info.ts.
    const binaryPath = compiledBinaryPath() ?? undefined
    const appBinaryPath = appMainBinaryPath() ?? undefined
    const planCwd = compiledRepoRoot() ?? dirname(fileURLToPath(import.meta.url))
    const plan = buildServicePlan({
      cwd: planCwd,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      autoStart: config.autoStart,
      ...(binaryPath ? { binaryPath } : {}),
      ...(appBinaryPath ? { appBinaryPath } : {}),
    })
    const json = Boolean(args.json)
    if (action === 'status') {
      const status = serviceStatus(defaultDoctorDeps())
      if (json) console.log(JSON.stringify(ServiceStatusOutput.parse({ ...status, plan, agentConfig: config }), null, 2))
      else console.log(`service: ${status.state}${status.installed ? ' [installed]' : ''}${status.pid ? ` pid=${status.pid}` : ''}`)
      return
    }
    // WECHAT_CC_DRY_RUN=1 makes install/uninstall/start/stop a no-op (still
    // returns the plan in JSON). Used by the apps/desktop e2e shim so tests
    // exercise real cli.ts without touching ~/Library/LaunchAgents/launchd.
    const dryRun = process.env.WECHAT_CC_DRY_RUN === '1'
    const sideOpts = { dryRun }
    if (action === 'install') {
      // Idempotent: best-effort tear down any previous install so we can
      // re-write the plist (e.g. unattended toggle changed). Swallow errors
      // — a partial/stale state (plist missing, launchd doesn't have it)
      // would otherwise block the fresh install.
      try { uninstallService(plan, sideOpts) } catch { /* tolerate */ }
      // Wire onProgress → install-progress.json so the GUI wizard can poll
      // real step state ("(2/4) systemctl daemon-reload") instead of showing
      // an opaque "安装中…" forever. Cleared at start + end so a stale file
      // from a previous crashed install doesn't haunt the next one.
      const progressPath = join(STATE_DIR, 'install-progress.json')
      try { rmSync(progressPath, { force: true }) } catch { /* tolerate */ }
      installService(plan, {
        ...sideOpts,
        onProgress: (e) => {
          try {
            mkdirSync(STATE_DIR, { recursive: true })
            writeFileSync(progressPath, JSON.stringify({ ...e, ts: Date.now() }))
          } catch { /* progress is best-effort — never break install */ }
        },
      })
      try { rmSync(progressPath, { force: true }) } catch { /* tolerate */ }
    } else if (action === 'start') startService(plan, sideOpts)
    else if (action === 'stop') stopService(plan, sideOpts)
    else if (action === 'uninstall') uninstallService(plan, sideOpts)
    const out = { ok: true as const, action, plan, agentConfig: config, dryRun }
    const serviceActionSchema = action === 'install' ? ServiceInstallOutput
      : action === 'start' ? ServiceStartOutput
      : action === 'stop' ? ServiceStopOutput
      : ServiceUninstallOutput
    if (json) console.log(JSON.stringify(serviceActionSchema.parse(out), null, 2))
    else console.log(`service ${action}: ok${dryRun ? ' (dry-run)' : ''}`)
  },
})

const installProgressCmd = defineCommand({
  meta: {
    name: 'install-progress',
    description: 'Read the current service-install progress (JSON: {step, total, label, ts}). Used by the desktop wizard to poll real install state instead of guessing. Empty {} when no install is in flight.',
  },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (default; flag is for symmetry with other commands)' },
  },
  async run() {
    const { readInstallProgress } = await import('./src/cli/install-progress.ts')
    const result = readInstallProgress(STATE_DIR)
    if (result.kind === 'progress') {
      console.log(JSON.stringify(result.value))
      return
    }
    if (result.kind === 'invalid') {
      // Wizard polls at ~250ms; never crash it. Surface the validation
      // error to stderr (visible in `wechat-cc logs` when run via service)
      // but keep stdout = `{}` so the wizard treats it as "no progress yet".
      console.error(`install-progress.json invalid: ${result.error}`)
    }
    console.log('{}')
  },
})

const replyCmd = defineCommand({
  meta: {
    name: 'reply',
    description: 'Send a text reply via WeChat (CLI fallback for the MCP `reply` tool — same on-disk state as the running daemon)',
  },
  args: {
    to: { type: 'string', description: 'Target chat id (omit → most-recently-active chat)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // text comes from positional args (citty surfaces unconsumed positionals
    // via RawArgs._). Joining with ' ' matches the legacy parser, which
    // accumulated all non-flag tokens. Empty → fall through to stdin.
    const positional = (args._ ?? []) as string[]
    const inlineText = positional.length > 0 ? positional.join(' ') : undefined
    // CLI fallback for the MCP `reply` tool — same code path as the
    // daemon (sendReplyOnce reads state from disk), so recipient
    // resolution + session continuity are identical whether the
    // daemon is running or not.
    const { sendReplyOnce, defaultTerminalChatId } = await import('./src/lib/send-reply.ts')
    const json = Boolean(args.json)
    const emitFailure = (error: string): void => {
      if (json) console.log(JSON.stringify(ReplyOutput.parse({ ok: false, error })))
      else console.error(`reply failed: ${error}`)
      process.exit(1)
    }
    const chatId = args.to ?? defaultTerminalChatId() ?? undefined
    if (!chatId) {
      emitFailure('no chat resolved — pass --to <chat_id> or send a WeChat message first so the daemon records one')
      return
    }
    const text = inlineText ?? (await readStdin()).trim()
    if (!text) {
      emitFailure('no text — pass it as an argument or pipe it on stdin')
      return
    }
    const result = await sendReplyOnce(chatId, text)
    if (!result.ok) {
      emitFailure(result.error)
      return
    }
    if (json) {
      console.log(JSON.stringify(ReplyOutput.parse({ ok: true, chat_id: chatId, chunks: result.chunks, account: result.account })))
    } else {
      console.log(`Sent: ${result.chunks} chunk(s) via account ${result.account} → ${chatId}`)
    }
  },
})

const updateCmd = defineCommand({
  meta: {
    name: 'update',
    description: 'Pull latest + reinstall deps + restart service. --check probes only (no side effects).',
  },
  args: {
    check: { type: 'boolean', description: 'Probe only — no side effects' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const check = Boolean(args.check)
    const json = Boolean(args.json)
    const { analyzeUpdate, applyUpdate, defaultUpdateDeps } = await import('./src/cli/update.ts')
    // Compiled-bundle short-circuit: when the binary is shipped inside a
    // desktop .app/.exe, there is no git repo nearby. Surface this with a
    // dedicated `not_a_git_repo` reason instead of bubbling up an empty-
    // stderr fetch_failed (which the GUI couldn't tell from a real outage).
    const { existsSync } = await import('node:fs')
    const here = dirname(fileURLToPath(import.meta.url))
    const repoRoot = compiledRepoRoot() ?? here
    const hasGitRepo = existsSync(join(repoRoot, '.git'))
    if (!hasGitRepo) {
      const synthetic = {
        ok: false as const,
        mode: check ? ('check' as const) : ('apply' as const),
        reason: 'not_a_git_repo' as const,
        message: 'no git repo at this binary\'s location; in-place updates are not available for desktop bundles (download a newer version from GitHub Releases instead)',
        details: { repoRoot },
      }
      if (json) console.log(JSON.stringify((check ? UpdateCheckOutput : UpdateApplyOutput).parse(synthetic), null, 2))
      else console.error(`update: not_a_git_repo — ${synthetic.message}`)
      if (!json) process.exit(1)
      return
    }
    const deps = defaultUpdateDeps(repoRoot, STATE_DIR)
    if (check) {
      const probe = analyzeUpdate(deps)
      if (json) {
        console.log(JSON.stringify(UpdateCheckOutput.parse(probe), null, 2))
      } else if (!probe.ok) {
        console.error(`update check: ${probe.reason} — ${probe.message}`)
        process.exit(1)
      } else {
        console.log(probe.updateAvailable
          ? `update available: ${probe.currentCommit} → ${probe.latestCommit} (${probe.behind} commits${probe.lockfileWillChange ? ', lockfile changes' : ''})`
          : `up to date (${probe.currentCommit})`)
      }
      return
    }
    const result = await applyUpdate(deps)
    if (json) {
      console.log(JSON.stringify(UpdateApplyOutput.parse(result), null, 2))
    } else if (!result.ok) {
      console.error(`update failed: ${result.reason} — ${result.message}`)
      process.exit(1)
    } else {
      const lockNote = result.lockfileChanged ? ', deps reinstalled' : ''
      console.log(`updated: ${result.fromCommit} → ${result.toCommit}${lockNote}, daemon=${result.daemonAction} (${result.elapsedMs}ms)`)
    }
  },
})

/**
 * `--timeout-ms` / `--health-timeout-ms` 的解析(自维护三件套共用)。
 *
 * WHY 不再用 `Number(x)` + `Number.isFinite` 悄悄兜底:`--timeout-ms abc`
 * 以前是 NaN ⇒ 当成「没传」⇒ 按缺省值跑完一整轮真机自检,人以为自己设了
 * 30 秒上限,其实等了四分钟。`--timeout-ms 0` / 负数同理(缺省顶上)。
 * 数值开关写错了就当场报错退 1,别替用户猜。
 */


// ── selftest — real-machine closed loop against a running daemon ───────
//
// spec: docs/superpowers/specs/2026-09-18-self-maintenance-design.md §2.
// Pure logic lives in src/cli/selftest.ts (runWorkbenchSelftest /
// runChatSelftest, injected deps); this just parses flags, wires the real
// deps (operator token from STATE_DIR/internal-api-info.json), and prints
// + exits per SELFTEST_EXIT. Never touches the owner's real WeChat chat.

const selftestWorkbenchCmd = defineCommand({
  meta: { name: 'workbench', description: '真机闭环自检:起一个 scratch 工作台任务,核对回复/工具活动/权限卡放行/写文件等信号(daemon 需在跑)' },
  args: {
    executor: { type: 'string', required: true, description: '执行者 provider id(claude / codex / cursor / agy / …)' },
    image: { type: 'boolean', description: '带一张自生成的红方块 PNG 附件,问模型图里是什么颜色(替换 activity_seen/permission_roundtrip/file_written 三项为 answer_mentions_red)' },
    resume: { type: 'boolean', description: '额外走一次 continue,核对续接(resume_replied)' },
    json: { type: 'boolean', description: 'JSON 输出(SelftestReport),不输出人读版' },
    'timeout-ms': { type: 'string', description: '总超时,毫秒(缺省 240000)' },
    keep: { type: 'boolean', description: '保留 scratch 项目目录,不在跑完后删除' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runWorkbenchSelftest, formatSelftestReport, defaultSelftestDeps, SELFTEST_EXIT } = await import('./src/cli/selftest.ts')
    const timeout = parseTimeoutMsFlag(args['timeout-ms'])
    if (!timeout.ok) {
      const message = `--timeout-ms ${timeout.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_ms', message }, null, 2))
      else console.error(`selftest workbench: ${message}`)
      process.exit(SELFTEST_EXIT.failed)
      return
    }
    try {
      const report = await runWorkbenchSelftest(defaultSelftestDeps(STATE_DIR), {
        executor: args.executor,
        image: Boolean(args.image),
        resume: Boolean(args.resume),
        keep: Boolean(args.keep),
        ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
      })
      if (json) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(formatSelftestReport(report))
        if (report.scratchPath) console.log(`scratch: ${report.scratchPath}`)
      }
      process.exit(report.ok ? SELFTEST_EXIT.ok : SELFTEST_EXIT.failed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noDaemon = message === 'daemon_not_running'
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
      else console.error(`selftest workbench: ${noDaemon ? 'daemon 没在跑' : message}`)
      process.exit(noDaemon ? SELFTEST_EXIT.noDaemon : SELFTEST_EXIT.failed)
    }
  },
})

const selftestChatCmd = defineCommand({
  meta: { name: 'chat', description: '真机闭环自检:一轮测试对话(daemon 代 spawn,不发微信),核对回复/工具调用(daemon 需在跑)' },
  args: {
    provider: { type: 'string', required: true, description: 'provider id' },
    text: { type: 'string', description: '自定义测试话术(缺省会额外核对 wechat/ping 被调用)' },
    resume: { type: 'boolean', description: '用第一轮的 sessionId 再问一轮,核对续接(resume_replied)' },
    json: { type: 'boolean', description: 'JSON 输出(SelftestReport),不输出人读版' },
    'timeout-ms': { type: 'string', description: '单轮对话上限,毫秒(缺省 180000;daemon 侧轮次看门狗缺省 120000)' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runChatSelftest, formatSelftestReport, defaultSelftestDeps, SELFTEST_EXIT } = await import('./src/cli/selftest.ts')
    const timeout = parseTimeoutMsFlag(args['timeout-ms'])
    if (!timeout.ok) {
      const message = `--timeout-ms ${timeout.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_ms', message }, null, 2))
      else console.error(`selftest chat: ${message}`)
      process.exit(SELFTEST_EXIT.failed)
      return
    }
    try {
      const report = await runChatSelftest(defaultSelftestDeps(STATE_DIR), {
        provider: args.provider,
        ...(args.text !== undefined ? { text: args.text } : {}),
        resume: Boolean(args.resume),
        ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
      })
      if (json) console.log(JSON.stringify(report, null, 2))
      else console.log(formatSelftestReport(report))
      process.exit(report.ok ? SELFTEST_EXIT.ok : SELFTEST_EXIT.failed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noDaemon = message === 'daemon_not_running'
      if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
      else console.error(`selftest chat: ${noDaemon ? 'daemon 没在跑' : message}`)
      process.exit(noDaemon ? SELFTEST_EXIT.noDaemon : SELFTEST_EXIT.failed)
    }
  },
})

const selftestCmd = defineCommand({
  meta: { name: 'selftest', description: '自维护:真机闭环自检(daemon 需在跑);见 docs/maintainer/verify.md' },
  subCommands: { workbench: selftestWorkbenchCmd, chat: selftestChatCmd },
})

// ── ci triage — 「看 CI」这一步从人的判断变成一条命令 ──────────────────
//
// spec: docs/superpowers/specs/2026-09-18-ci-triage-design.md §3。纯逻辑在
// src/cli/ci-triage.ts,取数与等待在 src/cli/ci-triage-run.ts;这里只解析开关、
// 打印、按 CI_TRIAGE_EXIT 退出。跟 `self deploy` 一样,只在开发机上有意义
// (依赖 gh 的登录态)。

/** `--max-reruns` / `--timeout-min` 这类计数开关:写错了当场报错,别替用户猜。 */

const ciTriageCmd = defineCommand({
  meta: { name: 'triage', description: '看 CI:这个 SHA 绿了吗?红的是自己的锅还是已知 flake(需要 gh 登录态)' },
  args: {
    sha: { type: 'string', description: '要看的提交(缺省 HEAD;短 sha 会先 git rev-parse 成 40 位)' },
    branch: { type: 'string', description: '去哪条分支上找「上一次绿」当 diff 基线(缺省当前分支)' },
    wait: { type: 'boolean', description: '等运行出现(最多 2 分钟)并等它跑完' },
    rerun: { type: 'boolean', description: '判成 flake 时重跑失败作业;--wait 时等完重判,第二次仍红一律算真红' },
    'max-reruns': { type: 'string', description: '最多重跑几次(缺省 1;0 = 从不重跑)。>1 只对 __NO_SUMMARY__ 那类作业级 flake 有意义 —— 具体测试的失败第二轮一律判真红,再重跑也翻不过来' },
    'timeout-min': { type: 'string', description: '等运行跑完的总上限,分钟(缺省 30)' },
    json: { type: 'boolean', description: 'JSON 输出(TriageReport),不输出人读版' },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const { runCiTriage, defaultCiTriageDeps, CI_TRIAGE_EXIT } = await import('./src/cli/ci-triage-run.ts')
    const { formatTriage } = await import('./src/cli/ci-triage.ts')

    const maxReruns = parseCountFlag(args['max-reruns'], 0)
    if (!maxReruns.ok) {
      const message = `--max-reruns ${maxReruns.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_max_reruns', message }, null, 2))
      else console.error(`ci triage: ${message}`)
      // 2 而不是 1:开关写错了是「没能去判」,不是「判出来是真红」。
      process.exit(CI_TRIAGE_EXIT.noRun)
      return
    }
    const timeoutMin = parseCountFlag(args['timeout-min'], 1)
    if (!timeoutMin.ok) {
      const message = `--timeout-min ${timeoutMin.error}`
      if (json) console.log(JSON.stringify({ ok: false, error: 'invalid_timeout_min', message }, null, 2))
      else console.error(`ci triage: ${message}`)
      process.exit(CI_TRIAGE_EXIT.noRun)
      return
    }

    const { report, exitCode } = await runCiTriage(defaultCiTriageDeps(process.cwd()), {
      ...(args.sha !== undefined ? { sha: String(args.sha) } : {}),
      ...(args.branch !== undefined ? { branch: String(args.branch) } : {}),
      wait: Boolean(args.wait),
      rerun: Boolean(args.rerun),
      ...(maxReruns.value !== undefined ? { maxReruns: maxReruns.value } : {}),
      ...(timeoutMin.value !== undefined ? { timeoutMin: timeoutMin.value } : {}),
    })
    if (json) console.log(JSON.stringify(report, null, 2))
    else console.log(formatTriage(report))
    process.exit(exitCode)
  },
})

const ciCmd = defineCommand({
  meta: { name: 'ci', description: '看 CI 的信号面(见 docs/maintainer/ci-and-flakes.md)' },
  subCommands: { triage: ciTriageCmd },
})

// ── mode set — programmatic mode switch via running daemon's internal-api ──
//
// Reads STATE_DIR/internal-api-info.json (written by daemon on start) to
// discover the bound port + token file. Posts to /v1/conversation/set-mode.
// On error (daemon not running, 401, 5xx): clear error message + exit 1.

const modeSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set chat mode programmatically (calls running daemon via internal-api)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    mode: {
      type: 'positional',
      required: true,
      description: 'cc|codex|solo|both|chat (or full JSON mode shape)',
      valueHint: 'cc|codex|solo|both|chat|json',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { existsSync, readFileSync } = await import('node:fs')
    const infoPath = join(STATE_DIR, 'internal-api-info.json')
    const jsonOut = Boolean(args.json)

    const emitError = (msg: string): never => {
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }))
      else console.error(`mode set: ${msg}`)
      process.exit(1)
    }

    if (!existsSync(infoPath)) {
      emitError('daemon not running (internal-api-info.json not found — start the daemon first)')
    }

    let info: { baseUrl: string; tokenFilePath: string }
    try {
      info = JSON.parse(readFileSync(infoPath, 'utf8'))
    } catch (err) {
      emitError(`could not read internal-api-info.json: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!info!.baseUrl || !info!.tokenFilePath) {
      emitError('internal-api-info.json is malformed (missing baseUrl or tokenFilePath)')
    }

    let tokenHex: string
    try {
      tokenHex = readFileSync(info!.tokenFilePath, 'utf8').trim()
    } catch (err) {
      emitError(`could not read token file: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Map shorthands to full Mode shapes (matches mode-commands.ts semantics)
    const SHORTHAND: Record<string, object> = {
      cc:    { kind: 'solo', provider: 'claude' },
      codex: { kind: 'solo', provider: 'codex' },
      solo:  { kind: 'solo', provider: 'claude' },
      both:  { kind: 'parallel' },
      chat:  { kind: 'chatroom' },
    }

    let modeObj: object
    const raw = args.mode
    if (SHORTHAND[raw]) {
      modeObj = SHORTHAND[raw]!
    } else {
      try {
        modeObj = JSON.parse(raw)
        if (typeof modeObj !== 'object' || modeObj === null) throw new Error('must be a JSON object')
      } catch (err) {
        emitError(`unrecognised mode '${raw}' — use cc/codex/solo/both/chat or a JSON mode shape: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    let resp: Response
    try {
      resp = await fetch(`${info!.baseUrl}/v1/conversation/set-mode`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${tokenHex!}`,
        },
        body: JSON.stringify({ chatId: args.chatId, mode: modeObj! }),
      })
    } catch (err) {
      emitError(`could not reach daemon (${info!.baseUrl}): ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!resp!.ok) {
      const text = await resp!.text().catch(() => '')
      if (resp!.status === 401) {
        // Distinguish stale CLI token from daemon auth rejection: the
        // 401 happens for both, but operator action differs. A stale
        // token means rotating the file under .claude/channels/wechat
        // (or a daemon restart that rotates it); an auth rejected
        // response from a fresh token means the daemon's identity
        // store is out of sync with the CLI's. Surface the body so
        // both cases are obvious.
        const looksStale = /token mismatch|stale|expired/i.test(text)
        const hint = looksStale
          ? 'stale token — restart the daemon to rotate, OR delete ~/.claude/channels/wechat/internal-token and re-run.'
          : 'daemon rejected authentication. The CLI loaded the current token but the daemon refused it; check daemon logs for [AUTH] entries.'
        emitError(`unauthorized: ${hint}`)
      }
      emitError(`daemon returned ${resp!.status}: ${text}`)
    }

    const result = await resp!.json() as Record<string, unknown>
    if (jsonOut) console.log(JSON.stringify(result, null, 2))
    else console.log(`mode set: ok (chat=${args.chatId} mode=${JSON.stringify(modeObj!)})`)
  },
})

const modeCmd = defineCommand({
  meta: { name: 'mode', description: 'Conversation mode management (programmatic switch via running daemon)' },
  subCommands: { set: modeSetCmd },
})

// Hidden — used only by the daemon to spawn its own stdio MCP children
// when running from the compiled binary. The compiled binary doesn't ship
// `src/mcp-servers/<name>/main.ts` as files on disk, so the daemon's old
// strategy of passing a script path to `process.execPath` failed silently
// (see src/daemon/bootstrap/mcp-specs.ts for the full bug story). Now the
// daemon emits `args: ['mcp-server', '<name>']` and we dynamic-import the
// matching bundled entrypoint here. The MCP server module connects to
// stdio at top level; control returns once the transport is attached, but
// the process stays alive on stdin's pending reader until Claude SDK
// closes its end. Source mode skips this path entirely (mcp-specs uses
// the .ts script path directly).
const mcpServerCmd = defineCommand({
  meta: {
    name: 'mcp-server',
    description: 'Internal — run a stdio MCP server entrypoint (wechat | delegate). Spawned by the daemon when running from the compiled binary.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Server name (wechat | delegate)',
      valueHint: 'name',
    },
  },
  async run({ args }) {
    if (args.name === 'wechat') {
      await import('./src/mcp-servers/wechat/main')
    } else if (args.name === 'delegate') {
      await import('./src/mcp-servers/delegate/main')
    } else {
      console.error(`mcp-server: unknown name "${args.name}" (expected wechat | delegate)`)
      process.exit(2)
    }
  },
})

// ── hearth federated source — wechat-cc federated-source [--authorize|--deauthorize|--status] ──
//
// Authorized launcher hearth spawns (per-query, stdio) to query wechat as a
// federated source. `--authorize`/`--deauthorize`/`--status` manage the owner
// consent grant (design option B: grant + operator token + admin-tier mint);
// bare `federated-source` is the run mode hearth actually invokes — it mints
// a short-lived admin token and serves the slim federated_query-only MCP.
// Verb logic lives in ./cli-federated-source.ts (dynamic-imported below to
// keep this command's cold-start cost off every other subcommand).
const federatedSourceCmd = defineCommand({
  meta: { name: 'federated-source', description: 'Expose wechat as a hearth federated source (run mode: stdio MCP spawned by hearth)' },
  args: {
    authorize: { type: 'boolean', description: 'Grant hearth consent to mint admin-tier tokens (writes federated-grant.json, 0600)' },
    deauthorize: { type: 'boolean', description: 'Revoke the federation grant' },
    status: { type: 'boolean', description: 'Show grant state + daemon baseUrl' },
    'info-path': { type: 'string', description: 'Override internal-api-info.json path (default: ~/.claude/channels/wechat/internal-api-info.json)', valueHint: 'path' },
  },
  async run({ args }) {
    const { federatedSourceAuthorize, federatedSourceDeauthorize, federatedSourceStatus, resolveFederatedSourceVerb } = await import('./cli-federated-source')
    const verb = resolveFederatedSourceVerb({ authorize: args.authorize, deauthorize: args.deauthorize, status: args.status })
    if (typeof verb !== 'string') {
      console.error(verb.error)
      process.exit(2)
    }
    let infoPath = args['info-path']
    if (!infoPath) {
      const { homedir } = await import('node:os')
      infoPath = join(homedir(), '.claude', 'channels', 'wechat', 'internal-api-info.json')
    }
    if (verb === 'authorize') { federatedSourceAuthorize(infoPath, Date.now(), console.log); return }
    if (verb === 'deauthorize') { federatedSourceDeauthorize(infoPath, console.log); return }
    if (verb === 'status') { federatedSourceStatus(infoPath, console.log); return }
    // Run mode — what hearth actually spawns per query.
    const { runFederatedSource } = await import('./src/mcp-servers/wechat/federated-source')
    await runFederatedSource(infoPath)
  },
})

// ── A2A agent management — wechat-cc agent {inspect,add,list,pause,resume,remove,activity} ──
//
// Pure wrappers over createA2ARegistry / createA2AClient / makeA2AEventsStore.
// Heavy logic lives in src/cli/agent.ts (testable without a running daemon).

const agentInspectCmd = defineCommand({
  meta: { name: 'inspect', description: 'Fetch Agent Card and print metadata' },
  args: {
    url: { type: 'positional', required: true, description: 'Agent base URL (/.well-known/agent.json is appended)', valueHint: 'url' },
  },
  async run({ args }) {
    const { cmdAgentInspect } = await import('./src/cli/agent.ts')
    await cmdAgentInspect(args.url)
  },
})

const agentAddCmd = defineCommand({
  meta: { name: 'add', description: 'Register a new A2A agent (fetches Agent Card, generates inbound API key)' },
  args: {
    url: { type: 'positional', required: true, description: 'Agent base URL', valueHint: 'url' },
    id: { type: 'string', description: 'Explicit agent id slug (default: slugified name from Agent Card)' },
    'name-override': { type: 'string', description: 'Override the display name from the Agent Card' },
    'outbound-key': { type: 'string', description: 'Bearer key to send when wechat-cc calls out to this agent' },
  },
  async run({ args }) {
    const { cmdAgentAdd } = await import('./src/cli/agent.ts')
    await cmdAgentAdd(STATE_DIR, args.url, {
      id: args.id,
      nameOverride: args['name-override'],
      outboundKey: args['outbound-key'],
    })
  },
})

const agentListCmd = defineCommand({
  meta: { name: 'list', description: 'List registered A2A agents' },
  async run() {
    const { cmdAgentList } = await import('./src/cli/agent.ts')
    cmdAgentList(STATE_DIR)
  },
})

const agentPauseCmd = defineCommand({
  meta: { name: 'pause', description: 'Pause inbound/outbound for an agent' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
  },
  async run({ args }) {
    const { cmdAgentPause } = await import('./src/cli/agent.ts')
    cmdAgentPause(STATE_DIR, args.id, true)
  },
})

const agentResumeCmd = defineCommand({
  meta: { name: 'resume', description: 'Un-pause an agent' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
  },
  async run({ args }) {
    const { cmdAgentPause } = await import('./src/cli/agent.ts')
    cmdAgentPause(STATE_DIR, args.id, false)
  },
})

const agentRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Drop agent registration' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
  },
  async run({ args }) {
    const { cmdAgentRemove } = await import('./src/cli/agent.ts')
    cmdAgentRemove(STATE_DIR, args.id)
  },
})

const agentActivityCmd = defineCommand({
  meta: { name: 'activity', description: 'Print recent A2A events for an agent (newest first)' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
    limit: { type: 'string', description: 'Max events to show (default 20)' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 20
    const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 20
    const { cmdAgentActivity } = await import('./src/cli/agent.ts')
    cmdAgentActivity(STATE_DIR, args.id, limit)
  },
})

const agentInfoCmd = defineCommand({
  meta: { name: 'info', description: "Show A2A server status (base URL + registered agents) — for sharing URL with external agents" },
  async run() {
    const { cmdAgentInfo } = await import('./src/cli/agent.ts')
    cmdAgentInfo(STATE_DIR)
  },
})

const agentEditCmd = defineCommand({
  meta: { name: 'edit', description: 'Edit a registered A2A agent (rotate keys, rename, change URL) without remove + re-add' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
    name: { type: 'string', description: 'New display name' },
    url: { type: 'string', description: 'New URL' },
    'outbound-key': { type: 'string', description: 'Rotate outbound API key (we use this when calling the agent)' },
    'rotate-inbound-key': { type: 'boolean', description: 'Generate a fresh inbound API key (external agent uses it to call us)' },
  },
  async run({ args }) {
    const { cmdAgentEdit } = await import('./src/cli/agent.ts')
    cmdAgentEdit(STATE_DIR, args.id, {
      name: args.name,
      url: args.url,
      outboundKey: args['outbound-key'],
      rotateInboundKey: Boolean(args['rotate-inbound-key']),
    })
  },
})

const agentTestCmd = defineCommand({
  meta: { name: 'test', description: 'Send a synthetic notify to validate the inbound→chat path (default) or outbound (--outbound)' },
  args: {
    id: { type: 'positional', required: true, description: 'Registered agent id', valueHint: 'agent-id' },
    text: { type: 'string', description: 'Test message text (default: "test from <id> via wechat-cc")' },
    outbound: { type: 'boolean', description: 'Test outbound (wechat-cc → external agent) instead of inbound' },
  },
  async run({ args }) {
    const text = args.text ?? `test from ${args.id} via wechat-cc`
    const { cmdAgentTest } = await import('./src/cli/agent.ts')
    await cmdAgentTest(STATE_DIR, args.id, text, { outbound: Boolean(args.outbound) })
  },
})

const agentCmd = defineCommand({
  meta: { name: 'agent', description: 'A2A agent registry — register, inspect, pause, resume, remove, and view activity' },
  subCommands: {
    inspect: agentInspectCmd,
    add: agentAddCmd,
    list: agentListCmd,
    pause: agentPauseCmd,
    resume: agentResumeCmd,
    remove: agentRemoveCmd,
    activity: agentActivityCmd,
    info: agentInfoCmd,
    edit: agentEditCmd,
    test: agentTestCmd,
  },
})

// ── 觅食台 social surface — wechat-cc social {wishes,enable} ──
// `wishes` needs the running daemon (GET /v1/social/wishes — spec
// 2026-09-04-wish-postcard §4); it replaces the P4-era propose/confirm/
// cancel/reveal/seeks/echoes/pledges subcommands (心愿 signals a wish
// through-and-through, sent with 派 <id> / voided with 取消 <id> in WeChat
// or the mcp tool — the CLI's only remaining job here is to list them).

const socialWishesCmd = defineCommand({
  meta: { name: 'wishes', description: 'List my 心愿 + effective status (needs running daemon)' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { cmdSocialWishes } = await import('./src/cli/social.ts')
    try {
      await cmdSocialWishes(STATE_DIR, { json: Boolean(args.json) })
    } catch {
      // cmdSocialWishes's default `fail` already printed the message.
      process.exit(1)
    }
  },
})

// `enable` is a one-toggle onramp: sets social_enabled + fills in the two
// other social-boot settings ONLY when absent (merge-persist, same
// read-modify-write idiom as self-agent-id.ts). No `disable` — turning
// social off is an operator-config edit, not part of this onramp.
const socialEnableCmd = defineCommand({
  meta: { name: 'enable', description: '一键开启觅食台社交(merge-persist,不覆盖已有设置)' },
  args: {
    status: { type: 'boolean', description: '只打印当前三项设置,不写入' },
  },
  async run({ args }) {
    const { cmdSocialEnable } = await import('./src/cli/social-enable.ts')
    cmdSocialEnable(STATE_DIR, { status: Boolean(args.status) })
  },
})

const socialCmd = defineCommand({
  meta: { name: 'social', description: '觅食台 — list 心愿 (wishes), and enable (开启)' },
  subCommands: {
    wishes: socialWishesCmd,
    enable: socialEnableCmd,
  },
})

// ── 配对码 — friend pairing (spec §7) ─────────────────────────────────
// wechat-cc pair          → mint + print a 6-digit code (share with a friend)
// wechat-cc pair <code>   → redeem a friend's code and connect
// Both need the RUNNING daemon (internal-api, tier trusted) — same idiom as
// `social wishes`. NOT to be confused with `hand invite`/`hand join`, which
// pair two WORKER hands (delegated-agent capacity), not two people's bots.
const pairCmd = defineCommand({
  meta: {
    name: 'pair',
    description: '配对码 — 和朋友的 bot 建边:无参生成码,带 6 位码接受(≠ hand invite/join 的干活手配对;需运行中的 daemon)',
  },
  args: {
    code: { type: 'positional', required: false, description: '朋友的 6 位配对码', valueHint: 'code' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    try {
      if (args.code) {
        const { cmdPairAccept } = await import('./src/cli/pair.ts')
        await cmdPairAccept(STATE_DIR, String(args.code), { json: Boolean(args.json) })
      } else {
        const { cmdPairStart } = await import('./src/cli/pair.ts')
        await cmdPairStart(STATE_DIR, { json: Boolean(args.json) })
      }
    } catch {
      // cmdPairStart/cmdPairAccept's default `fail` already printed the message.
      process.exit(1)
    }
  },
})


// Subcommands literal first → both `cittyRoot.subCommands` and
// `MIGRATED_COMMANDS` derive from this single source of truth. Adding a new
// citty subcommand only requires touching this object — the dispatch set
// updates itself, and there's no `cittyRoot.subCommands as Record<string,
// unknown>` cast needed (which would have hidden a future Resolvable<>
// refactor — citty's type allows lazy / promise forms — from typecheck).


// License / Pro entitlement. `activate DEV-anything` unlocks Pro locally for
// testing before Lemon Squeezy is wired.
const licenseStatusCmd = defineCommand({
  meta: { name: 'status', description: 'Show Pro entitlement (free / pro, expiry)' },
  args: { json: { type: 'boolean', description: 'JSON output' } },
  async run({ args }) {
    const { getEntitlement } = await import('./src/daemon/license/license')
    const e = getEntitlement(STATE_DIR)
    if (args.json) { console.log(JSON.stringify(e, null, 2)); return }
    console.log(`${e.pro ? '★ Pro' : '· Free'} — ${e.reason}${e.expiresAt ? ` (until ${e.expiresAt})` : ''}`)
  },
})
const licenseActivateCmd = defineCommand({
  meta: { name: 'activate', description: 'Activate a license key (use DEV-xxx to unlock Pro locally for testing)' },
  args: { key: { type: 'positional', required: true, description: 'License key', valueHint: 'key' } },
  async run({ args }) {
    const { activate } = await import('./src/daemon/license/license')
    const { hostname } = await import('node:os')
    const r = await activate(STATE_DIR, args.key, hostname())
    if (!r.ok) { console.error(`activation failed: ${r.error}`); process.exit(1) }
    console.log(`activated — ${r.entitlement.pro ? 'Pro' : 'not Pro'} (${r.entitlement.reason}). restart the daemon to apply.`)
  },
})
const licenseDeactivateCmd = defineCommand({
  meta: { name: 'deactivate', description: 'Remove the local license (back to Free)' },
  async run() {
    const { clearLicense } = await import('./src/daemon/license/license')
    clearLicense(STATE_DIR)
    console.log('license removed — back to Free. restart the daemon to apply.')
  },
})
const licenseCmd = defineCommand({
  meta: { name: 'license', description: 'Manage the Pro license' },
  subCommands: { status: licenseStatusCmd, activate: licenseActivateCmd, deactivate: licenseDeactivateCmd },
})

const backupCreateCmd = defineCommand({
  meta: { name: 'create', description: '立即做一次备份快照（仅不可再生数据，约 2MB）' },
  args: { keep: { type: 'string', description: '备份后仅保留最新 N 份（默认不清理）' } },
  async run({ args }) {
    const { createBackup, pruneBackups } = await import('./src/lib/backup')
    const r = await createBackup({ stateDir: STATE_DIR })
    console.log(`✓ 已备份 → ${r.path} (${Math.round(r.bytes / 1024)}KB, ${r.entries.length} 项)`)
    const keep = Number(args.keep)
    if (Number.isFinite(keep) && keep > 0) {
      const removed = pruneBackups(STATE_DIR, keep)
      if (removed > 0) console.log(`已清理 ${removed} 份旧备份，保留最新 ${keep} 份`)
    }
  },
})

const backupListCmd = defineCommand({
  meta: { name: 'list', description: '列出已有备份（新→旧）' },
  async run() {
    const { listBackups } = await import('./src/lib/backup')
    const all = listBackups(STATE_DIR)
    if (all.length === 0) { console.log('还没有备份 — 跑 `wechat-cc backup create` 做第一份。'); return }
    for (const b of all) console.log(`${b.path}  ${Math.round(b.bytes / 1024)}KB`)
  },
})

const backupRestoreCmd = defineCommand({
  meta: { name: 'restore', description: '从备份恢复（需先停掉 daemon；被替换的文件会存进 restore-undo-*）' },
  args: { file: { type: 'positional', required: true, description: '备份文件路径（backup list 里的一行）' } },
  async run({ args }) {
    const { restoreBackup } = await import('./src/lib/backup')
    const daemonRunning = () => {
      try {
        const info = JSON.parse(require('node:fs').readFileSync(join(STATE_DIR, 'internal-api-info.json'), 'utf8'))
        // Liveness = the recorded pid still exists. A sync signal-0 probe —
        // no fetch, no async, works even when the http face is wedged.
        if (typeof info.pid === 'number') { process.kill(info.pid, 0); return true }
        return false
      } catch { return false }
    }
    const r = await restoreBackup({ stateDir: STATE_DIR, file: String(args.file), daemonRunning })
    if (!r.ok) {
      if (r.error === 'daemon_running') {
        console.error('✗ daemon 正在运行 — 先 `wechat-cc daemon stop`（或停掉 LaunchAgent）再恢复。')
      } else {
        console.error(`✗ 备份文件读不了：${r.detail ?? r.error}`)
      }
      process.exit(1)
    }
    console.log(`✓ 已恢复 ${r.restored.length} 项。被替换的旧文件在 ${r.undoDir} — 确认无误后可删。`)
  },
})

const backupCmd = defineCommand({
  meta: { name: 'backup', description: '备份/恢复不可再生数据（记忆、事实库、配置）' },
  subCommands: { create: backupCreateCmd, list: backupListCmd, restore: backupRestoreCmd },
})

const SUBCOMMANDS = {
  backup: backupCmd,
  status: statusCmd,
  plugin: pluginCmd,
  license: licenseCmd,
  hand: handCmd,
  list: listCmd,
  install: installCmd,
  doctor: doctorCmd,
  'setup-status': setupStatusCmd,
  // PR4 batch 2 — read-only inspection commands.
  events: eventsCmd,
  observations: observationsCmd,
  milestones: milestonesCmd,
  conversations: conversationsCmd,
  logs: logsCmd,
  log: logCmd,
  // PR4 batch 3a — sessions / avatar / guard / provider namespaces.
  sessions: sessionsCmd,
  avatar: avatarCmd,
  guard: guardCmd,
  provider: providerCmd,
  // PR4 batch 3b — memory / account / daemon / demo namespaces.
  memory: memoryCmd,
  account: accountCmd,
  access: accessCmd,
  companion: companionCmd,
  // connection-owner detection (Task 4).
  connection: connectionCmd,
  daemon: daemonCmd,
  demo: demoCmd,
  // PR4 batch 3c — heavy entry points. Completes the migration; legacy
  // parseCliArgs + CliArgs union are deleted in this commit.
  run: runCmd,
  setup: setupCmd,
  'setup-poll': setupPollCmd,
  service: serviceCmd,
  reply: replyCmd,
  update: updateCmd,
  // 自维护三件套 Task 3 — `self deploy` (spec 2026-09-18-self-maintenance §3).
  self: selfCmd,
  // 自维护三件套 Task 2 — `selftest workbench|chat` (spec 2026-09-18-self-maintenance §2).
  selftest: selftestCmd,
  // CI 信号面 — `ci triage` (spec 2026-09-18-ci-triage §3);「看 CI」不再是人的判断。
  ci: ciCmd,
  'install-progress': installProgressCmd,
  mode: modeCmd,
  'mcp-server': mcpServerCmd,
  // A2A agent management (Task 7).
  agent: agentCmd,
  // 觅食台 social surface — wishes/enable.
  social: socialCmd,
  // 配对码 — automatic edge-building (spec §7).
  pair: pairCmd,
  // Dialogue backfill (Task 5). Query subcommands arrive in Task 9.
  dialogue: dialogueCmd,
  // hearth federated source — authorize/deauthorize/status + run mode.
  'federated-source': federatedSourceCmd,
  // 终端 claude / codex 的 hooks 出口(spec 2026-09-09-cli-hook-push)。
  hook: hookCmd,
} as const

export const cittyRoot = defineCommand({
  meta: {
    name: 'wechat-cc',
    version: VERSION_LINE,   // citty 据此自动响应 `wechat-cc --version`(带构建 sha,好认出跑的是哪个构建)
    description: 'WeChat bridge for Claude Code (Agent SDK daemon)',
  },
  subCommands: SUBCOMMANDS,
})


async function main() {
  const argv = process.argv.slice(2)
  const first = argv[0]
  // Bare `wechat-cc` / `--help` / `-h` / `help` → top-level long-form help.
  // citty's auto-generated root help just lists subcommands; HELP_TEXT
  // carries the back-story (RFC pointers, deprecation notes, --dangerously
  // semantics) that we don't want to lose.
  //
  // `wechat-cc <subcommand> --help` still hits citty per-subcommand help
  // because runMain consumes it before any of our run() handlers fire.
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP_TEXT)
    return
  }
  // runMain (vs runCommand) gives us auto `--help` / `-h` handling per
  // subcommand and prints citty's auto-generated usage on unknown commands.
  await runMain(cittyRoot, { rawArgs: argv })
}


if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1) })
}

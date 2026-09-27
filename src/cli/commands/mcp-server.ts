// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
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
export const mcpServerCmd = defineCommand({
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
      await import('../../mcp-servers/wechat/main')
    } else if (args.name === 'delegate') {
      await import('../../mcp-servers/delegate/main')
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
export const federatedSourceCmd = defineCommand({
  meta: { name: 'federated-source', description: 'Expose wechat as a hearth federated source (run mode: stdio MCP spawned by hearth)' },
  args: {
    authorize: { type: 'boolean', description: 'Grant hearth consent to mint admin-tier tokens (writes federated-grant.json, 0600)' },
    deauthorize: { type: 'boolean', description: 'Revoke the federation grant' },
    status: { type: 'boolean', description: 'Show grant state + daemon baseUrl' },
    'info-path': { type: 'string', description: 'Override internal-api-info.json path (default: ~/.claude/channels/wechat/internal-api-info.json)', valueHint: 'path' },
  },
  async run({ args }) {
    const { federatedSourceAuthorize, federatedSourceDeauthorize, federatedSourceStatus, resolveFederatedSourceVerb } = await import('../../../cli-federated-source')
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
    const { runFederatedSource } = await import('../../mcp-servers/wechat/federated-source')
    await runFederatedSource(infoPath)
  },
})


#!/usr/bin/env bun
// cli.ts —— 只剩登记表(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design):
// 每个命令族住 src/cli/commands/<family>.ts,这里 import 它、在 SUBCOMMANDS 登记一行;
// 帮手在 src/cli/{output,flags,stdin,daemon-restart,help,repo-root}.ts。
// 守卫:scripts/cli-help.guard.test.ts(所有 --help 快照)、scripts/cli-ratchet.guard.test.ts(只许变小)。
import { defineCommand, runMain } from 'citty'
import { VERSION_LINE } from './src/lib/app-version'
import { HELP_TEXT } from './src/cli/help'
// 命令族(每族一个文件,cli.ts 只登记)。
import { memoryCmd } from './src/cli/commands/memory'
import { selfCmd } from './src/cli/commands/self'
import { pluginCmd } from './src/cli/commands/plugin'
import { handCmd } from './src/cli/commands/hand'
import { sessionsCmd } from './src/cli/commands/sessions'
import { dialogueCmd } from './src/cli/commands/dialogue'
import { statusCmd, listCmd } from './src/cli/commands/status'
import { installCmd } from './src/cli/commands/install'
import { doctorCmd, setupStatusCmd } from './src/cli/commands/doctor'
import { eventsCmd, observationsCmd, milestonesCmd, conversationsCmd } from './src/cli/commands/inspect'
import { logsCmd, logCmd } from './src/cli/commands/logs'
import { avatarCmd } from './src/cli/commands/avatar'
import { guardCmd } from './src/cli/commands/guard'
import { providerCmd } from './src/cli/commands/provider'
import { accountCmd } from './src/cli/commands/account'
import { accessCmd } from './src/cli/commands/access'
import { companionCmd } from './src/cli/commands/companion'
import { hookCmd } from './src/cli/commands/hook'
import { connectionCmd } from './src/cli/commands/connection'
import { daemonCmd } from './src/cli/commands/daemon'
import { demoCmd } from './src/cli/commands/demo'
import { runCmd } from './src/cli/commands/run'
import { setupCmd, setupPollCmd } from './src/cli/commands/setup'
import { serviceCmd } from './src/cli/commands/service'
import { installProgressCmd } from './src/cli/commands/install-progress'
import { replyCmd } from './src/cli/commands/reply'
import { updateCmd } from './src/cli/commands/update'
import { selftestCmd } from './src/cli/commands/selftest'
import { ciCmd } from './src/cli/commands/ci'
import { modeCmd } from './src/cli/commands/mode'
import { mcpServerCmd, federatedSourceCmd } from './src/cli/commands/mcp-server'
import { agentCmd } from './src/cli/commands/agent'
import { socialCmd } from './src/cli/commands/social'
import { pairCmd } from './src/cli/commands/pair'
import { licenseCmd } from './src/cli/commands/license'
import { backupCmd } from './src/cli/commands/backup'
import { cliCmd } from './src/cli/commands/cli'

// PR4 batch 3c: parseCliArgs + CliArgs union deleted. All subcommands now
// flow through citty (see `cittyRoot` below). The previous gate
// `MIGRATED_COMMANDS.has(first)` is gone — citty handles unknown commands
// by printing its auto-generated usage. Bare `wechat-cc` / `--help` /
// `-h` / `help` is intercepted in main() and renders HELP_TEXT.

// Subcommands literal first → both `cittyRoot.subCommands` and
// `MIGRATED_COMMANDS` derive from this single source of truth. Adding a new
// citty subcommand only requires touching this object — the dispatch set
// updates itself, and there's no `cittyRoot.subCommands as Record<string,
// unknown>` cast needed (which would have hidden a future Resolvable<>
// refactor — citty's type allows lazy / promise forms — from typecheck).


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
  cli: cliCmd,   // 外部 agent CLI 版本与自动升级(主人 2026-10-04)
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

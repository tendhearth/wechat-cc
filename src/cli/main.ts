// Full command registry. Loaded only after cli.ts rules out the native hook fast path.
import { defineCommand, runMain } from 'citty'
import { VERSION_LINE } from '../lib/app-version'
import { HELP_TEXT } from './help'
// 命令族(每族一个文件,这里只登记)。
import { memoryCmd } from './commands/memory'
import { selfCmd } from './commands/self'
import { pluginCmd } from './commands/plugin'
import { handCmd } from './commands/hand'
import { sessionsCmd } from './commands/sessions'
import { dialogueCmd } from './commands/dialogue'
import { statusCmd, listCmd } from './commands/status'
import { installCmd } from './commands/install'
import { doctorCmd, setupStatusCmd } from './commands/doctor'
import { eventsCmd, observationsCmd, milestonesCmd, conversationsCmd } from './commands/inspect'
import { logsCmd, logCmd } from './commands/logs'
import { avatarCmd } from './commands/avatar'
import { guardCmd } from './commands/guard'
import { rulesCmd } from './commands/rules'
import { jobsCmd } from './commands/jobs'
import { providerCmd } from './commands/provider'
import { accountCmd } from './commands/account'
import { accessCmd } from './commands/access'
import { companionCmd } from './commands/companion'
import { hookCmd } from './commands/hook'
import { connectionCmd } from './commands/connection'
import { daemonCmd } from './commands/daemon'
import { demoCmd } from './commands/demo'
import { runCmd } from './commands/run'
import { setupCmd, setupPollCmd } from './commands/setup'
import { serviceCmd } from './commands/service'
import { installProgressCmd } from './commands/install-progress'
import { replyCmd } from './commands/reply'
import { updateCmd } from './commands/update'
import { selftestCmd } from './commands/selftest'
import { evalCmd } from './commands/eval'
import { checkupCmd } from './commands/checkup'
import { ciCmd } from './commands/ci'
import { modeCmd } from './commands/mode'
import { mcpServerCmd, federatedSourceCmd } from './commands/mcp-server'
import { agentCmd } from './commands/agent'
import { socialCmd } from './commands/social'
import { pairCmd } from './commands/pair'
import { licenseCmd } from './commands/license'
import { backupCmd } from './commands/backup'
import { speechCmd } from './commands/speech'
import { routesCmd } from './commands/routes'
import { cliCmd } from './commands/cli'

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
  speech: speechCmd,
  routes: routesCmd,
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
  rules: rulesCmd, jobs: jobsCmd,
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
  // AI 输出回归评测 — `eval run|diff`(设计稿 docs/design/2026-10-29-output-eval.md)。
  eval: evalCmd,
  checkup: checkupCmd,
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

export async function main(argv: string[]) {
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

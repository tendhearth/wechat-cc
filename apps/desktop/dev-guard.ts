/**
 * dev-guard — the dev server's safety valve (spec 2026-07-26 §3).
 *
 * WHY: the dev server forwards `/__invoke` to a REAL `bun cli.ts` on the
 * operator's machine. Many CLI commands mutate that machine — `setup` writes
 * accounts + access.json, `account remove` is an `rmSync(accountDir,
 * {recursive:true})`, `provider set --unattended` rewrites the launchd plist,
 * `service`/`daemon kill*` stop the live bot, `memory write` overwrites real
 * memory files. A same-day incident (memory: test-pollution-real-statedir)
 * showed how badly fixture-grade writes into real state end: the operator was
 * removed from access.json's allowFrom and their bot silently dropped their
 * own WeChat messages.
 *
 * ALLOW-LIST, NOT DENY-LIST. The first cut of this file was a deny-list of six
 * command prefixes; review found it leaked (`account remove`, `provider set`,
 * `avatar set`, `memory write`, `mode set`, `sessions delete`, `observations
 * archive` all walked straight through — every one of them reachable from a
 * single desktop button). A safety valve whose correctness depends on
 * enumerating every dangerous command is wrong by construction: each new CLI
 * subcommand silently defaults to "allowed". So the valve is inverted — only
 * commands known to be read-only run, everything else needs the explicit
 * opt-in. A missing entry now costs a confusing error instead of real damage.
 *
 * NOT gated: ALL daemon HTTP routes. Memory synthesize / profile generate /
 * the whole 觅食台 go through the daemon, never through here, so live-mode
 * debugging of those is unaffected.
 */

/**
 * A read-only command: `path` is matched against the leading positional
 * tokens of the argv. `requireFlag` pins commands that are read-only only in
 * one mode (`update --check` inspects; bare `update` moves the repo).
 */
export type ReadonlyCliCommand = { path: readonly string[]; requireFlag?: string }

/**
 * Read-only CLI commands the desktop actually invokes, plus the handful the
 * CLI exposes for diagnosis. Derived by enumerating every `wechat_cli_json`
 * call site under apps/desktop/src/ (2026-07-26).
 *
 * Deliberately NOT here (they mutate; use --allow-mutations to run them):
 *   setup, setup-poll, account remove, avatar set|remove, memory write,
 *   mode set, observations archive, provider set, sessions delete,
 *   service install|start|stop|restart|uninstall, daemon kill|kill-residual,
 *   guard enable|disable, plugin setup|sync, update (without --check).
 */
export const READONLY_CLI_COMMANDS: readonly ReadonlyCliCommand[] = [
  { path: ['doctor'] },
  { path: ['connection', 'probe'] },
  { path: ['conversations', 'list'] },
  { path: ['dialogue', 'search'] },
  { path: ['dialogue', 'thread-detail'] },
  { path: ['dialogue', 'threads'] },
  { path: ['events', 'list'] },
  { path: ['guard', 'status'] },
  { path: ['install-progress'] },
  { path: ['logs'] },
  { path: ['memory', 'list'] },
  { path: ['memory', 'read'] },
  { path: ['memory', 'profile-read'] },
  { path: ['memory', 'profile', 'status'] },
  { path: ['memory', 'projects'] },
  { path: ['milestones', 'list'] },
  { path: ['observations', 'list'] },
  { path: ['provider', 'show'] },
  { path: ['sessions', 'list-chats'] },
  { path: ['sessions', 'list-projects'] },
  { path: ['sessions', 'read-jsonl'] },
  { path: ['sessions', 'search'] },
  { path: ['avatar', 'info'] },
  // `service status` only reads launchctl — the mutating siblings
  // (install/start/stop/restart/uninstall) are absent on purpose.
  { path: ['service', 'status'] },
  // daemon api-info is how the desktop learns the daemon's port + token.
  { path: ['daemon', 'api-info'] },
  { path: ['update'], requireFlag: '--check' },
]

/**
 * The leading positional tokens of an argv, or null when the argv does not
 * START with a positional.
 *
 * FAIL-CLOSED ON SHAPE. citty resolves a subcommand by skipping leading flags
 * (`findSubCommandIndex`), and a string-typed flag swallows the token after
 * it — so `['--json','service','status']` runs `service status` even though it
 * does not *start* with it. Reproducing that resolution here would mean
 * reproducing every command's arg definitions, and any drift becomes a bypass
 * (review found exactly this: the first cut let `['--json','setup']` through).
 *
 * Instead: an argv with ANY leading flag is not a shape the desktop ever
 * produces (its helpers append flags — see sessions.js `withChat`), so it is
 * simply refused. That removes the whole class without guessing.
 */
export function commandPath(args: string[]): string[] | null {
  const first = args[0]
  if (first === undefined) return null
  if (first.startsWith('-')) return null
  const path: string[] = []
  for (const arg of args) {
    if (arg === '--' || arg.startsWith('-')) break
    path.push(arg)
  }
  return path
}

/** True when argv is a known read-only command (and its required flag is present). */
export function isReadonlyCli(args: string[]): boolean {
  const path = commandPath(args)
  if (path === null) return false
  return READONLY_CLI_COMMANDS.some(cmd => {
    if (cmd.path.length > path.length) return false
    if (!cmd.path.every((seg, i) => path[i] === seg)) return false
    // A required flag may appear anywhere after the command path, in either
    // `--check` or `--check=x` form.
    if (cmd.requireFlag) {
      return args.some(a => a === cmd.requireFlag || a.startsWith(`${cmd.requireFlag}=`))
    }
    return true
  })
}

/**
 * Gate a CLI invocation.
 *
 * Applies in EVERY mode, mock included. DRY_RUN is not a sandbox: test-shim
 * only intercepts an explicit list of commands and everything else falls
 * through to the real `bun cli.ts` against the real state dir — so `bun run
 * dev:mock` + the dashboard's delete button would have removed a real account.
 * The only bypass is the explicit opt-in.
 */
export function guardCliInvoke(
  args: string[],
  opts: { allowMutations: boolean },
): { ok: true } | { ok: false; error: string; hint: string } {
  if (opts.allowMutations) return { ok: true }
  if (isReadonlyCli(args)) return { ok: true }
  const shown = args.slice(0, 2).join(' ') || '(空命令)'
  return {
    ok: false,
    error: 'mutating_command_blocked_in_dev',
    hint: `dev server 默认只跑已知只读的命令(${shown} 不在其中)。需要时加 --allow-mutations 或 WECHAT_CC_DEV_ALLOW_MUTATIONS=1。`,
  }
}

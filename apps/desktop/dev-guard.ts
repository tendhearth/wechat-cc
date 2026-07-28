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
 * A read-only command.
 *
 * `path` matches the leading positional tokens of the argv. `flags` lists the
 * flags this command may carry beyond GLOBAL_SAFE_FLAGS — anything else is
 * refused. `requireFlag` pins commands that are read-only only in one mode
 * (`update --check` inspects; bare `update` moves the repo).
 *
 * WHY FLAGS ARE ALLOW-LISTED TOO (2026-07-27 security review): gating the
 * command path alone is not enough, because a read-only *command* can carry a
 * writing *flag*. Three live bypasses were demonstrated against the
 * path-only version:
 *   - `logs --json --out-file <path>` → cli.ts's emitJson does
 *     `writeFileSync(outFile, …)`, i.e. ARBITRARY FILE OVERWRITE. Pointed at
 *     ~/.claude/channels/wechat/access.json this re-creates the exact incident
 *     this valve exists to prevent. Also on all four `sessions` reads.
 *   - `service status --unattended false --auto-start false` → cli.ts:2086
 *     calls saveAgentConfig BEFORE branching on the action, flipping the
 *     daemon into interactive mode so the bot silently stops replying.
 *   - `update --check=false` / `--check --no-check` → citty parses check as
 *     false, so `applyUpdate()` (git pull + bun install + service restart)
 *     runs behind a flag the valve thought made it read-only.
 * A deny-list of dangerous flags would repeat the mistake that made the
 * command deny-list fail, so unknown flags are simply refused.
 */
export type ReadonlyCliCommand = {
  path: readonly string[]
  flags?: readonly string[]
  requireFlag?: string
}

/** Output-shaping only; safe on every command. */
export const GLOBAL_SAFE_FLAGS: readonly string[] = ['--json']

/**
 * Read-only CLI commands the desktop actually invokes, plus the handful the
 * CLI exposes for diagnosis. Derived by enumerating every `wechat_cli_json`
 * call site under apps/desktop/src/ (2026-07-26), then auditing each one's
 * implementation in cli.ts for write primitives. 23 of the 24 entries touch
 * nothing; the single exception is `connection probe` and it is annotated
 * inline. Re-run that audit before adding an entry — "it sounds like a read"
 * is not evidence.
 *
 * Deliberately NOT here (they mutate; use --allow-mutations to run them):
 *   setup, setup-poll, account remove, avatar set|remove, memory write,
 *   mode set, observations archive, provider set, sessions delete,
 *   service install|start|stop|restart|uninstall, daemon kill|kill-residual,
 *   guard enable|disable, plugin setup|sync, update (without --check).
 */
export const READONLY_CLI_COMMANDS: readonly ReadonlyCliCommand[] = [
  { path: ['doctor'] },
  // DOCUMENTED EXCEPTION — `connection probe` is the one entry here that
  // writes: on errcode -14 it calls sessionState.markExpired(), and on a clean
  // probe it clears that flag (src/daemon/connection-probe.ts:70-80). Kept
  // allowed because the dashboard runs it on every load in the SHIPPED app
  // too, the write only records a verdict the daemon would reach on its own,
  // and it self-heals — the next successful probe clears it. Blocking it would
  // silently break the connection card in dev:web, which is the exact
  // "everything degrades to 未启用" failure this dev server exists to fix.
  { path: ['connection', 'probe'] },
  { path: ['conversations', 'list'] },
  { path: ['dialogue', 'search'], flags: ['--chat-id'] },
  { path: ['dialogue', 'thread-detail'] },
  { path: ['dialogue', 'threads'], flags: ['--chat-id', '--facet', '--include-private'] },
  { path: ['dialogue', 'timeline'], flags: ['--chat-id', '--limit', '--before'] },
  { path: ['dialogue', 'unlock'], flags: ['--passphrase'] },
  { path: ['events', 'list'], flags: ['--limit'] },
  { path: ['guard', 'status'] },
  { path: ['install-progress'] },
  { path: ['logs'], flags: ['--tail'] },
  { path: ['memory', 'list'] },
  { path: ['memory', 'read'] },
  { path: ['memory', 'profile-read'] },
  { path: ['memory', 'profile', 'status'], flags: ['--chat-id'] },
  { path: ['memory', 'projects'] },
  { path: ['milestones', 'list'] },
  { path: ['observations', 'list'] },
  { path: ['plugin', 'list'] },
  { path: ['plugin', 'setup-status'] },
  { path: ['provider', 'show'] },
  // SECOND DOCUMENTED EXCEPTION — `log` appends one structured line to
  // channel.log (src/lib/log.ts: fixed LOG_FILE under STATE_DIR, no
  // caller-controlled path). It is the desktop's own telemetry, and dev:web is
  // the one place anybody reads it, so blocking it would silently discard the
  // reconnect-diagnose trail exactly where it is wanted.
  { path: ['log'], flags: ['--fields'] },
  { path: ['sessions', 'list-chats'], flags: ['--chat'] },
  { path: ['sessions', 'list-projects'], flags: ['--chat'] },
  { path: ['sessions', 'read-jsonl'], flags: ['--chat'] },
  { path: ['sessions', 'search'], flags: ['--chat'] },
  { path: ['avatar', 'info'] },
  // `service status` only reads launchctl. Its mutating siblings
  // (install/start/stop/restart/uninstall) are absent on purpose — and note
  // that no flags are allowed here, because --unattended / --auto-start are
  // persisted by cli.ts BEFORE it looks at which action was requested.
  { path: ['service', 'status'] },
  // daemon api-info is how the desktop learns the daemon's port + token.
  // --operator asks for the route-scoped operator token instead of the
  // daemon-wide one; api.js sends it for /v1/customer-review.
  { path: ['daemon', 'api-info'], flags: ['--operator'] },
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

/** Every flag token in an argv, normalised to its name (`--tail=5` → `--tail`). */
export function flagsIn(args: string[]): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (arg === '--') break
    if (!arg.startsWith('-')) continue
    const eq = arg.indexOf('=')
    out.push(eq === -1 ? arg : arg.slice(0, eq))
  }
  return out
}

/**
 * True when `flag` is present AND not explicitly falsified.
 *
 * citty accepts `--check=false` and `--no-check` for booleans, so mere
 * presence proves nothing — `update --check=false` parses as check:false and
 * runs the real update. (`--no-check` is rejected earlier as an unlisted flag;
 * this handles the `=value` form.)
 */
function flagIsTruthy(args: string[], flag: string): boolean {
  const FALSY = new Set(['', 'false', '0', 'no', 'off'])
  let seen = false
  for (const arg of args) {
    if (arg === '--') break
    if (arg === flag) { seen = true; continue }
    if (arg.startsWith(`${flag}=`)) {
      seen = !FALSY.has(arg.slice(flag.length + 1).toLowerCase())
    }
  }
  return seen
}

/**
 * Why an argv was refused — so the error tells the developer which half
 * failed. "logs is not allowed" would be a lie when the command is fine and
 * only `--out-file` was refused.
 */
type Rejection =
  | { kind: 'bad_shape' }
  | { kind: 'unknown_command'; path: string }
  | { kind: 'flag'; path: string; flag: string }
  | { kind: 'require_flag'; path: string; flag: string }

function classifyCli(args: string[]): { ok: true } | { ok: false; why: Rejection } {
  const path = commandPath(args)
  if (path === null) return { ok: false, why: { kind: 'bad_shape' } }

  let best: Rejection | null = null
  for (const cmd of READONLY_CLI_COMMANDS) {
    if (cmd.path.length > path.length) continue
    if (!cmd.path.every((seg, i) => path[i] === seg)) continue
    const shown = cmd.path.join(' ')
    // Every flag must be explicitly permitted. A flag the CLI does not define
    // is harmless (citty ignores it), but refusing it costs nothing and keeps
    // this check free of assumptions about which flags exist.
    const permitted = new Set([
      ...GLOBAL_SAFE_FLAGS,
      ...(cmd.flags ?? []),
      ...(cmd.requireFlag ? [cmd.requireFlag] : []),
    ])
    const bad = flagsIn(args).find(f => !permitted.has(f))
    if (bad !== undefined) { best ??= { kind: 'flag', path: shown, flag: bad }; continue }
    if (cmd.requireFlag && !flagIsTruthy(args, cmd.requireFlag)) {
      best ??= { kind: 'require_flag', path: shown, flag: cmd.requireFlag }
      continue
    }
    return { ok: true }
  }
  return { ok: false, why: best ?? { kind: 'unknown_command', path: path.slice(0, 2).join(' ') } }
}

/** True when argv is a known read-only command carrying only permitted flags. */
export function isReadonlyCli(args: string[]): boolean {
  return classifyCli(args).ok
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
  const verdict = classifyCli(args)
  if (verdict.ok) return { ok: true }
  const escape = '需要时加 --allow-mutations 或 WECHAT_CC_DEV_ALLOW_MUTATIONS=1。'
  const why = verdict.why
  const detail
    = why.kind === 'bad_shape'
      ? 'argv 必须以子命令开头(前导 flag 会让 citty 解析出别的命令,一律拒绝)。'
      : why.kind === 'flag'
        ? `${why.path} 是只读命令,但 ${why.flag} 不在它的放行 flag 里(该 flag 可能让它写入)。`
        : why.kind === 'require_flag'
          ? `${why.path} 只有带上生效的 ${why.flag} 才算只读。`
          : `${why.path || '(空命令)'} 不在已知只读命令里。`
  return {
    ok: false,
    error: 'mutating_command_blocked_in_dev',
    hint: `dev server 默认只跑已知只读的命令 —— ${detail}${escape}`,
  }
}

/**
 * dev-guard — the dev server's safety valve (spec 2026-07-26 §3).
 *
 * WHY: in live mode the dev server forwards `/__invoke` to a REAL
 * `bun cli.ts`. Some CLI commands mutate the operator's real machine —
 * `setup`/`setup-poll` write accounts + access.json, `service` hits
 * launchctl, `daemon kill*` stops the live bot, `update` moves the repo.
 * A same-day incident (memory: test-pollution-real-statedir) showed how
 * badly fixture-grade writes into real state end: the operator was removed
 * from access.json's allowFrom and their bot silently dropped their own
 * WeChat messages. So live mode refuses these by default.
 *
 * NOT gated: every read-ish CLI command, and ALL daemon HTTP routes (memory
 * synthesize / profile generate go through the daemon, never through here).
 */

/** Deny list as子命令前缀 — matched positionally against the CLI argv. */
export const MUTATING_CLI_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ['setup'],
  ['setup-poll'],
  ['service'],
  ['daemon', 'kill'],
  ['daemon', 'kill-residual'],
  ['update'],
]

/** True when argv starts with any deny-listed prefix. */
export function isMutatingCli(args: string[]): boolean {
  return MUTATING_CLI_COMMANDS.some(prefix => prefix.every((seg, i) => args[i] === seg))
}

export function guardCliInvoke(
  args: string[],
  opts: { dryRun: boolean; allowMutations: boolean },
): { ok: true } | { ok: false; error: string; hint: string } {
  // mock 模式不碰真实状态;显式开关放行。
  if (opts.dryRun || opts.allowMutations) return { ok: true }
  if (!isMutatingCli(args)) return { ok: true }
  return {
    ok: false,
    error: 'mutating_command_blocked_in_dev',
    hint: `dev server live 模式默认不跑会改真实状态的命令(${args.slice(0, 2).join(' ')})。需要时加 --allow-mutations 或 WECHAT_CC_DEV_ALLOW_MUTATIONS=1。`,
  }
}

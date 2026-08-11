/**
 * wire-self-restart.ts — self-restart (spec 2026-08-03-daemon-self-restart-
 * on-stale-code) assembly, extracted from bootstrap/index.ts (Task 6: repo
 * convention is new wiring lands in wire-*.ts, not index.ts).
 *
 * See src/daemon/self-restart/wire.ts's file-header comment for the full
 * rationale AND the KeepAlive=true precondition this whole mechanism
 * depends on (a dictionary-form KeepAlive would make this shut the bot down
 * instead of restarting it). Entirely inert when deps.requestRestart is
 * omitted: no HEAD read, no activity marker built, no check returned — the
 * `null` return lets bootstrap/index.ts skip adding anything to the
 * idle-sweep tick. Tests and minimal embeddings that don't wire
 * requestRestart stay byte-identical to before this feature existed.
 *
 * Pure move from bootstrap/index.ts — the logic inside is unchanged, only
 * parameterized (repoRootForGitHead moved here too, since it exists only
 * to serve this block).
 */
import { makeActivityMarker } from '../self-restart/activity-marker'
import { makeSelfRestartCheck } from '../self-restart/wire'
import { readGitHead, readGitLockfileBlob } from '../self-restart/git-head'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repo root for self-restart's `git rev-parse HEAD` reads — resolved via
 * import.meta.url (same posture as bootstrap/index.ts's resolveClaudeBinary),
 * NOT process.cwd(), because a launchd-started daemon's cwd is unrelated to
 * the checkout it was launched from. In a compiled binary this path has no
 * `.git` — readGitHead already returns null on that failure, which is
 * exactly the intended "don't self-restart" outcome there.
 */
function repoRootForGitHead(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/daemon/bootstrap/wire-self-restart.ts → repo root
  return join(here, '..', '..', '..')
}

export interface WireSelfRestartDeps {
  /**
   * Graceful-shutdown-then-exit(0) closure. Optional and deliberately so:
   * absent ⇒ wireSelfRestart returns null and the mechanism is fully
   * inert (see file header).
   */
  requestRestart?: () => void
  /** SessionManager's own in-flight probe — the pre-existing idle signal. */
  anyInFlight: () => boolean
  /**
   * Busy-registry read (spec 2026-08-11 §1) — the second in-flight signal,
   * covering long tasks that don't go through SessionManager at all.
   */
  busy: () => boolean
  /**
   * Poll-freshness read (spec 2026-08-11 §4) — null ⇒ can't prove the
   * wechat connection is alive right now ⇒ makeSelfRestartCheck treats
   * that as "don't restart" (failure-direction-safe).
   */
  lastPollSuccessAgoMs: (nowMs: number) => number | null
  log: (tag: string, line: string) => void
  now?: () => number
  /**
   * Injection seams for the two boot-time git reads — same shape/posture as
   * `SelfRestartDeps.readHead`/`readLockBlob` in `../self-restart/wire.ts`
   * (default to the real implementation; tests override to avoid depending
   * on a git checkout being present/deterministic). Not used by production
   * wiring (bootstrap/index.ts never overrides these — the real git reads
   * are exactly what the mechanism needs there).
   */
  readHead?: typeof readGitHead
  readLockBlob?: typeof readGitLockfileBlob
}

export interface WireSelfRestartResult {
  check: () => Promise<void>
  marker: ReturnType<typeof makeActivityMarker>
}

export async function wireSelfRestart(deps: WireSelfRestartDeps): Promise<WireSelfRestartResult | null> {
  if (!deps.requestRestart) return null
  const now = deps.now ?? Date.now
  const readHead = deps.readHead ?? readGitHead
  const readLockBlob = deps.readLockBlob ?? readGitLockfileBlob
  const cwd = repoRootForGitHead()
  const bootAtMs = now()
  // readGitHead never throws and returns null on any failure (not a repo,
  // git missing, timeout) — a null loadedHead makes shouldSelfRestart
  // return false forever, which is the correct "don't move" outcome for
  // compiled binaries / non-git checkouts.
  const loadedHead = await readHead({ cwd })
  // bun.lock's blob at boot (Task 3 review #2) — the check refuses to
  // restart if this drifts, so a manual `git pull` that changed the
  // dependency tree can't restart us into a node_modules that
  // `bun install` hasn't caught up with yet. Skipped entirely when
  // loadedHead is already null: the check returns before ever reading
  // it, so there's no reason to pay for a second git spawn at boot.
  const bootLockBlob = loadedHead === null ? null : await readLockBlob({ cwd })
  const marker = makeActivityMarker({ now })
  const requestRestart = deps.requestRestart
  const check = makeSelfRestartCheck({
    cwd,
    loadedHead,
    bootLockBlob,
    now,
    bootAtMs,
    anyInFlight: () => deps.anyInFlight(),
    quietFor: (nowMs) => marker.quietFor(nowMs),
    requestRestart,
    log: deps.log,
    busy: deps.busy,
    lastPollSuccessAgoMs: deps.lastPollSuccessAgoMs,
  })
  return { check, marker }
}

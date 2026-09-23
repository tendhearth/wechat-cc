/**
 * selftest — daemon-side "test conversation" runner backing
 * POST /v1/selftest/converse (spec 2026-09-18-self-maintenance §1).
 *
 * Spawns ONE real session against a registered provider in a scratch
 * project (never the owner's own chat/project), mints a session token
 * scoped to `GET /v1/health` only (the wechat MCP inside that session can
 * ping, never send), drains one turn, and tears the session down. Used by
 * `wechat-cc selftest chat` (CLI, separate task) and, indirectly, by any
 * LLM maintainer driving the "改 → 部署 → 验" loop described in the spec.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTurn } from '../core/agent-provider'
import type { ProviderRegistry } from '../core/provider-registry'
import { TIER_PROFILES, sessionAuthEnv, type UserTier } from '../core/user-tier'

export interface SelftestConverseResult {
  ok: boolean
  providerId: string
  sessionId: string | null
  texts: string[]
  toolCalls: string[]
  error?: string
  errorCode?: string
  durationMs: number
}

export interface SelftestConverseDeps {
  registry: Pick<ProviderRegistry, 'get'>
  mintSessionToken: (tier: UserTier, key: string, opts?: { routeAllow?: ReadonlySet<string>; ttlMs?: number }) => string
  invalidateSession: (key: string) => void
  log: (tag: string, line: string) => void
  now?: () => number
}

/** Mirrors the daemon-wide "no reply for a while" turn watchdog default. */
const DEFAULT_TIMEOUT_MS = 120_000
/** `session.close()` is raced against this — a wedged provider close must
 *  never make the selftest route itself hang. */
const CLOSE_TIMEOUT_MS = 3_000
/** The minted session token outlives one turn only. A selftest turn that
 *  wedges must not leave a live (if narrowly scoped) credential in the
 *  registry forever — `invalidateSession` in the finally block is the
 *  primary revoke, this is the backstop for the paths that never reach it
 *  (process dies mid-turn). */
const TOKEN_TTL_MS = 10 * 60_000
/** Scratch project — never the owner's own chat/project, and deliberately
 *  NOT under STATE_DIR: a real provider runs in here with
 *  `permissionMode:'dangerously'`, and STATE_DIR holds the daemon's tokens
 *  and account files. */
const SELFTEST_PROJECT_PATH = join(tmpdir(), 'wechat-cc-selftest', 'project')

export async function runSelftestConverse(
  deps: SelftestConverseDeps,
  input: { providerId: string; text: string; resumeSessionId?: string; timeoutMs?: number },
): Promise<SelftestConverseResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()

  const entry = deps.registry.get(input.providerId)
  if (!entry) {
    return {
      ok: false,
      providerId: input.providerId,
      sessionId: null,
      texts: [],
      toolCalls: [],
      error: 'unavailable_provider',
      durationMs: now() - startedAt,
    }
  }

  // Created once and reused across runs (mkdir is a no-op if it already
  // exists); the README is written only the first time so re-runs don't
  // clobber anything a maintainer might have poked at inside it.
  const projectPath = SELFTEST_PROJECT_PATH
  mkdirSync(projectPath, { recursive: true })
  const readmePath = join(projectPath, 'README.md')
  if (!existsSync(readmePath)) writeFileSync(readmePath, 'selftest scratch project\n')

  // `provider/alias/chatId` — the three-part shape internal-api's
  // callerChatId derivation expects (`sessionKey.split('/').slice(2)`).
  // The old two-part key made callerChatId an empty string, i.e. a session
  // whose own identity no route could read back.
  const sessionKey = `selftest/selftest/${randomUUID()}`
  const token = deps.mintSessionToken('trusted', sessionKey, {
    routeAllow: new Set(['GET /v1/health']),
    ttlMs: TOKEN_TTL_MS,
  })

  // Everything from the spawn on runs inside try/finally: a provider that
  // throws on spawn (binary missing, auth expired) or a turn that throws
  // used to escape this function, leaving the minted token live in the
  // registry and — if spawn had succeeded — a subprocess with no one left
  // holding its handle. Teardown belongs in `finally`, and the route's
  // contract is a RESULT (`ok:false`), never an exception.
  let session: Awaited<ReturnType<typeof entry.provider.spawn>> | undefined
  try {
    session = await entry.provider.spawn(
      { alias: 'selftest', path: projectPath },
      {
        tierProfile: TIER_PROFILES.trusted,
        permissionMode: 'dangerously',
        chatId: sessionKey,
        mcpEnv: sessionAuthEnv('trusted', token),
        appendInstructions: '这是一次自检对话。回答要短。',
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      },
    )

    const summary = await collectTurn(session.dispatch(input.text), {
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    return {
      ok: !summary.error,
      providerId: input.providerId,
      sessionId: summary.result?.sessionId ?? null,
      texts: summary.assistantText,
      toolCalls: summary.toolCalls,
      ...(summary.error !== undefined ? { error: summary.error } : {}),
      ...(summary.errorCode !== undefined ? { errorCode: summary.errorCode } : {}),
      durationMs: now() - startedAt,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.log('SELFTEST', `converse failed for ${sessionKey}: ${message}`)
    return {
      ok: false,
      providerId: input.providerId,
      sessionId: null,
      texts: [],
      toolCalls: [],
      error: message,
      durationMs: now() - startedAt,
    }
  } finally {
    // Best-effort teardown — a wedged/throwing close must not fail the
    // whole selftest call (the turn already ran; that's the result that
    // matters).
    if (session) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          session.close(),
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error('close timed out')), CLOSE_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        deps.log('SELFTEST', `session.close failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (closeTimer) clearTimeout(closeTimer)
      }
    }
    deps.invalidateSession(sessionKey)
  }
}

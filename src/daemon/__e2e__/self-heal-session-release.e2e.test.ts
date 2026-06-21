// End-to-end acceptance test for the self-heal "release a wedged session"
// remediation (POST /v1/sessions/release).
//
// The loop: an admin sees a stuck chat, the bot curls the release route, the
// live session is dropped, and the NEXT message in that chat spawns fresh.
// Unit tests cover the route's honest `released` flag in isolation; this
// proves the whole chain against a real daemon — a live session actually
// appears in GET /v1/sessions, the release drops it from the manager, and a
// repeat release is a truthful no-op (released:false), so the agent's
// self-heal verification reflects reality.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

function readBaseUrl(stateDir: string): string {
  return (JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string }).baseUrl
}

function tokenOf(opts: Record<string, unknown>): string | undefined {
  const mcp = opts.mcpServers as Record<string, { env?: Record<string, string> }> | undefined
  return mcp?.wechat?.env?.WECHAT_SESSION_TOKEN
}

interface SessionEntry { alias: string; providerId: string; chatId: string }

async function pollUntil<T>(fn: () => Promise<T | undefined> | (T | undefined), timeoutMs = 8000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== undefined) return v
    await new Promise(r => setTimeout(r, 25))
  }
  return undefined
}

describe('e2e: POST /v1/sessions/release drops a live session (self-heal)', () => {
  it('lists a live session, releases it, and a repeat release is an honest no-op', async () => {
    const spawns: Record<string, unknown>[] = []
    const daemon = await startTestDaemon({
      access: { allowFrom: ['*'], admins: ['admin1'] },
      knownUsers: { admin1: 'u1' },
      agentConfig: { provider: 'claude', model: 'claude-opus-4-8' },
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
      recordClaudeSpawnOptions: o => { spawns.push(o) },
    })
    try {
      const baseUrl = readBaseUrl(daemon.stateDir)

      // Drive the admin chat → a session spawns; recover its admin-tier token.
      daemon.sendText('admin1', 'hi')
      const spawn = await pollUntil(() => (spawns.length >= 1 ? spawns[0] : undefined))
      const adminToken = tokenOf(spawn!)
      expect(adminToken, 'spawn must carry an admin session token').toBeTruthy()
      const authed = (init: RequestInit = {}) => ({
        ...init,
        headers: { authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) },
      })

      // The session shows up live in GET /v1/sessions (admin route).
      const entry = await pollUntil(async () => {
        const res = await fetch(`${baseUrl}/v1/sessions`, authed())
        if (res.status !== 200) return undefined
        const { sessions } = (await res.json()) as { sessions: SessionEntry[] }
        return sessions.find(s => s.chatId === 'admin1')
      })
      expect(entry, 'admin1 should have a live session listed').toBeTruthy()

      const releaseBody = (chatId: string) => authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: entry!.alias, providerId: entry!.providerId, chatId }),
      })

      // Releasing a key with no live session is an honest no-op (released:false).
      // Do this BEFORE the real release — it doesn't touch admin1's token, which
      // we still need as the caller credential.
      const noopRes = await fetch(`${baseUrl}/v1/sessions/release`, releaseBody('ghost-chat'))
      expect(noopRes.status).toBe(200)
      expect(((await noopRes.json()) as { released: boolean }).released, 'no-op release reports released:false').toBe(false)

      // Release the live session — released:true and the read-back list no
      // longer contains the chat.
      const relRes = await fetch(`${baseUrl}/v1/sessions/release`, releaseBody('admin1'))
      expect(relRes.status).toBe(200)
      const relBody = (await relRes.json()) as { ok: boolean; released: boolean; sessions: SessionEntry[] | null }
      expect(relBody.ok).toBe(true)
      expect(relBody.released, 'releasing a live session reports released:true').toBe(true)
      expect(relBody.sessions?.some(s => s.chatId === 'admin1'), 'released session is gone from the list').toBe(false)

      // Security property, end-to-end: releasing a session REVOKES its per-session
      // token (the eviction-leak fix). The caller token belonged to admin1's
      // session, so it no longer resolves — a follow-up call is 401, not a
      // stale-token replay.
      const afterRevoke = await fetch(`${baseUrl}/v1/sessions`, authed())
      expect(afterRevoke.status, 'token is revoked once its session is released').toBe(401)
    } finally {
      await daemon.stop()
    }
  })
})

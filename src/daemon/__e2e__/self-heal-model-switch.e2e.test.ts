// End-to-end acceptance test for the self-heal "switch my model" remediation.
//
// The AI-native-self-healing story: an admin tells the bot to change its
// model, the bot curls POST /v1/model, and the change takes effect on the
// NEXT session spawn — no daemon restart. That hinges on the mtime+size
// cached config reader (bootstrap's currentClaudeModel) re-reading agent-
// config.json after the route rewrites it. Unit tests cover the reader and
// the route in isolation; only an e2e proves the whole loop end-to-end:
//   admin token → POST /v1/model → file rewrite → cache invalidation →
//   next spawn's SDK options carry the new model.
//
// It also exercises the authz path for real — the POST is an admin-min route,
// driven with an admin-tier token recovered from a live spawn's MCP env.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

function readBaseUrl(stateDir: string): string {
  return (JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string }).baseUrl
}

/** Token the daemon baked into a spawn's wechat MCP child env. */
function tokenOf(opts: Record<string, unknown>): string | undefined {
  const mcp = opts.mcpServers as Record<string, { env?: Record<string, string> }> | undefined
  return mcp?.wechat?.env?.WECHAT_SESSION_TOKEN
}

const modelOf = (opts: Record<string, unknown>): string | undefined =>
  typeof opts.model === 'string' ? opts.model : undefined

async function pollUntil<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise(r => setTimeout(r, 25))
  }
  return undefined
}

describe('e2e: POST /v1/model takes effect on the next spawn (self-heal, no restart)', () => {
  it('an admin switches the model and a later chat spawns with the new one', async () => {
    const spawns: Record<string, unknown>[] = []
    const daemon = await startTestDaemon({
      // Two admin chats so the second cold-starts AFTER the switch — reusing
      // the first chat's live session would keep its original model (in-flight
      // sessions are pinned until released).
      access: { allowFrom: ['*'], admins: ['admin1', 'admin2'] },
      knownUsers: { admin1: 'u1', admin2: 'u2' },
      agentConfig: { provider: 'claude', model: 'claude-opus-4-8' },
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
      recordClaudeSpawnOptions: o => { spawns.push(o) },
    })
    try {
      const baseUrl = readBaseUrl(daemon.stateDir)

      // 1. First admin chat spawns under the seeded model — capture its
      //    admin-tier token (for the POST) and confirm the starting model.
      daemon.sendText('admin1', 'hi')
      const first = await pollUntil(() => (spawns.length >= 1 ? spawns[0] : undefined))
      expect(first, 'first admin chat should spawn a session').toBeTruthy()
      expect(modelOf(first!)).toBe('claude-opus-4-8')
      const adminToken = tokenOf(first!)
      expect(adminToken, 'spawn must carry an admin session token').toBeTruthy()

      // 2. Admin curls the remediation route to switch the pinned model.
      const res = await fetch(`${baseUrl}/v1/model`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      })
      expect(res.status).toBe(200)
      // 只钉这条用例关心的键,不做全等(这条路由每加一个读回字段就会
      // 在 e2e 里红一次,却并不能多守住什么)。`forgotten` 不钉在这 ——
      // routes-daemon-control.test.ts 单测已经钉住它的取值(那边
      // listSessions 是打桩的)。`released` 单独加进来钉:那边的单测
      // 打桩 listSessions,给不出对着一个活会话的真实计数;这条 e2e
      // 是唯一一处 admin1 真的先 spawn 了一个活 session、再打
      // POST /v1/model,所以 released 应该是 1 —— 这是本用例才能守住
      // 的东西(2026-09-09「模型与后端统一管理」给这条路由加的读回计数:
      // 放掉该 provider 的活 session + 删掉 sessions 存档行,否则"换了
      // 模型"在续接的对话上是空操作)。
      expect(await res.json()).toMatchObject({ ok: true, provider: 'claude', model: 'claude-sonnet-4-6', released: 1 })

      // 3. A DIFFERENT chat dispatches → cold spawn → its SDK options must
      //    carry the NEW model, proving the cached reader saw the file rewrite
      //    live (no restart between the switch and this spawn).
      daemon.sendText('admin2', 'hi')
      const second = await pollUntil(() => (spawns.length >= 2 ? spawns[1] : undefined))
      expect(second, 'second admin chat should spawn a session').toBeTruthy()
      expect(modelOf(second!)).toBe('claude-sonnet-4-6')
    } finally {
      await daemon.stop()
    }
  })
})

// src/daemon/__e2e__/degraded-boot.e2e.test.ts
// 可选子系统(a2a-server)启动失败 ⇒ daemon 照常服务(spec 2026-08-17):
// 核心收发不受影响、/v1/health 报 degraded、管理员收到一条汇总、shutdown 干净。
// 故障注入是真实的 EADDRINUSE:先占端口,再让 a2a_listen 指向它。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTestDaemon } from './harness'

describe('e2e: degraded boot — optional subsystem failure does not take the bot down', () => {
  it('a2a EADDRINUSE ⇒ boot ok, replies flow, health reports degraded, admin notified', async () => {
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('occupied') })
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-degraded-'))
    mkdirSync(join(stateDir, 'accounts'), { recursive: true })
    // a2a_listen 指向已被占用的端口 — harness 只在 opts.agentConfig 给出时写
    // agent-config.json,这里预写的文件在 stateDirOverride 模式下原样生效。
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({
      provider: 'claude',
      a2a_listen: { host: '127.0.0.1', port: blocker.port },
    }, null, 2))
    // testadmin needs a captured ilink context_token BEFORE boot — the
    // degraded-summary send fires during boot itself (main.ts, before any
    // inbound from testadmin), and assertChatRoutable() requires one. A
    // real admin always has one (they've talked to the bot before); this
    // mirrors that established-chat state — same posture as the harness's
    // own knownUsers pre-population of user_names.json/user_account_ids.json.
    writeFileSync(join(stateDir, 'context_tokens.json'), JSON.stringify({ testadmin: 'ctx-testadmin' }))
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | null = null
    try {
      // 1. boot 正常 resolve — 改动前这里直接 throw EADDRINUSE。
      daemon = await startTestDaemon({
        stateDirOverride: stateDir,
        knownUsers: { chat1: 'testuser', testadmin: 'admin_user' },
        claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'hello back' } } },
      })

      // 2. 核心收发完好。
      daemon.sendText('chat1', 'hi')
      const replies = await daemon.waitForReplyTo('chat1')
      expect(replies.some(m => m.text?.includes('hello back'))).toBe(true)

      // 3. /v1/health 报 a2a-server degraded。
      const info = JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string; tokenFilePath: string }
      const token = readFileSync(info.tokenFilePath, 'utf8').trim()
      const health = await fetch(`${info.baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token}` } })
      expect(health.status).toBe(200)
      const body = await health.json() as { subsystems: Array<{ name: string; state: string; error?: string }> }
      const a2a = body.subsystems.find(s => s.name === 'a2a-server')
      expect(a2a?.state).toBe('degraded')
      expect(a2a?.error).toBeTruthy()

      // 4. 管理员收到一条降级汇总。
      const outbound = await daemon.waitForOutbound(msgs =>
        msgs.some(m => m.chatId === 'testadmin' && !!m.text?.includes('a2a-server')))
      const summary = outbound.find(m => m.chatId === 'testadmin' && m.text?.includes('a2a-server'))
      expect(summary?.text).toContain('⚠️ 本次启动有')
    } finally {
      // 5. shutdown 干净(降级子系统未注册 lifecycle,stop 不报错)。
      await daemon?.stop()
      blocker.stop(true)
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 30_000)
})

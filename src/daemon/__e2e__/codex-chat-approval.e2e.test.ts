// 「Codex 对话逐条问」(主人 2026-10-26 点头):主人自己的对话(admin、strict)里 codex app-server 跑 on-request,
// 它报上来要批的命令经 authorize → 放行规则 / 微信拍板卡(和 Claude 对话同一张卡、同一个待批登记处)。
//
// 整条链真跑:inbound → 协调器 → codex-chat-provider(审批 on-request)→ 剧本 app-server 发 commandExecution 审批请求 →
// codex-chat-gate → authorizeChatCall → permission-gate(读 stateDir 的 permission-rules.json、红线)→ 放 / 卡片 →
// 主人拍板 → 应答回到 app-server。四种:规则放(回复多一行)、主人同意、主人拒绝、红线照旧问。
//
// 主人拍板走的是卡片登记进的同一个待批登记处,从桌面那条口子答(POST /v1/permissions/resolve,桌宠的权限卡就用它):
// 微信里回「y」要等 poll loop 读到,而 poll loop 在这一轮跑完之前不再取消息(onInbound 整轮内联,poll-loop.ts)——
// 同一个对话里卡着等主人回话,微信那条读不到;Claude 对话的拍板卡是同一个处境(见 PR 说明)。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'
import type { OutboundMsg } from './fake-ilink-server'

/** 桌面那条口子:桌宠从 GET /v1/companion/pet 读待批(文件令牌),按 hash 走 POST /v1/permissions/resolve(operator 令牌),和桌面同一套。 */
async function resolvePending(stateDir: string, decision: 'allow' | 'deny'): Promise<void> {
  const info = JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string; tokenFilePath: string; operatorTokenFilePath: string }
  const bearer = (file: string) => ({ authorization: `Bearer ${readFileSync(file, 'utf8').trim()}` })
  const auth = bearer(info.operatorTokenFilePath)
  const pet = await (await fetch(`${info.baseUrl}/v1/companion/pet`, { headers: bearer(info.tokenFilePath) })).json() as { pending_permissions?: Array<{ hash: string; prompt: string }> }
  const card = pet.pending_permissions?.find(i => i.prompt.includes('Codex 想'))
  expect(card, JSON.stringify(pet).slice(0, 500)).toBeTruthy()
  const r = await fetch(`${info.baseUrl}/v1/permissions/resolve`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ hash: card!.hash, decision }) })
  expect(await r.json()).toEqual({ ok: true })
}

const RULES = JSON.stringify({
  version: 1, enabled: true, review: 'off', starter: 1,
  rules: [
    { id: 'ls', when: { command: '^ls$' }, then: 'allow', note: '列目录不用问' },
    // 什么命令都放的规则:红线(推送)照旧问主人。
    { id: 'all', when: { surface: 'chat', command: '^git ' }, then: 'allow', note: 'git 随便跑' },
  ],
})

const approval = (command: string, onDecision: (d: unknown) => void) => ({
  request: { method: 'item/commandExecution/requestApproval', params: { itemId: `c-${command}`, command, cwd: '/tmp', availableDecisions: ['accept', 'decline'] } },
  onResponse: (r: { result?: unknown }) => onDecision((r.result as { decision?: unknown } | undefined)?.decision),
})

async function withDaemon(command: string, finalText: string, run: (d: Awaited<ReturnType<typeof startTestDaemon>>, decision: () => unknown) => Promise<void>) {
  let decision: unknown
  const daemon = await startTestDaemon({
    dangerously: false,
    access: { admins: ['chat1'] },
    // 桌宠只列主人自己那条对话的待批(wire-pet-turn.ts 按 companion 的 default_chat_id 过滤)。
    companion: { default_chat_id: 'chat1' },
    modes: { chat1: { kind: 'solo', provider: 'codex' } },
    seedFiles: { 'permission-rules.json': RULES },
    claudeScript: { async onDispatch() { return { toolCalls: [], finalText: '' } } },
    codexScript: {
      async onDispatch() {
        return { toolCalls: [], finalText, codexSteps: [approval(command, d => { decision = d })] }
      },
    },
  })
  try { await run(daemon, () => decision) } finally { await daemon.stop() }
}

const texts = (msgs: readonly OutboundMsg[], chatId = 'chat1') => msgs.filter(m => m.chatId === chatId && m.endpoint === 'sendmessage').map(m => m.text ?? '')
const isCard = (t: string) => t.includes('Codex 想执行命令')

describe('e2e: Codex 对话逐条问(on-request → authorize → 规则 / 拍板卡)', () => {
  it('规则放:不弹卡,命令照跑,回复后面单独一行「按规则「…」放行了 …」', async () => {
    await withDaemon('ls', '列好了。', async (daemon, decision) => {
      daemon.sendText('chat1', '列一下目录')
      const out = await daemon.waitForOutbound(m => texts(m).some(t => t.includes('按规则')), 10_000)
      expect(decision()).toBe('accept')
      expect(texts(out).some(t => t.includes('列好了。'))).toBe(true)
      expect(texts(out).find(t => t.includes('按规则'))).toBe('按规则「列目录不用问」放行了 ls')
      expect(texts(out).some(isCard)).toBe(false)
    })
  })

  it('主人同意:拍板卡发到主人微信,主人点同意 ⇒ codex 收到 accept', async () => {
    await withDaemon('rm -rf build', '删好了。', async (daemon, decision) => {
      daemon.sendText('chat1', '把 build 删了')
      const card = await daemon.waitForOutbound(m => texts(m).some(isCard), 10_000)
      expect(texts(card).find(isCard)).toContain('rm -rf build')
      expect(decision()).toBeUndefined()
      await resolvePending(daemon.stateDir, 'allow')
      await daemon.waitForOutbound(m => texts(m).some(t => t.includes('删好了。')), 10_000)
      expect(decision()).toBe('accept')
      expect(texts(daemon.ilink.outbox()).some(t => t.includes('按规则'))).toBe(false)
    })
  })

  it('主人拒绝 ⇒ codex 收到 decline,这一轮照常收尾', async () => {
    await withDaemon('rm -rf build', '没删,被拒了。', async (daemon, decision) => {
      daemon.sendText('chat1', '把 build 删了')
      await daemon.waitForOutbound(m => texts(m).some(isCard), 10_000)
      await resolvePending(daemon.stateDir, 'deny')
      await daemon.waitForOutbound(m => texts(m).some(t => t.includes('没删,被拒了。')), 10_000)
      expect(decision()).toBe('decline')
    })
  })

  it('红线照旧问:有规则说放 git,推送还是弹卡问主人,不出「按规则」那一行', async () => {
    await withDaemon('git push origin main', '推上去了。', async (daemon, decision) => {
      daemon.sendText('chat1', '推一下')
      const card = await daemon.waitForOutbound(m => texts(m).some(isCard), 10_000)
      expect(texts(card).find(isCard)).toContain('git push origin main')
      await resolvePending(daemon.stateDir, 'allow')
      await daemon.waitForOutbound(m => texts(m).some(t => t.includes('推上去了。')), 10_000)
      expect(decision()).toBe('accept')
      expect(texts(daemon.ilink.outbox()).some(t => t.includes('按规则'))).toBe(false)
    })
  })
})

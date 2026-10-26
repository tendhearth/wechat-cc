// 「Codex 对话逐条问」(主人 2026-10-26 点头):主人自己的对话(admin、strict)里 codex app-server 跑 on-request,
// 它报上来要批的命令经 authorize → 放行规则 / 微信拍板卡(和 Claude 对话同一张卡、同一个待批登记处)。
//
// 整条链真跑:inbound → 协调器 → codex-chat-provider(审批 on-request)→ 剧本 app-server 发 commandExecution 审批请求 →
// codex-chat-gate → authorizeChatCall → permission-gate(读 stateDir 的 permission-rules.json、红线)→ 放 / 卡片 →
// 主人拍板 → 应答回到 app-server。规则放(回复多一行)、改文件直接放、主人同意、主人拒绝、红线照旧问。
//
// 主人在**同一个微信对话**里回「y」/「n」:这一轮正卡在等它,poll loop 的快车道(poll-loop.ts 的 fastLane)当场处理这句,
// 不排在这一轮后面。红线那条从桌面那条口子答(POST /v1/permissions/resolve,桌宠的权限卡),两条路都钉住。
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

const fileApproval = (path: string, onDecision: (d: unknown) => void) => [
  { notify: { method: 'item/started', params: { item: { id: 'f1', type: 'fileChange', status: 'inProgress', changes: [{ path, kind: { type: 'add' }, diff: '+hello' }] } } } },
  { request: { method: 'item/fileChange/requestApproval', params: { itemId: 'f1' } }, onResponse: (r: { result?: unknown }) => onDecision((r.result as { decision?: unknown } | undefined)?.decision) },
]

async function withDaemon(command: string | { file: string }, finalText: string, run: (d: Awaited<ReturnType<typeof startTestDaemon>>, decision: () => unknown) => Promise<void>) {
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
        const record = (d: unknown) => { decision = d }
        return { toolCalls: [], finalText, codexSteps: typeof command === 'string' ? [approval(command, record)] : fileApproval(command.file, record) }
      },
    },
  })
  try { await run(daemon, () => decision) } finally { await daemon.stop() }
}

const texts = (msgs: readonly OutboundMsg[], chatId = 'chat1') => msgs.filter(m => m.chatId === chatId && m.endpoint === 'sendmessage').map(m => m.text ?? '')
const isCard = (t: string) => t.includes('Codex 想执行命令')

// 60s:每个用例都冷启动一个 daemon,第一个还要冷 import 整个 daemon;满载下超过全局的 30s,超时的用例的 daemon 还在跑,
// 会和下一个用例的 daemon 抢同一份进程级状态(STATE_DIR、假 SDK 的剧本),连环红。
describe('e2e: Codex 对话逐条问(on-request → authorize → 规则 / 拍板卡)', { timeout: 60_000 }, () => {
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

  it('改文件:和 Claude 对话里同一次写同一个结论 —— admin 档直接放,不弹卡、不出「按规则」那一行', async () => {
    await withDaemon({ file: '/tmp/codex-e2e-note.txt' }, '写好了。', async (daemon, decision) => {
      daemon.sendText('chat1', '写个文件')
      const out = await daemon.waitForOutbound(m => texts(m).some(t => t.includes('写好了。')), 10_000)
      expect(decision()).toBe('accept')
      expect(texts(out).some(isCard)).toBe(false)
      expect(texts(out).some(t => t.includes('Codex 想改文件'))).toBe(false)
      expect(texts(out).some(t => t.includes('按规则'))).toBe(false)
    })
  })

  it('主人同意:拍板卡发到主人微信,主人在同一个对话里回「y」⇒ 当场生效,codex 收到 accept', async () => {
    await withDaemon('rm -rf build', '删好了。', async (daemon, decision) => {
      daemon.sendText('chat1', '把 build 删了')
      const card = await daemon.waitForOutbound(m => texts(m).some(isCard), 10_000)
      expect(texts(card).find(isCard)).toContain('rm -rf build')
      expect(decision()).toBeUndefined()
      daemon.sendText('chat1', 'y')
      await daemon.waitForOutbound(m => texts(m).some(t => t.includes('删好了。')), 10_000)
      expect(decision()).toBe('accept')
      expect(texts(daemon.ilink.outbox()).some(t => t.includes('按规则'))).toBe(false)
    })
  })

  it('主人拒绝:同一个对话里回「n」⇒ codex 收到 decline,这一轮照常收尾', async () => {
    await withDaemon('rm -rf build', '没删,被拒了。', async (daemon, decision) => {
      daemon.sendText('chat1', '把 build 删了')
      await daemon.waitForOutbound(m => texts(m).some(isCard), 10_000)
      daemon.sendText('chat1', 'n')
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

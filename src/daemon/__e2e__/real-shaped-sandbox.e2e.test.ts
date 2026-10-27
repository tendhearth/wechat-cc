// 真实形状沙盒的场景测试(real-shaped.ts;为什么有它见那个文件的开头和 README)。
//
// 一台「照主人真机配置」的 daemon 从开机走到重启:开机没有模块坏、主人说话有回、拍板卡能来回、记忆和 facts.db 导进主库并进了
// 提示词、正常关机再开机不重复导入。断言的都是看得见的行为(外发的微信、/v1/health、日志、主库里的行),不看内部调用。
//
// 红 / 绿的证据(PR 描述里有原文):把 boot-api(当时在 daemon-modules.ts,现在 bootstrap/module.ts)的 `lazy: ['wired'],` 删掉,这个文件在 beforeAll 就红 ——
// `boot-api failed at init (required): … called ctx.late('wired') but 'wired' is not in its lazy`,就是 #729 在真机上的样子。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRealShapedDaemon, type RealShapedDaemon } from './real-shaped'
import type { OutboundMsg } from './fake-ilink-server'
import type { FakeSdkScript } from './fake-sdk'

/**
 * 沙盒里允许不是 ok 的子系统(名字 → 为什么)。空 = 全部 ok。
 * 新加的可选子系统缺省是 off 的话,这里会红:要么在 real-shaped.ts 里把它照真机那样开上,要么在这里写清为什么沙盒开不了。
 */
const ALLOWED_NOT_OK: Record<string, string> = {}

/** 沙盒专门开上的那几样 —— 它们 ok 才说明沙盒还是「真实形状」(配置漂了、开关改名了,这里先红)。 */
const MUST_BE_ON = ['knowledge', 'social', 'mailbox-poller', 'pairing', 'a2a-server', 'yi', 'self-restart', 'phone', 'letters', 'companion', 'guard', 'cli-upgrade']

/**
 * 真机上本来就会往外打、沙盒的网络围栏(fake-boundaries.ts 的 fenceNetwork)当场拦下的请求。不在这张表里的往外请求 = 红:
 * 新代码想出网,要么走注入的缝让测试换成替身,要么在这里写清它在真机上是干什么的。
 */
// 沙盒里允许出现的外连(目前没有):本机凭据由 fake-credentials 换成「没有」,订阅额度不会再拿开发者的真凭据连 api.anthropic.com。
const KNOWN_OUTBOUND: Array<{ url: RegExp; why: string }> = []
const unexpectedOutbound = (blocked: readonly string[]) => blocked.filter(u => !KNOWN_OUTBOUND.some(k => k.url.test(u)))

const texts = (msgs: readonly OutboundMsg[], chatId: string) => msgs.filter(m => m.chatId === chatId && m.endpoint === 'sendmessage').map(m => m.text ?? '')
const isCard = (t: string) => t.includes('Codex 想执行命令')

const spawnOptions: Array<Record<string, unknown>> = []
let codexDecision: unknown
const claudeScript: FakeSdkScript = { async onDispatch(text) { return { toolCalls: [], finalText: text.includes('沙盒你好') ? '主人好,我在。' : '好的。' } } }
const codexScript: FakeSdkScript = {
  async onDispatch(text) {
    if (!text.includes('build')) return { toolCalls: [], finalText: 'Codex 在。' }
    return {
      toolCalls: [], finalText: '删好了。',
      codexSteps: [{
        request: { method: 'item/commandExecution/requestApproval', params: { itemId: 'c-rm', command: 'rm -rf build', cwd: '/tmp', availableDecisions: ['accept', 'decline'] } },
        onResponse: (r: { result?: unknown }) => { codexDecision = (r.result as { decision?: unknown } | undefined)?.decision },
      }],
    }
  },
}
const boot = (stateDir?: string) => startRealShapedDaemon({
  ...(stateDir ? { stateDir } : {}),
  claudeScript, codexScript,
  recordClaudeSpawnOptions: (o) => { spawnOptions.push(o) },
})

let d: RealShapedDaemon
// 冷启动要 import 整个 daemon,满载下可以超过 15s 的缺省 hook 上限
beforeAll(async () => { d = await boot() }, 60_000)
afterAll(async () => { await d?.stop() }, 30_000)

describe('real-shaped sandbox: the full daemon, configured like the owner\'s machine', { timeout: 60_000 }, () => {
  it('boot: every module came up ok, health is green, nothing tried to reach the internet', async () => {
    expect(await d.moduleProblems()).toEqual([])
    const h = await d.health()
    expect(h.ok).toBe(true)
    const notOk = h.subsystems.filter(s => s.state !== 'ok' && !(s.name in ALLOWED_NOT_OK)).map(s => `${s.name}=${s.state}${s.error ? ` (${s.error})` : ''}`)
    expect(notOk, '沙盒里有子系统没开:照真机开上(real-shaped.ts),或在 ALLOWED_NOT_OK 写清为什么').toEqual([])
    const names = new Set(h.subsystems.map(s => s.name))
    for (const m of MUST_BE_ON) expect(names.has(m), `${m} 不在 /v1/health.subsystems 里`).toBe(true)
    // 网络守护开着、走探测:探到的是本机替身,判安全
    await expect.poll(async () => (await d.health()).guard, { timeout: 10_000 }).toMatchObject({ enabled: true, safe: true, source: 'probe' })
    expect(d.internet.hits('/generate_204')).toBeGreaterThan(0)
    // 出门也能用:隧道连上替身中继、签了 challenge
    await expect.poll(() => d.phoneRelay.logins(), { timeout: 10_000 }).toBeGreaterThan(0)
    expect(unexpectedOutbound(d.fence.blocked())).toEqual([])
  })

  it('owner sends text → the reply lands in the WeChat outbox', async () => {
    d.sendText(d.owner, '沙盒你好')
    const out = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('主人好,我在。')), 15_000)
    expect(texts(out, d.owner).filter(t => t.includes('主人好,我在。'))).toHaveLength(1)
  })

  it('memory: boot imported the memory files and facts.db into the main db, and the session prompt carries the owner\'s memory', () => {
    const rows = d.query<{ doc: string; n: number }>('SELECT doc, COUNT(*) AS n FROM memory_facts WHERE chat_id = ? GROUP BY doc', d.owner)
    const byDoc = Object.fromEntries(rows.map(r => [r.doc, r.n]))
    expect(byDoc.memory ?? 0).toBeGreaterThan(0)
    expect(byDoc.owner ?? 0).toBeGreaterThan(0)
    expect(d.query<{ n: number }>("SELECT COUNT(*) AS n FROM memory_facts WHERE doc = 'contact'")[0]!.n).toBe(7)   // facts.json 的 7 行
    expect(d.query<{ chat_id: string }>('SELECT chat_id FROM memory_import ORDER BY chat_id').map(r => r.chat_id)).toEqual(expect.arrayContaining([d.owner, d.guest]))
    expect(d.log().some(l => /\[FACTS_IMPORT\] imported facts\.db: \+7/.test(l))).toBe(true)
    // 上一条的会话起的时候,提示词是从表里读回来的:长期记忆(memory.md)和主人原话(owner.md)都在
    const prompt = JSON.stringify(spawnOptions.at(-1) ?? {})
    expect(prompt).toContain('在杭州做独立开发')
    expect(prompt).toContain('周三晚上固定打羽毛球')
  })

  it('permission card: owner switches to Codex, a gated command sends a card, owner replies "y" and the command proceeds', async () => {
    d.sendText(d.owner, '/codex')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('切到 Codex')), 10_000)
    d.sendText(d.owner, '把 build 删了')
    const card = await d.waitForOutbound(m => texts(m, d.owner).some(isCard), 15_000)
    expect(texts(card, d.owner).find(isCard)).toContain('rm -rf build')
    expect(codexDecision).toBeUndefined()
    d.sendText(d.owner, 'y')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('删好了。')), 15_000)
    expect(codexDecision).toBe('accept')
  })

  it('graceful stop, then reboot on the same state dir: no re-import, still healthy, no module failures', async () => {
    const before = d.query<{ n: number }>('SELECT COUNT(*) AS n FROM memory_facts')[0]!.n
    const stateDir = d.stateDir
    const firstLog = d.log()
    await d.stop({ keepState: true })
    // 关机干净:每一样都停了,没有哪一步停失败
    expect(firstLog.filter(l => /\[MODULES\] stop .* failed/.test(l))).toEqual([])
    expect(firstLog.some(l => /\[MODULES\] stopped internal-api\/stop/.test(l))).toBe(true)

    d = await boot(stateDir)
    expect(await d.moduleProblems()).toEqual([])
    expect((await d.health()).ok).toBe(true)
    // 已经导过的不再导:记忆文件和 facts.db 的指纹都没变
    expect(d.log().filter(l => /\[(MEMORY_IMPORT|FACTS_IMPORT)\]/.test(l))).toEqual([])
    expect(d.query<{ n: number }>('SELECT COUNT(*) AS n FROM memory_facts')[0]!.n).toBe(before)
    // 重启后照样收发(对话模式也留住了:还是 Codex)
    d.sendText(d.owner, '还在吗')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('Codex 在。')), 15_000)
    expect(unexpectedOutbound(d.fence.blocked())).toEqual([])
  })
})

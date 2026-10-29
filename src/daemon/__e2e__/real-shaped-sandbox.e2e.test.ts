// 真实形状沙盒的场景测试(real-shaped.ts;为什么有它见那个文件的开头和 README)。
//
// 一台「照主人真机配置」的 daemon 从开机走到重启:开机没有模块坏、主人说话有回、拍板卡能来回、记忆和 facts.db 导进主库并进了
// 提示词、正常关机再开机不重复导入。中间走几条跨模块的「主人的一天」:在记忆页删一句、放行规则、在微信里派活给执行者、
// 陌生人加进来、拍板卡还挂着时重启、开机时一个可选子系统起不来。断言的都是看得见的行为(外发的微信、HTTP 应答、
// /v1/health、日志、主库里的行、磁盘上的文件),不看内部调用。
//
// 这些 it 是**一条时间线**,按顺序跑、共用一台 daemon(中途重启几次):后面的场景接着前面留下的状态(对话已经切到 Codex、
// 记忆里已经收回了一句)。单独跑某一条(-t)不保证成立。
//
// 红 / 绿的证据(PR 描述里有原文):把 boot-api(当时在 daemon-modules.ts,现在 bootstrap/module.ts)的 `lazy: ['wired'],` 删掉,这个文件在 beforeAll 就红 ——
// `boot-api failed at init (required): … called ctx.late('wired') but 'wired' is not in its lazy`,就是 #729 在真机上的样子。
// 后加的几条各自的红 / 绿写在 README 的场景表下面。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../lib/test-temp'
import { startRealShapedDaemon, type RealShapedDaemon, type RealShapedOpts } from './real-shaped'
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

/** 主人放行规则(permission-rules.json,开机前就在):列目录不用问;git 随便跑 —— 但推送是红线,照旧问。 */
const RULES = JSON.stringify({
  version: 1, enabled: true, review: 'off', starter: 1,
  rules: [
    { id: 'ls', when: { command: '^ls$' }, then: 'allow', note: '列目录不用问' },
    { id: 'git', when: { surface: 'chat', command: '^git ' }, then: 'allow', note: 'git 随便跑' },
  ],
})

/** 主人在桌面上登记过的一个项目(projects.json):一个干净的 git 仓库,工作台的「改动」靠 git 比对。 */
const project = realpathSync(mkdtempSync(join(tmpdir(), 'wechat-cc-sandbox-project-')))
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=sandbox@example.invalid', '-c', 'user.name=sandbox', ...args], { cwd: project, stdio: 'pipe' })
git('init', '-q'); writeFileSync(join(project, 'README.md'), 'sandbox project\n'); git('add', '.'); git('commit', '-qm', 'init')
const PROJECTS = JSON.stringify({ projects: { demo: { path: project, last_active: '2026-10-27T00:00:00.000Z' } }, current: null })

/** 这一句主人在记忆页上删掉(记忆夹具 memory.md 里「关于你」那一栏生成的一行)。 */
const RETRACTED = '每天早上七点起床跑步'
const STRANGER = 'o9fixture-stranger@im.wechat'

/** 入站给执行者的是 `<wechat …>原话</wechat>`(前面可能还有交接说明、近况);剧本按主人这一句的原话分路。 */
const said = (text: string): string => [...text.matchAll(/<wechat [^>]*>\n([\s\S]*?)\n<\/wechat>/g)].at(-1)?.[1]?.trim() ?? text.trim()

const spawnOptions: Array<Record<string, unknown>> = []
const codexThreads: Array<Record<string, unknown>> = []
/** codex 收到的审批应答,按命令记。 */
const decisions = new Map<string, unknown>()
let codexDecision: unknown
const claudeScript: FakeSdkScript = { async onDispatch(text) { return { toolCalls: [], finalText: text.includes('沙盒你好') ? '主人好,我在。' : '好的。' } } }
const approval = (command: string, finalText: string) => ({
  toolCalls: [], finalText,
  codexSteps: [{
    request: { method: 'item/commandExecution/requestApproval', params: { itemId: `c-${command}`, command, cwd: '/tmp', availableDecisions: ['accept', 'decline'] } },
    onResponse: (r: { result?: unknown }) => {
      const d = (r.result as { decision?: unknown } | undefined)?.decision
      decisions.set(command, d)
      if (command === 'rm -rf build') codexDecision = d
    },
  }],
})
const codexScript: FakeSdkScript = {
  async onDispatch(text) {
    const s = said(text)
    if (s === '把 build 删了') return approval('rm -rf build', '删好了。')
    if (s === '列一下目录') return approval('ls', '列好了。')
    if (s === '推一下') return approval('git push origin main', '推不了,被拒了。')
    if (s === '再清一次 dist') return approval('rm -rf dist', '清好了。')
    // 工作台派下来的活(执行者在项目里改文件 —— 这是执行者那一侧的事,替身照真 codex 那样直接写盘)
    if (s.includes('写一份笔记')) { writeFileSync(join(project, 'NOTE.md'), '第一行\n第二行\n'); return { toolCalls: [], finalText: '写好了 NOTE.md。' } }
    return { toolCalls: [], finalText: 'Codex 在。' }
  },
}
const boot = (more: Pick<RealShapedOpts, 'stateDir' | 'agentConfigPatch'> = {}) => startRealShapedDaemon({
  ...more,
  claudeScript, codexScript,
  recordClaudeSpawnOptions: (o) => { spawnOptions.push(o) },
  recordCodexSpawnOptions: (o) => { codexThreads.push(o) },
  ...(more.stateDir ? {} : { seedFiles: { 'permission-rules.json': RULES, 'projects.json': PROJECTS } }),
})

/** 桌面 / CLI 那一侧:operator 令牌(工作台、记忆页那一串路由走它)。 */
async function desktop<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const info = JSON.parse(readFileSync(join(d.stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string; operatorTokenFilePath: string }
  const r = await fetch(`${info.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${readFileSync(info.operatorTokenFilePath, 'utf8').trim()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: r.status, body: await r.json() as T }
}

let d: RealShapedDaemon
// 冷启动要 import 整个 daemon,满载下可以超过 15s 的缺省 hook 上限
beforeAll(async () => { d = await boot() }, 60_000)
afterAll(async () => { try { await d?.stop() } finally { removeTempDir(project) } }, 30_000)

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
    // 下一条场景要在记忆页上删掉的那一句,这时还在提示词里
    expect(prompt).toContain(RETRACTED)
  })

  it('memory edit: the owner deletes a line on the desktop memory page ⇒ the row is retracted, memory.md is re-exported without it, it shows up under 收回的话', async () => {
    type View = { ok: boolean; baseHash: string; lines: Array<{ text: string; lineKey?: string; assertionId?: string }> }
    const view = await desktop<View>('POST', '/v1/memory/view', { path: 'memory.md' })
    expect(view.status).toBe(200)
    expect(view.body.lines.map(l => l.text)).toContain(RETRACTED)
    const kept = view.body.lines.filter(l => l.text !== RETRACTED).map(l => ({ text: l.text, ...(l.lineKey ? { lineKey: l.lineKey } : {}), ...(l.assertionId ? { assertionId: l.assertionId } : {}) }))
    const edit = await desktop<{ ok: boolean; corrections?: Array<{ text: string }> }>('POST', '/v1/memory/edit', { path: 'memory.md', baseHash: view.body.baseHash, lines: kept })
    expect(edit.status).toBe(200)
    expect(edit.body).toMatchObject({ ok: true })
    expect(edit.body.corrections?.map(c => c.text)).toEqual([RETRACTED])

    // 主库:那一行收回了,不再有生效的同一句
    const rows = d.query<{ status: string }>('SELECT status FROM memory_facts WHERE chat_id = ? AND doc = ? AND text = ?', d.owner, 'memory', RETRACTED)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter(r => r.status === 'active')).toEqual([])
    // 磁盘上的 memory.md 是从表导出的:那句没了,别的还在
    const md = readFileSync(join(d.stateDir, 'memory', d.owner, 'memory.md'), 'utf8')
    expect(md).not.toContain(RETRACTED)
    expect(md).toContain('在杭州做独立开发')
    // 记忆页「收回的话」里有它(能恢复);再打开记忆页,那一行不在了
    const retractions = await desktop<{ ok: boolean; items: Array<{ text: string }> }>('GET', '/v1/memory/retractions')
    expect(retractions.body.items.map(i => i.text)).toContain(RETRACTED)
    expect((await desktop<View>('POST', '/v1/memory/view', { path: 'memory.md' })).body.lines.map(l => l.text)).not.toContain(RETRACTED)
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
    // 新起的 Codex 会话(开发者指令槽)现读记忆:上一条在记忆页删掉的那句不在,别的长期记忆在 —— 「记忆改了算数」到了提示词这一头
    const instructions = String(codexThreads.at(-1)?.developerInstructions ?? '')
    expect(instructions).toContain('在杭州做独立开发')
    expect(instructions).not.toContain(RETRACTED)
  })

  it('permission rules: a rule in permission-rules.json lets a command through without a card and says so in one line; a red line (git push) still asks even though a rule allows git', async () => {
    d.sendText(d.owner, '列一下目录')
    const out = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('按规则')), 15_000)
    expect(decisions.get('ls')).toBe('accept')
    expect(texts(out, d.owner).find(t => t.includes('按规则'))).toBe('按规则「列目录不用问」放行了 ls')
    expect(texts(out, d.owner).some(t => t.includes('列好了。'))).toBe(true)
    expect(texts(out, d.owner).filter(isCard)).toHaveLength(1)   // 只有上一条 rm -rf build 那张

    d.sendText(d.owner, '推一下')
    const card = await d.waitForOutbound(m => texts(m, d.owner).filter(isCard).length === 2, 15_000)
    expect(texts(card, d.owner).filter(isCard).at(-1)).toContain('git push origin main')
    expect(decisions.has('git push origin main')).toBe(false)
    d.sendText(d.owner, 'n')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('推不了,被拒了。')), 15_000)
    expect(decisions.get('git push origin main')).toBe('decline')
    expect(texts(d.ilink.outbox(), d.owner).filter(t => t.includes('按规则'))).toHaveLength(1)
  })

  // win32 不跑:Codex 当工作台执行者在 Windows 上开头就拒绝(src/adapters/executors/codex/codex-app-server.ts,进程树清理未验证),
  // 跟 vitest.config.ts 里工作台 Codex 测试的 win32 排除同一个理由;Windows 上派活这条路要等 Windows 工作台单独立项。
  it.skipIf(process.platform === 'win32')('workbench from WeChat: owner picks a project, hands a task to Codex, the executor edits a file, the owner is told it is done and 「改动」/ the review route show the change', async () => {
    d.sendText(d.owner, '任务 项目')
    const list = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('选择要工作的项目')), 15_000)
    const listing = texts(list, d.owner).find(t => t.includes('选择要工作的项目'))!
    expect(listing).toContain(project)
    const projectId = listing.match(/p-[a-f0-9]{20}/)?.[0]
    expect(projectId).toBeTruthy()

    d.sendText(d.owner, `任务 新建 ${projectId} 用 @codex 写一份笔记`)
    const ack = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.startsWith('已接下这件事')), 15_000)
    const taskId = texts(ack, d.owner).find(t => t.startsWith('已接下这件事'))!.match(/已接下这件事 · ([a-f0-9]{8})/)?.[1]
    expect(taskId).toBeTruthy()

    // 这一轮答完了:桌面看到的任务是「已答复」(Codex 的会话留着,等主人接着说),执行者真的把文件写进了项目
    await expect.poll(async () => (await desktop<{ task: { phase: string } }>('GET', `/v1/workbench/task?id=${taskId}`)).body.task.phase, { timeout: 30_000 }).toBe('replied')
    expect(readFileSync(join(project, 'NOTE.md'), 'utf8')).toBe('第一行\n第二行\n')
    // 给主人的回报(微信里派的活,回报回到微信):进了回报发件箱,带着答复正文。主人刚在这件事上说过话,回报故意晚一分钟再发
    // (report.ts 的 shouldDisturb),所以这里看发件箱那一行,不等它真发出去
    await expect.poll(() => d.query<{ text: string }>('SELECT text FROM matter_report_outbox WHERE matter_id = ?', taskId!).map(r => r.text), { timeout: 15_000 })
      .toEqual([expect.stringContaining('已答复')])
    expect(d.query<{ text: string }>('SELECT text FROM matter_report_outbox WHERE matter_id = ?', taskId!)[0]!.text).toContain('写好了 NOTE.md。')
    // 没有「需要处理 / 已中断」那种通知
    expect(texts(d.ilink.outbox(), d.owner).filter(t => t.includes(`· ${taskId}`) && /需要处理|已中断/.test(t))).toEqual([])

    // 微信里「任务 <编号> 改动」:改了哪个文件
    d.sendText(d.owner, `任务 ${taskId} 改动`)
    const isChanges = (t: string) => t.startsWith(`任务 ${taskId}`) && t.includes('NOTE.md')
    const changes = await d.waitForOutbound(m => texts(m, d.owner).some(isChanges), 15_000)
    expect(texts(changes, d.owner).find(isChanges)).toContain('新建')
    // 桌面的审阅路由:同一份快照里有 NOTE.md
    const review = await desktop<{ reviews: Array<{ files?: Array<{ path: string }> }> }>('GET', `/v1/workbench/review?id=${taskId}`)
    expect(review.status).toBe(200)
    expect(review.body.reviews.flatMap(r => r.files ?? []).map(f => f.path)).toContain('NOTE.md')
  })

  it('guest path: a stranger writes ⇒ neutral reply + the owner is asked; owner approves ⇒ the stranger is onboarded and talks to CC in a locked-down session that carries none of the owner\'s memory', async () => {
    const before = spawnOptions.length
    d.sendText(STRANGER, '你好呀')
    const asked = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('想和我聊天')), 15_000)
    expect(texts(asked, STRANGER)).toEqual(['我需要主人确认一下,稍等哦~'])
    const code = texts(asked, d.owner).find(t => t.includes('想和我聊天'))!.match(/允许\s+(\d{6})/)?.[1]
    expect(code).toBeTruthy()

    d.sendText(d.owner, `允许 ${code}`)
    await d.waitForOutbound(m => texts(m, STRANGER).some(t => t.includes('称呼你')), 15_000)
    expect(texts(d.ilink.outbox(), d.owner)).toContain(`已允许 ${STRANGER}`)
    d.sendText(STRANGER, '丸子')
    await d.waitForOutbound(m => texts(m, STRANGER).some(t => t === '好的。'), 15_000)

    const guestSpawns = spawnOptions.slice(before)
    expect(guestSpawns.length).toBeGreaterThan(0)
    const spawn = guestSpawns.at(-1)!
    // 访客档:能动手的工具全关(读写文件、跑命令、联网、派子任务)
    expect(spawn.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'Task']))
    // 主人的长期记忆和原话不进访客的提示词
    const prompt = JSON.stringify(spawn)
    expect(prompt).not.toContain('在杭州做独立开发')
    expect(prompt).not.toContain('周三晚上固定打羽毛球')
  })

  it('restart while a card is pending: the card dies with the daemon — after the reboot the owner is told once that it is void, and the late "y" approves nothing (ordinary chat)', async () => {
    d.sendText(d.owner, '再清一次 dist')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => isCard(t) && t.includes('rm -rf dist')), 15_000)
    const stateDir = d.stateDir
    const firstLog = d.log()
    await d.stop({ keepState: true })
    expect(firstLog.filter(l => /\[MODULES\] stop .* failed/.test(l))).toEqual([])
    // 关机时那一轮收尾:挂着的审批请求按「拒」答回给 codex(它不会自己当成放行接着跑)
    expect(['decline', 'cancel']).toContain(decisions.get('rm -rf dist'))
    decisions.delete('rm -rf dist')

    d = await boot({ stateDir })
    expect(await d.moduleProblems()).toEqual([])
    // 重启后告诉主人一次:重启前那张卡作废了(卡上那一句话说要做什么),在发卡的那个对话里
    const VOID = '重启前那张「Codex 想执行命令:rm -rf dist」的卡作废了，还要的话再说一次。'
    await d.waitForOutbound(m => texts(m, d.owner).includes(VOID), 15_000)
    // 待批登记处只在内存里:重启后那张卡不在了,主人回的「y」不是拍板,当普通的一句话交给 CC(有回、没出新卡、没放行任何东西)
    d.sendText(d.owner, 'y')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('Codex 在。')), 15_000)
    expect(decisions.has('rm -rf dist')).toBe(false)
    // 卡 = 带「怎么回」那一行的;作废通知里有卡上那句话,但没有码、批不了
    expect(texts(d.ilink.outbox(), d.owner).some(t => isCard(t) && t.includes('放行、'))).toBe(false)
    expect(d.log().some(l => /\[PERMISSION\] consumed reply/.test(l))).toBe(false)
    // 只说一次:作废通知恰好一条;说完表里清掉了,下次开机不再说
    expect(texts(d.ilink.outbox(), d.owner).filter(t => t.includes('作废了'))).toEqual([VOID])
    expect(d.query<{ n: number }>('SELECT COUNT(*) AS n FROM pending_cards')[0]!.n).toBe(0)
  })

  it('graceful stop, then reboot on the same state dir: no re-import, still healthy, no module failures', async () => {
    const before = d.query<{ n: number }>('SELECT COUNT(*) AS n FROM memory_facts')[0]!.n
    const stateDir = d.stateDir
    const firstLog = d.log()
    await d.stop({ keepState: true })
    // 关机干净:每一样都停了,没有哪一步停失败
    expect(firstLog.filter(l => /\[MODULES\] stop .* failed/.test(l))).toEqual([])
    expect(firstLog.some(l => /\[MODULES\] stopped internal-api\/stop/.test(l))).toBe(true)

    d = await boot({ stateDir })
    expect(await d.moduleProblems()).toEqual([])
    expect((await d.health()).ok).toBe(true)
    // 已经导过的不再导:记忆文件和 facts.db 的指纹都没变
    expect(d.log().filter(l => /\[(MEMORY_IMPORT|FACTS_IMPORT)\]/.test(l))).toEqual([])
    expect(d.query<{ n: number }>('SELECT COUNT(*) AS n FROM memory_facts')[0]!.n).toBe(before)
    // 重启后照样收发(对话模式也留住了:还是 Codex)
    d.sendText(d.owner, '还在吗')
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('Codex 在。')), 15_000)
    expect(unexpectedOutbound(d.fence.blocked())).toEqual([])
    // 上一次重启已经说过作废了,这次没有挂着的卡 ⇒ 不再说
    expect(texts(d.ilink.outbox(), d.owner).filter(t => t.includes('作废了'))).toEqual([])
    // 记忆页删掉的那句,重启以后也没回来(手改核对没把它当成「磁盘上多出来的」)
    expect(readFileSync(join(stateDir, 'memory', d.owner, 'memory.md'), 'utf8')).not.toContain(RETRACTED)
  })

  it('degraded boot: another program took the A2A port ⇒ the daemon still boots, health says which one is down, the owner gets one plain-words notice, and chat keeps working', async () => {
    const stateDir = d.stateDir
    await d.stop({ keepState: true })
    const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('occupied') })
    try {
      d = await boot({ stateDir, agentConfigPatch: { a2a_listen: { host: '127.0.0.1', port: blocker.port } } })
      const h = await d.health()
      expect(h.subsystems.filter(s => s.state !== 'ok').map(s => `${s.name}=${s.state}`)).toEqual(['a2a-server=degraded'])
      for (const m of MUST_BE_ON.filter(n => n !== 'a2a-server')) expect(h.subsystems.find(s => s.name === m)?.state, m).toBe('ok')
      await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('没起来')), 15_000)
      expect(texts(d.ilink.outbox(), d.owner).filter(t => t.includes('没起来'))).toEqual(['这次开机有几样没起来：CC 之间的往来。其它功能照常。'])
      d.sendText(d.owner, '还在吗')
      await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('Codex 在。')), 15_000)
      expect(existsSync(join(stateDir, 'wechat-cc.db'))).toBe(true)
    } finally {
      blocker.stop(true)
    }
  })

  it('output eval: POST /v1/eval/run runs one turn on the production prompt in a read-only session — no WeChat message, no messages row', async () => {
    const outboxBefore = d.ilink.outbox().length
    const rowsBefore = d.query<{ n: number }>('SELECT COUNT(*) AS n FROM messages')[0]!.n
    const spawnsBefore = spawnOptions.length
    const res = await desktop<Record<string, unknown>>('POST', '/v1/eval/run', { kind: 'reply', text: '早', providerId: 'claude' })
    expect(res.status).toBe(200)
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ ok: true, kind: 'reply', providerId: 'claude', finalText: '好的。', bubbles: ['好的。'], silent: false })
    // 起的是一条新会话:提示词是生产那一份(回复交付那段在),不是 selftest 的「自检对话」;只读档(Claude 的写文件 / 命令被禁)
    expect(spawnOptions.length).toBe(spawnsBefore + 1)
    const opts = spawnOptions.at(-1)! as { systemPrompt?: { append?: string }; permissionMode?: string; disallowedTools?: string[] }
    expect(opts.systemPrompt?.append).toContain('最后写下的那段话就是发给对方的回复')
    expect(opts.systemPrompt?.append).not.toContain('自检对话')
    expect(opts.permissionMode).toBe('default')
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']))
    // 不发微信、不写对话库
    expect(d.ilink.outbox().length).toBe(outboxBefore)
    expect(d.query<{ n: number }>('SELECT COUNT(*) AS n FROM messages')[0]!.n).toBe(rowsBefore)
    // 一次性会话的 chatId 不在 STATE_DIR 里留下记忆目录(组装提示词读记忆时建的空目录,跑完收掉)
    expect(readdirSync(join(d.stateDir, 'memory')).filter(n => n.startsWith('eval-'))).toEqual([])
    // 请求不成立 ⇒ 400 + 码表里的码
    expect(await desktop('POST', '/v1/eval/run', { kind: 'reply' })).toMatchObject({ status: 400, body: { error: 'eval_invalid_request' } })
  })
})

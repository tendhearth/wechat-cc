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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../lib/test-temp'
import { deviceIdOf } from '../../features/phone/device-store'
import { SANDBOX_OWNER, startRealShapedDaemon, type RealShapedDaemon, type RealShapedOpts } from './real-shaped'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import type { Db } from '../../lib/db'
import { openSqlite } from '../../lib/runtime/sqlite'
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
// Chat and delegated work must have separate directories even when TMPDIR is
// nested inside this checkout; otherwise the real session conflict gate is right to refuse.
const chatProject = realpathSync(mkdtempSync(join(tmpdir(), 'wechat-cc-sandbox-chat-')))
const PROJECTS = JSON.stringify({ projects: { demo: { path: project, last_active: '2026-10-27T00:00:00.000Z' }, chat: { path: chatProject, last_active: '2026-10-27T00:00:00.000Z' } }, current: 'chat' })

/** 这一句主人在记忆页上删掉(记忆夹具 memory.md 里「关于你」那一栏生成的一行)。 */
const RETRACTED = '每天早上七点起床跑步'
const STRANGER = 'o9fixture-stranger@im.wechat'

/** 入站给执行者的是 `<wechat …>原话</wechat>`(前面可能还有交接说明、近况);剧本按主人这一句的原话分路。 */
const said = (text: string): string => [...text.matchAll(/<wechat [^>]*>\n([\s\S]*?)\n<\/wechat>/g)].at(-1)?.[1]?.trim() ?? text.trim()

/** S2 那几条:配对过的一台手机、免打扰里压着的那一句、那件事的编号。 */
const PHONE_TOKEN = 'sandbox-phone-device-token-0001'
const PHONE_ID = deviceIdOf(PHONE_TOKEN)
const QUIET_NOTE = '自改进展:免打扰里做完的那一步'
/** 主人时区(Asia/Shanghai)的 HH:MM,给「/set 免打扰」用。 */
const shanghaiHHMM = (ms: number): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
const FIXED_BRIEF_REPLY = 'S4 fixed brief delivered'
/** 配合固定的 Date 使用:任务就在当前本地分钟到期,不把昨天的 23:59 误写成今天的定时。 */
const fixedBriefJobs = (now: number): string => JSON.stringify({ version: 1, jobs: [{ id: 'j991', schedule: { kind: 'daily', at: shanghaiHHMM(now) }, text: 'S4 fixed brief', brief: true, paused: false, createdAt: new Date(now).toISOString() }] })
/** 中继收到的、给那件事的 App 推送(collapseId = 任务编号)。 */
const pushesFor = (taskId: string) => d.phoneRelay.controls().filter(c => (c.push as { collapseId?: string } | undefined)?.collapseId === taskId)

const spawnOptions: Array<Record<string, unknown>> = []
const codexThreads: Array<Record<string, unknown>> = []
/** codex 收到的审批应答,按命令记。 */
const decisions = new Map<string, unknown>()
let codexDecision: unknown
let topicJudgeAttempts=0,topicRoundDispatches=0
const claudeScript: FakeSdkScript = { async onDispatch(text) { if(text.includes('快判沙盒配色'))topicRoundDispatches++; return { toolCalls: [], finalText: text.includes('<scheduled_job id="j991"') ? FIXED_BRIEF_REPLY : text.includes('沙盒你好') ? '主人好,我在。' : '好的。' } } }
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
const boot = (more: Pick<RealShapedOpts, 'stateDir' | 'agentConfigPatch' | 'speechFlushIntervalMs' | 'scheduledJobsIntervalMs' | 'reminderIntervalMs' | 'machineIdleS' | 'escalateAfterMs'> = {}) => startRealShapedDaemon({
  ...more,
  claudeScript, codexScript,
  // 只替身模型边界:让手动睡眠走正常成功路径,不发真实模型请求。
  moderatorScript: { onEval: async (prompt) => { if(prompt.startsWith('主人对 CC 说了一句话。判断')&&prompt.includes('快判沙盒配色')){topicJudgeAttempts++;await new Promise(r=>setTimeout(r,5500))}; return JSON.stringify({ add: [], update: [], confirm: [], remove: [] }) } },
  recordClaudeSpawnOptions: (o) => { spawnOptions.push(o) },
  recordCodexSpawnOptions: (o) => { codexThreads.push(o) },
  ...(more.stateDir ? {} : { seedFiles: { 'permission-rules.json': RULES, 'projects.json': PROJECTS } }),
})

/** 桌面 / CLI 那一侧:operator 令牌(工作台、记忆页那一串路由走它)。 */
async function desktop<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, credential:'operator'|'trusted'='operator'): Promise<{ status: number; body: T }> {
  const info = JSON.parse(readFileSync(join(d.stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string; operatorTokenFilePath: string; tokenFilePath:string }
  const r = await fetch(`${info.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${readFileSync(credential==='trusted'?info.tokenFilePath:info.operatorTokenFilePath, 'utf8').trim()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: r.status, body: await r.json() as T }
}

let d: RealShapedDaemon

/**
 * S2 那几条的起点(关机时写死,不靠上一条留下的):主人的免打扰开(盖住此刻,主人时区)/ 关、配没配一台手机、
 * 待发队列清空(keepPending 的除外 —— 「压着时重启」要的就是它)。然后照真机重启,「待说」那一拍 200ms。
 */
async function rebootForS2(o: { quiet: boolean; phone: boolean; keepPending?: boolean; beforeBoot?: (stateDir: string) => void; atDesk?: boolean; timedJobs?: boolean }): Promise<string> {
  const stateDir = d.stateDir
  await d.stop({ keepState: true })
  // 免打扰:chat_prefs.json 一个对话一行(值是 JSON 字符串),daemon 开机读一次
  const prefsFile = join(stateDir, 'chat_prefs.json')
  const prefs = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf8')) as Record<string, string> : {}
  const mine = prefs[SANDBOX_OWNER] ? JSON.parse(prefs[SANDBOX_OWNER]) as Record<string, unknown> : {}
  delete mine.quiet
  if (o.quiet) { const now = Date.now(); mine.quiet = { from: shanghaiHHMM(now - 60_000), to: shanghaiHHMM(now + 2 * 3600_000) } }
  writeFileSync(prefsFile, JSON.stringify({ ...prefs, [SANDBOX_OWNER]: JSON.stringify(mine) }))
  // 手机:配对在 settings-devices.json,推送登记在 phone-push.json
  if (o.phone) {
    writeFileSync(join(stateDir, 'settings-devices.json'), JSON.stringify({ [PHONE_TOKEN]: { created_at: '2026-11-01T00:00:00.000Z' } }), { mode: 0o600 })
    writeFileSync(join(stateDir, 'phone-push.json'), JSON.stringify({ [PHONE_ID]: { platform: 'apns', token: 'a'.repeat(64), at: 0 } }), { mode: 0o600 })
  } else {
    rmSync(join(stateDir, 'settings-devices.json'), { force: true }); rmSync(join(stateDir, 'phone-push.json'), { force: true })
  }
  if (!o.keepPending) {
    const db = openSqlite(join(stateDir, 'wechat-cc.db'))
    try { db.exec('DELETE FROM speech_pending') } finally { db.close() }
  }
  o.beforeBoot?.(stateDir)
  // 人在不在电脑前(S3b):缺省探不到 = 不在;atDesk ⇒ 本机 5 秒前刚有键鼠输入,「先只在桌面提示」之后 2 秒就推 App(生产 10 分钟)
  d = await boot({ stateDir, speechFlushIntervalMs: 200, ...(o.timedJobs ? { scheduledJobsIntervalMs: 200 } : {}), ...(o.atDesk ? { machineIdleS: 5, escalateAfterMs: 2_000 } : {}) })
  expect(await d.moduleProblems()).toEqual([])
  if (o.phone) await expect.poll(() => d.phoneRelay.controls().some(c => (c.push_reg as { device?: string } | undefined)?.device === PHONE_ID), { timeout: 15_000 }).toBe(true)
  return stateDir
}
// 冷启动要 import 整个 daemon,满载下可以超过 15s 的缺省 hook 上限
beforeAll(async () => { d = await boot() }, 60_000)
afterAll(async () => { try { await d?.stop() } finally { removeTempDir(project); removeTempDir(chatProject) } }, 30_000)

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
    const prompt = JSON.stringify(spawnOptions.at(-1)?.systemPrompt ?? {})
    expect(prompt).toContain('在杭州做独立开发')
    expect(prompt).toContain('周三晚上固定打羽毛球')
    // 下一条场景要在记忆页上删掉的那一句,这时还在提示词里
    expect(prompt).toContain(RETRACTED)
  })

  it('T6: 快判超时退回索引，回合不拖慢，之后精确命中仍可用', async () => {
    const db = openSqlite(join(d.stateDir, 'wechat-cc.db')) as unknown as Db
    const threads = makeThreadsStore(db), configPath=join(d.stateDir,'agent-config.json')
    const config=readFileSync(configPath,'utf8')
    const ids:string[]=[]
    try {
      writeFileSync(configPath,JSON.stringify({...JSON.parse(config),turnJudgeProvider:'claude'}))
      for(const title of ['快判甲','快判乙']) {
        const id=await threads.create({chatId:d.owner,title,summary:'快判沙盒配色',facets:[],tags:[],private:true,episodes:[]});ids.push(id)
        await threads.addEntry({threadId:id,kind:'fact',line:'快判沙盒配色方案'})
      }
      const before=topicRoundDispatches, attempts=topicJudgeAttempts, start=Date.now()
      d.sendText(d.owner,'快判沙盒配色')
      await expect.poll(()=>topicRoundDispatches,{timeout:6000}).toBeGreaterThan(before)
      expect(topicJudgeAttempts).toBe(attempts+1)
      expect(Date.now()-start).toBeLessThan(3400)
      expect(d.query('SELECT * FROM topic_recall_refs WHERE thread_id=?',ids[0]!)).toHaveLength(0)
      d.sendText(d.owner,'快判甲后来怎么样了')
      await expect.poll(()=>d.query('SELECT * FROM topic_recall_refs WHERE thread_id=?',ids[0]!).length,{timeout:6000}).toBe(1)
    } finally {writeFileSync(configPath,config);for(const id of ids)db.query('DELETE FROM threads WHERE id=?').run(id);db.close()}
  })

  it('checkup: explicit owner trigger scores visible synthetic speech and preserves isolation', async () => {
    type View = import('@wechat-cc/protocol').CheckupView
    const before = await desktop<View>('GET', '/v1/checkup')
    expect(before.status).toBe(200)
    expect(before.body.target.provider).toBe('claude')
    expect(before.body.profile).toBeNull()
    expect(before.body.periodicProbe).toBe(false)
    expect((await desktop('GET', '/v1/checkup', undefined, 'trusted')).status).toBe(403)
    const personaPath=join(d.stateDir,'memory',d.owner,'persona.md')
    const priorPersona=existsSync(personaPath)?readFileSync(personaPath,'utf8'):null
    const privateCanary='CHECKUP_PRIVATE_MEMORY_TOPIC_693818'
    writeFileSync(personaPath,`名字：小禾\n称呼用户：阿青\n自称：小禾\n记忆：${privateCanary}`)
    const spawnsBefore=spawnOptions.length
    const estimate = await desktop<{ targetKey: string; requests: number }>('POST', '/v1/checkup/estimate', {})
    expect(estimate.status).toBe(200)
    expect(estimate.body.requests).toBe(56)
    expect((await desktop('POST', '/v1/checkup/run', { expectedTargetKey: estimate.body.targetKey }, 'trusted')).status).toBe(403)
    const started = await desktop<View>('POST', '/v1/checkup/run', { expectedTargetKey: estimate.body.targetKey })
    expect(started.status).toBe(202)
    await expect.poll(async () => (await desktop<View>('GET', '/v1/checkup')).body.attempt?.status, { timeout: 15000 }).toBe('completed')
    const result = await desktop<View>('GET', '/v1/checkup')
    // The boundary fake says only "好的。" and never calls the fictional tools.
    // Its visible speech is evidence. Wrong content fails the relevant qualities;
    // lack of reply calls does not turn a completed interview into infrastructure failure.
    expect(result.body.profile).toMatchObject({memory:'weak',interview:{version:'interview-v3',qualities:{memory:{ratio:0}}}})
    // This SDK boundary deliberately omits usage, so every 3 × 4096 reservation
    // stays charged. The short allowance is sized so all 28 questions still fit.
    expect(result.body.attempt).toMatchObject({status:'completed',completedRequests:28,totalRequests:28})
    expect(result.body.attempt?.errorCode).toBeUndefined()
    expect(result.body.profile?.interview?.qualities.stance.unmeasured).toBeUndefined()
    expect(readFileSync(join(d.stateDir,'checkup','observations.json'),'utf8')).toContain('好的。')
    const interviewSpawns=spawnOptions.slice(spawnsBefore).filter(o=>o.strictMcpConfig===true)
    expect(interviewSpawns).toHaveLength(28)
    expect(interviewSpawns.every(o=>Array.isArray(o.allowedTools)&&o.allowedTools.includes('mcp__wechat__delegate'))).toBe(true)
    expect(interviewSpawns.every(o=>(o.env as Record<string,unknown>|undefined)?.CLAUDE_CODE_MAX_OUTPUT_TOKENS==='4096')).toBe(true)
    const sent=JSON.stringify(interviewSpawns.map(o=>({system:o.systemPrompt,tools:o.tools,allowedTools:o.allowedTools,settings:o.settings})))
    expect(sent).toContain('小禾')
    for(const secret of [privateCanary,'在杭州做独立开发','周三晚上固定打羽毛球',d.stateDir])expect(sent).not.toContain(secret)
    if(priorPersona===null)rmSync(personaPath);else writeFileSync(personaPath,priorPersona)
    expect(result.body.periodicProbe).toBe(false)
    expect(existsSync(join(d.stateDir, 'checkup', 'profiles.json'))).toBe(true)
    expect(unexpectedOutbound(d.fence.blocked())).toEqual([])
  })

  it('T4: recall opens a private bubble; successful sleep closes it except for owner-visible running matters', async () => {
    const db = openSqlite(join(d.stateDir, 'wechat-cc.db')) as unknown as Db
    const threads = makeThreadsStore(db)
    const id = await threads.create({ chatId: d.owner, title: '沙盒备份服务器', summary: '每天检查备份', facets: ['task'], tags: [], private: true, episodes: [] })
    await threads.addEntry({ threadId: id, kind: 'decision', line: '备份必须每日核验' })
    try {
      d.sendText(d.owner, '沙盒备份服务器后来怎么样了')
      await expect.poll(() => d.query<{ state: string }>('SELECT state FROM topic_bubbles WHERE thread_id=?', id)[0]?.state, { timeout: 15000 }).toBe('open')
      await expect.poll(() => d.query('SELECT * FROM topic_recall_refs WHERE thread_id=?', id).length, { timeout: 5000 }).toBe(1)
      const visible = await desktop<{ topics: Array<{ id: string }> }>('GET', '/v1/memory/topics')
      expect(visible.status).toBe(200)
      expect(visible.body.topics.map(t => t.id)).toContain(id)
      for (const path of ['/v1/memory/topics', `/v1/memory/topics/detail?id=${id}`, '/v1/subscribe/topics?wait_ms=0']) {
        const denied = await desktop('GET', path, undefined, 'trusted')
        expect(denied.status).toBe(403)
        expect(JSON.stringify(denied.body)).not.toContain('沙盒备份服务器')
      }
      // 轮可能还在收尾;等待它结束再开始一次真正成功的记忆整理。
      await expect.poll(() => d.query("SELECT id FROM matter_turns WHERE status='running'").length, { timeout: 15000 }).toBe(0)
      const sleep = await desktop<{ result: { status: string } }>('POST', '/v1/memory/nightly/run', {}, 'trusted')
      expect(sleep.status).toBe(200)
      expect(sleep.body.result.status).toBe('written')
      await expect.poll(() => d.query<{ state: string }>('SELECT state FROM topic_bubbles WHERE thread_id=?', id)[0]?.state).toBe('closed')
      const m = makeMatterStore(db).create({ kind: 'task', title: '核验备份', ownerChatId: d.owner })
      db.query('INSERT INTO matter_topics(matter_id,thread_id,attached_ts) VALUES(?,?,?)').run(m.id, id, new Date().toISOString())
      const log = makeMatterLog(db), turn = log.startTurn({ matterId: m.id, executor: 'sandbox' })
      expect(d.query<{ state: string }>('SELECT state FROM topic_bubbles WHERE thread_id=?', id)[0]?.state).toBe('open')
      const next = await desktop<{ result: { status: string; reason?: string } }>('POST', '/v1/memory/nightly/run', {}, 'trusted')
      expect(next.status).toBe(200)
      expect(['written', 'skipped']).toContain(next.body.result.status)
      if (next.body.result.status === 'skipped') expect(next.body.result.reason).toBe('no_new_material')
      expect(d.query<{ state: string }>('SELECT state FROM topic_bubbles WHERE thread_id=?', id)[0]?.state).toBe('open')
      log.finishTurn(turn.id, { status: 'completed', matterState: 'done' })
      expect(d.query<{ state: string }>('SELECT state FROM topic_bubbles WHERE thread_id=?', id)[0]?.state).toBe('open')
      await desktop('POST', '/v1/memory/nightly/run', {}, 'trusted')
      expect(d.query<{ state: string }>('SELECT state FROM topic_bubbles WHERE thread_id=?', id)[0]?.state).toBe('closed')
    } finally { db.close() }
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
    const projectId = listing.match(/demo · (p-[a-f0-9]{20})/)?.[1]
    expect(projectId).toBeTruthy()

    d.sendText(d.owner, `任务 新建 ${projectId} 用 @codex 写一份笔记`)
    const ack = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.startsWith('已接下这件事')), 15_000)
    const taskId = texts(ack, d.owner).find(t => t.startsWith('已接下这件事'))!.match(/已接下这件事 · ([a-f0-9]{8})/)?.[1]
    expect(taskId).toBeTruthy()

    // 这一轮答完了:桌面看到的任务是「已答复」(Codex 的会话留着,等主人接着说),执行者真的把文件写进了项目
    await expect.poll(async () => (await desktop<{ task: { phase: string } }>('GET', `/v1/workbench/task?id=${taskId}`)).body.task.phase, { timeout: 30_000 }).toBe('replied')
    expect(readFileSync(join(project, 'NOTE.md'), 'utf8')).toBe('第一行\n第二行\n')
    // T5d: real boot wiring projects the originating owner message and MatterLog result on the shared operator route.
    expect((await desktop('GET','/v1/protocol/capabilities')).body).toEqual({routes:'v1',topics:'v1'})
    type Work={references:Array<{id:string;matterId:string;messageId:string;kind:string}>;results:Array<{id:string;matterId:string;text:string}>}
    await expect.poll(async()=> (await desktop<Work>('GET','/v1/matter/owner-chat/work')).body.results.find(r=>r.matterId===taskId)?.text,{timeout:15_000}).toContain('写好了 NOTE.md。')
    const work=(await desktop<Work>('GET','/v1/matter/owner-chat/work')).body
    const reference=work.references.find(r=>r.matterId===taskId)!
    expect(reference).toMatchObject({id:`work:${taskId}`,kind:'task',messageId:expect.any(String)})
    const original=await desktop<{messages:Array<{messageId:string;text:string}>}>('GET',`/v1/matter/owner-chat/window?anchor=${encodeURIComponent(reference.messageId)}`)
    expect(original.status).toBe(200)
    expect(original.body.messages.find(m=>m.messageId===reference.messageId)?.text).toContain('写一份笔记')
    expect(new Set(work.results.map(r=>r.id)).size).toBe(work.results.length)

    // Same real daemon wiring as the desktop pet; selecting it remains read-only.
    expect((await desktop('GET','/v1/companion/pet')).status).toBe(403) // operator scope intentionally excludes this trusted read
    const pet = await desktop<{activities:Array<{taskId:string;title:string;phase:string}>}>('GET','/v1/companion/pet',undefined,'trusted')
    expect(pet.status).toBe(200)
    expect(pet.body.activities).toEqual(expect.arrayContaining([expect.objectContaining({taskId,phase:'replied'})]))
    expect(pet.body.activities.find(item=>item.taskId===taskId)?.title).toContain('写一份笔记')
    // 桌宠订的 presence 主题(S5)是同一份:处境 + 在做什么一起来;since 对不上(还没订过)⇒ 马上回
    const topic = await desktop<{cursor:number;presence:{presence:string}|null;pet:{activities:Array<{taskId:string;phase:string}>}|null}>('GET','/v1/subscribe/presence?since=0&wait_ms=20000',undefined,'trusted')
    expect(topic.status).toBe(200)
    expect(topic.body.presence).not.toBeNull()
    expect(topic.body.pet?.activities).toEqual(expect.arrayContaining([expect.objectContaining({taskId,phase:'replied'})]))
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
    const prompt = JSON.stringify(spawn, (key, value) => key === 'instance' ? undefined : value)
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
      // 回合记录从 M3b 起在这件对话的轮上(matter_turns,chatId = 这件对话的微信绑定),turn_records 不再写
      const CHAT_TURNS = "SELECT t.id FROM matter_turns t JOIN matter_bindings b ON b.matter_id = t.matter_id AND b.surface = 'wechat' WHERE b.surface_key = ?"
      const previousTurns = new Set(d.query<{ id: string }>(CHAT_TURNS, d.owner).map(t => t.id))
      d.sendText(d.owner, '还在吗')
      await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('Codex 在。')), 15_000)
      // Fake ilink exposes a reply before its HTTP response returns and the
      // canonical message is saved. Completed turns are recorded AFTER delivery;
      // drain this turn before the following eval snapshots exact message counts.
      await expect.poll(() => d.query<{ id: string }>(
        `${CHAT_TURNS} AND t.executor = 'codex' AND t.status = 'completed'`, d.owner,
      ).some(t => !previousTurns.has(t.id)), { timeout: 15_000 }).toBe(true)
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

  // S2(待发队列一个、退避一套;设计稿 docs/superpowers/specs/2026-11-04-s2-one-pending-queue-design.md)。从这里起「待说」那一拍
  // 改成 200ms 一拍(生产 5 分钟),几秒里就能看见补说 / 退避;别的照旧。
  // 这几条**各自从定好的起点开机**(rebootForS2:免打扰开 / 关、配没配手机、待发队列清空都在关机时写死),
  // 不靠上一条留下的状态 —— 一条红了不会把后面几条一起拖红(2026-11-04 windows-latest:派活那条在 win32 上红,
  // 免打扰一直开着,过期 / 断线两条跟着红)。

  it('quiet hours + restart: a report during 免打扰 waits in speech_pending (not sent), is still there after a reboot, and goes out once when the owner turns 免打扰 off', async () => {
    await rebootForS2({ quiet: true, phone: false })
    // 回报类的一句(自改进展):被推后 ⇒ 这一次照实回「没送到」,进待发队列
    expect(await desktop('POST', '/v1/self-change/notice', { text: QUIET_NOTE })).toMatchObject({ status: 502, body: { error: 'send_failed' } })
    expect(d.query("SELECT 1 FROM speech_pending WHERE lane = 'say' AND body = ?", QUIET_NOTE)).toHaveLength(1)
    await new Promise(r => setTimeout(r, 1_000))   // 几拍过去:那句话没进微信
    expect(texts(d.ilink.outbox(), d.owner).some(t => t.includes(QUIET_NOTE))).toBe(false)

    // 重启(免打扰照旧开着):还在
    await rebootForS2({ quiet: true, phone: false, keepPending: true })
    expect(d.query("SELECT 1 FROM speech_pending WHERE lane = 'say' AND body = ?", QUIET_NOTE)).toHaveLength(1)
    d.sendText(d.owner, '/set 免打扰 关')
    await d.waitForOutbound(m => texts(m, d.owner).includes('免打扰关了。'), 15_000)
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes(QUIET_NOTE)), 15_000)
    // 删行在发送返回之后(pending-notices.ts:说完才删),假 ilink 收到请求就记进外发箱 ⇒ 这里要等,不能当场查
    await expect.poll(() => d.query("SELECT 1 FROM speech_pending WHERE body = ?", QUIET_NOTE), { timeout: 5_000 }).toEqual([])
    await new Promise(r => setTimeout(r, 1_000))   // 只送一次
    expect(texts(d.ilink.outbox(), d.owner).filter(t => t.includes(QUIET_NOTE))).toHaveLength(1)
  })

  // win32 不跑:要一件做完的事,派给 Codex —— 同上面「workbench from WeChat」那条的理由(Codex 当工作台执行者在 Windows 上开头就拒绝,
  // 沙盒里没有能在 win32 上当工作台执行者的替身)。待说那一半(上一条)在 win32 上照跑。
  it.skipIf(process.platform === 'win32')('quiet hours + restart, App push: a task finishes during 免打扰 ⇒ its push is held in speech_pending, survives a reboot, and is pushed once when the owner turns 免打扰 off', async () => {
    await rebootForS2({ quiet: true, phone: true })
    d.sendText(d.owner, '任务 项目')
    const list = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('选择要工作的项目')), 15_000)   // 每次开机是新的假 ilink,外发箱从这次开机算
    const projectId = texts(list, d.owner).filter(t => t.includes('选择要工作的项目')).at(-1)!.match(/demo · (p-[a-f0-9]{20})/)![1]
    d.sendText(d.owner, `任务 新建 ${projectId} 用 @codex 再写一份笔记`)
    const ack = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.startsWith('已接下这件事')), 15_000)
    const taskId = texts(ack, d.owner).filter(t => t.startsWith('已接下这件事')).at(-1)!.match(/已接下这件事 · ([a-f0-9]{8})/)![1]!
    await expect.poll(async () => (await desktop<{ task: { phase: string } }>('GET', `/v1/workbench/task?id=${taskId}`)).body.task.phase, { timeout: 30_000 }).toBe('replied')
    // 微信里派的活做完了 ⇒ App 的「做完了」推送被门压着(report),落进待发队列,没推
    await expect.poll(() => d.query<{ kind: string }>("SELECT kind FROM speech_pending WHERE lane = 'push' AND ref LIKE ?", `task_done:%${taskId}%`).map(r => r.kind), { timeout: 15_000 }).toEqual(['matter_report'])
    await new Promise(r => setTimeout(r, 1_000))
    expect(pushesFor(taskId)).toEqual([])

    // 重启没丢(以前压着的推送只在内存里,重启就没了)
    await rebootForS2({ quiet: true, phone: true, keepPending: true })
    expect(d.query("SELECT 1 FROM speech_pending WHERE lane = 'push' AND ref LIKE ?", `task_done:%${taskId}%`)).toHaveLength(1)
    expect(pushesFor(taskId)).toEqual([])
    d.sendText(d.owner, '/set 免打扰 关')
    await d.waitForOutbound(m => texts(m, d.owner).includes('免打扰关了。'), 15_000)
    await expect.poll(() => pushesFor(taskId).length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => d.query("SELECT 1 FROM speech_pending WHERE lane = 'push'"), { timeout: 5_000 }).toEqual([])   // 同上:推完才删
    expect(d.query("SELECT 1 FROM speech_log WHERE kind = 'matter_report' AND outcome = 'allowed' AND channel = 'app'").length).toBeGreaterThan(0)
    await new Promise(r => setTimeout(r, 1_000))   // 只推一次
    expect(pushesFor(taskId)).toHaveLength(1)
  })

  it('expired item: an old notice carried over from speech/pending-notices.json is past its 24h ⇒ logged as expired in speech_log, never sent; a fresh one from the same file is said', async () => {
    const STALE = '两天前的回报:定时 j9 停了', FRESH = '刚才的回报:定时 j8 停了'
    const stateDir = await rebootForS2({ quiet: false, phone: false, beforeBoot: (dir) => {
      mkdirSync(join(dir, 'speech'), { recursive: true })
      writeFileSync(join(dir, 'speech', 'pending-notices.json'), JSON.stringify({
        items: [
          { id: 'legacy-stale', kind: 'job_notice', chatId: SANDBOX_OWNER, text: STALE, at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() },
          { id: 'legacy-fresh', kind: 'job_notice', chatId: SANDBOX_OWNER, text: FRESH, at: new Date(Date.now() - 60_000).toISOString() },
        ],
        dropped: {},
      }))
    } })
    expect(existsSync(join(stateDir, 'speech', 'pending-notices.json'))).toBe(false)
    expect(existsSync(join(stateDir, 'speech', 'pending-notices.json.migrated'))).toBe(true)
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes(FRESH)), 15_000)
    await expect.poll(() => d.query("SELECT 1 FROM speech_log WHERE kind = 'job_notice' AND outcome = 'dropped' AND reason = 'expired'").length, { timeout: 15_000 }).toBe(1)
    expect(texts(d.ilink.outbox(), d.owner).some(t => t.includes(STALE))).toBe(false)
    await expect.poll(() => d.query("SELECT 1 FROM speech_pending WHERE id IN ('legacy-stale', 'legacy-fresh')"), { timeout: 5_000 }).toEqual([])   // 说完才删(同上)
  })

  it('S4: two retained initiators due within 20h speak once; the loser stays unattempted and expires by its original deadline', async () => {
    await rebootForS2({ quiet: false, phone: false, beforeBoot(dir) {
      const db = openSqlite(join(dir, 'wechat-cc.db'))
      try {
        db.query("DELETE FROM speech_log WHERE origin='initiative'").run()
        const now = Date.now()
        for (const [id, kind, text, ttl] of [['s4-sticker', 'sticker', 'S4 new drawing', 6], ['s4-story', 'social_story', 'S4 kept story', 24]] as const) {
          db.query("INSERT INTO speech_pending(id,lane,chat_id,kind,body,created_at,next_at,expires_at,status) VALUES(?,'say',?,?,?,?,0,?,'pending')").run(id, SANDBOX_OWNER, kind, text, now, now + ttl * 3600_000)
        }
      } finally { db.close() }
    } })
    await expect.poll(() => d.query("SELECT spoken_at FROM speech_log WHERE origin='initiative' AND spoken_at IS NOT NULL").length, { timeout: 15_000 }).toBe(1)
    expect(texts(d.ilink.outbox(), d.owner)).toContain('S4 new drawing')
    expect(texts(d.ilink.outbox(), d.owner)).not.toContain('S4 kept story')
    await expect.poll(() => d.query("SELECT id,attempts,next_at FROM speech_pending WHERE lane='say' ORDER BY id"), { timeout: 5_000 }).toEqual([{ id: 's4-story', attempts: 0, next_at: 0 }])
    // Advance the source's persisted deadline to model expiry during sleep;
    // keep the successful delivery fact and its still-active twenty-hour budget.
    await rebootForS2({ quiet: false, phone: false, keepPending: true, beforeBoot(dir) {
      const db = openSqlite(join(dir, 'wechat-cc.db'))
      try { db.query("UPDATE speech_pending SET expires_at=? WHERE id='s4-story'").run(Date.now() - 1) } finally { db.close() }
    } })
    await expect.poll(() => d.query("SELECT 1 FROM speech_log WHERE kind='social_story' AND reason='expired'").length, { timeout: 15_000 }).toBe(1)
    expect(texts(d.ilink.outbox(), d.owner)).not.toContain('S4 kept story')
    expect(d.query("SELECT 1 FROM speech_log WHERE origin='initiative' AND spoken_at IS NOT NULL")).toHaveLength(1)
  })

  it('S4 operations: audit CLI reads the real-shaped ledger and persisted picker outcomes without changing it', () => {
    const before = d.query('SELECT COUNT(*) AS n,MAX(id) AS last FROM speech_log')
    const output = execFileSync(process.execPath, ['cli.ts', 'speech', 'audit', '--db', join(d.stateDir, 'wechat-cc.db'), '--days', '7', '--json'], { encoding: 'utf8', env: { ...process.env, WECHAT_STATE_DIR: d.stateDir } })
    const audit = JSON.parse(output)
    expect(audit.completeWindow).toBe(false)
    expect(audit.coverageStartedAt).toBeGreaterThan(0)
    expect(audit.sources.some((s: { outcome: string; count: number }) => s.outcome === 'allowed' && s.count > 0)).toBe(true)
    expect(audit.sources.some((s: { outcome: string; count: number }) => s.outcome === 'deferred' && s.count > 0)).toBe(true)
    expect(audit.suspectedBypass).toEqual([])
    expect(audit.intervalViolations).toEqual([])
    expect(d.query('SELECT COUNT(*) AS n,MAX(id) AS last FROM speech_log')).toEqual(before)
  })

  it('S4: a due fixed-time brief sends inside the occupied interval, is counted, and keeps ordinary initiatives waiting', async () => {
    // 只固定墙钟,HTTP / 模型替身 / 轮询都用真实计时器。生产 runner 仍自行调度,仅把一分钟缩成 200ms。
    // CI #878 恰在上海 00:00:31:旧夹具 now-1min 得到 23:59,当天尚未到点;等再久也不会在这一拍发。
    vi.setSystemTime(new Date())
    try {
      const prior = d.query<{ at: number }>("SELECT MAX(spoken_at) AS at FROM speech_log WHERE origin='initiative'")[0]!.at
      expect(Date.now() - prior).toBeLessThan(20 * 3600_000)
      await rebootForS2({ quiet: false, phone: false, timedJobs: true, beforeBoot(dir) {
        writeFileSync(join(dir, 'scheduled-jobs.json'), fixedBriefJobs(Date.now()))
        const db = openSqlite(join(dir, 'wechat-cc.db'))
        try {
          db.query("INSERT INTO speech_pending(id,lane,chat_id,kind,body,created_at,next_at,expires_at,status) VALUES('s4-after-brief','say',?,'social_story','S4 after brief',?,0,?,'pending')").run(SANDBOX_OWNER, Date.now(), Date.now() + 24 * 3600_000)
        } finally { db.close() }
      } })
      await expect.poll(() => d.query<{ spoken_at: number }>("SELECT spoken_at FROM speech_log WHERE kind='brief' AND spoken_at IS NOT NULL"), { timeout: 15_000 }).toHaveLength(1)
      await expect.poll(() => JSON.parse(readFileSync(join(d.stateDir, 'scheduled-jobs-state.json'), 'utf8')).jobs.j991.lastStatus, { timeout: 5_000 }).toBe('sent')
      expect(texts(d.ilink.outbox(), d.owner).filter(t => t === FIXED_BRIEF_REPLY)).toHaveLength(1)
      const briefAt = d.query<{ spoken_at: number }>("SELECT spoken_at FROM speech_log WHERE kind='brief'")[0]!.spoken_at
      expect(briefAt).toBeGreaterThan(prior)
      expect(d.query("SELECT 1 FROM speech_log WHERE origin='initiative' AND spoken_at IS NOT NULL")).toHaveLength(2)
      expect(d.query("SELECT id,attempts FROM speech_pending WHERE id='s4-after-brief'")).toEqual([{ id: 's4-after-brief', attempts: 0 }])
      expect(texts(d.ilink.outbox(), d.owner)).not.toContain('S4 after brief')
    } finally {
      // SpeechPolicy 等组件会捕获 Date.now;还原后立即停掉这次开机,下一条重新开机,不复用冻结的函数。
      // 关机自己也有 Date.now 截止时间,因此先还原。
      vi.useRealTimers()
      await d.stop({ keepState: true })
    }
  })

  it('S4: requested reminder, report and blocking still deliver inside the initiative interval without moving its fact', async () => {
    // 上一条保留了同一份状态;用真实墙钟重新开机,提醒仍由生产 sweeper 自行投递。
    d = await boot({ stateDir: d.stateDir, speechFlushIntervalMs: 200, reminderIntervalMs: 200 })
    const initiativeAt = d.query<{ at: number }>("SELECT MAX(spoken_at) AS at FROM speech_log WHERE origin='initiative'")[0]!.at
    expect(await desktop('POST', '/v1/self-change/notice', { text: 'S4 report during interval' })).toMatchObject({ status: 200 })
    expect(await desktop('POST', '/v1/self-change/ask', { prompt: 'S4 approval during interval', timeoutMs: 60_000 })).toMatchObject({ status: 200, body: { delivered: true } })
    expect(await desktop('POST', '/v1/reminders/schedule', { chat_id: d.owner, text: 'S4 requested reminder', due_at: new Date(Date.now() - 1_000).toISOString() })).toMatchObject({ status: 200, body: { ok: true } })
    await expect.poll(() => texts(d.ilink.outbox(), d.owner).some(t => t.includes('S4 requested reminder')), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => d.query("SELECT DISTINCT origin FROM speech_log WHERE kind IN ('self_change_progress','self_change_ask','reminder') AND spoken_at IS NOT NULL ORDER BY origin"), { timeout: 5_000 }).toEqual([{ origin: 'blocking' }, { origin: 'report' }, { origin: 'requested' }])
    expect(d.query<{ at: number }>("SELECT MAX(spoken_at) AS at FROM speech_log WHERE origin='initiative'")[0]!.at).toBe(initiativeAt)
    expect(texts(d.ilink.outbox(), d.owner)).not.toContain('S4 after brief')
  })

  it('offline: WeChat is down ⇒ a report that cannot go out is kept to say later, and the pending flush backs off on the shared backoff (first retry after 1 min) instead of hitting the link every tick', async () => {
    // 没配手机:有能收的 App 时,微信发不出去会落到 App(那是另一条路);这里只看微信断了的时候
    await rebootForS2({ quiet: false, phone: false })
    d.ilink.failSendMessage({ errcode: -1, errmsg: 'network unreachable' })
    try {
      const NOTE = '自改进展:断线的时候说的这一句'
      const attempts = () => d.ilink.failedSends().filter(m => m.chatId === d.owner && m.text === NOTE).length
      // 门放行、发失败 ⇒ 这一次照实回「没送到」,话进待说队列
      expect(await desktop('POST', '/v1/self-change/notice', { text: NOTE })).toMatchObject({ status: 502, body: { error: 'send_failed' } })
      await expect.poll(() => d.log().some(l => /self_change_progress chat=\S+ kept to say later/.test(l)), { timeout: 15_000 }).toBe(true)
      expect(attempts()).toBeGreaterThan(0)
      // 下一拍补说:要么送不到被门推后,要么又试了一次、失败、进退避 —— 二者之一出现过
      await expect.poll(() => d.log().some(l => /pending notices chat=\S+ send failed \(try 1\)|self_change_progress chat=\S+ deferred: undeliverable/.test(l)), { timeout: 15_000 }).toBe(true)
      const settled = attempts()
      expect(settled).toBeLessThanOrEqual(6)   // 当场那一次 + 至多一次补说,每次线上那一层 1 秒 × 3(不动)
      await new Promise(r => setTimeout(r, 3_000))   // 刻意等「什么都没发生」:15 拍左右,退避第一档是 1 分钟
      expect(attempts()).toBe(settled)
      // 那句话在主库的待发队列里等着(S2b),没丢
      expect(d.query<{ lane: string; kind: string }>("SELECT lane, kind FROM speech_pending WHERE body = ?", NOTE)).toEqual([{ lane: 'say', kind: 'self_change_progress' }])
    } finally {
      d.ilink.succeedSendMessage()
    }
  })

  // S3a(一个事件账上一行;设计稿 docs/superpowers/specs/2026-11-05-s3-one-proposal-design.md):同一件事今天有几条路各自问门
  // (App 推送、微信通知、回原对话的回报),问门时带同一个事件键,speech_log 里就只有一行。
  // win32 不跑:要 Codex 在工作台里做一件事 —— 同上面「workbench from WeChat」那条的理由。
  it.skipIf(process.platform === 'win32')('one event, one ledger row: a task asks for approval ⇒ the App push and the WeChat notice are one speech_log row (app+wechat); the task finishing ⇒ one row for that turn', async () => {
    await rebootForS2({ quiet: false, phone: true })
    const since = Date.now()
    d.sendText(d.owner, '任务 项目')
    const list = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('选择要工作的项目')), 15_000)
    const projectId = texts(list, d.owner).filter(t => t.includes('选择要工作的项目')).at(-1)!.match(/demo · (p-[a-f0-9]{20})/)![1]
    d.sendText(d.owner, `任务 新建 ${projectId} 用 @codex 再写一份笔记`)
    const ack = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.startsWith('已接下这件事')), 15_000)
    const taskId = texts(ack, d.owner).filter(t => t.startsWith('已接下这件事')).at(-1)!.match(/已接下这件事 · ([a-f0-9]{8})/)![1]!
    await expect.poll(async () => (await desktop<{ task: { phase: string } }>('GET', `/v1/workbench/task?id=${taskId}`)).body.task.phase, { timeout: 30_000 }).toBe('replied')
    // 「做完了」:App 推了一次;账上这一轮只有一行,键是这件事的那一轮
    await expect.poll(() => pushesFor(taskId).length, { timeout: 15_000 }).toBe(1)
    const rows = () => d.query<{ kind: string; ref: string | null; outcome: string; channel: string | null }>(
      "SELECT kind, ref, outcome, channel FROM speech_log WHERE at >= ? AND kind IN ('matter_report', 'permission_ask') ORDER BY id", since)
    await expect.poll(() => rows().filter(r => r.ref?.startsWith(`turn:${taskId}:`)), { timeout: 15_000 })
      .toEqual([{ kind: 'matter_report', ref: expect.stringMatching(new RegExp(`^turn:${taskId}:\\d+$`)), outcome: 'allowed', channel: 'app' }])
    await new Promise(r => setTimeout(r, 1_000))   // 回报那一路(回原对话)主人刚说过话 ⇒ 晚些再发;发了也并进同一行。这里看「没有第二行」
    expect(rows().filter(r => r.kind === 'matter_report')).toHaveLength(1)
    expect(pushesFor(taskId)).toHaveLength(1)

    // 「等你批准」(blocking,照旧各处都推):App 推一次、微信里一张卡,账上一行,通道两个
    d.sendText(d.owner, `任务 新建 ${projectId} 用 @codex 把 build 删了`)
    const ack2 = await d.waitForOutbound(m => texts(m, d.owner).filter(t => t.startsWith('已接下这件事')).length >= 2, 15_000)
    const asking = texts(ack2, d.owner).filter(t => t.startsWith('已接下这件事')).at(-1)!.match(/已接下这件事 · ([a-f0-9]{8})/)![1]!
    await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes(`· ${asking}`) && t.includes('需要你批准')), 30_000)
    await expect.poll(() => pushesFor(asking).length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => rows().filter(r => r.ref?.startsWith(`ask:${asking}:`)), { timeout: 15_000 })
      .toEqual([{ kind: 'permission_ask', ref: expect.stringMatching(new RegExp(`^ask:${asking}:`)), outcome: 'allowed', channel: expect.stringMatching(/^(app\+wechat|wechat\+app)$/) }])
    expect(rows().filter(r => r.kind === 'permission_ask')).toHaveLength(1)
  })

  // S3b(一件事一次提议;主人点头的「任务做完时人在电脑前 ⇒ 先只在桌面提示,10 分钟没看再推手机」):沙盒里 10 分钟缩成 2 秒。
  // 桌面 app 开着(这里每拍拉一次 attention,和桌面一样)⇒ 桌面那一级由它自己弹,daemon 不另弹(沙盒里也就不会真弹系统通知)。
  // 这里**不**用 GET /v1/workbench/task 等状态 —— 桌面读详情就算「在电脑上看过了」;等状态看 attention 里的 progress。
  // win32 不跑:要 Codex 在工作台里做完一件事 —— 同上。
  it.skipIf(process.platform === 'win32')('owner at the desk: a finished task is shown on the desktop only; the App push waits, goes out once when nobody looked (one ledger row: desktop+app), and never goes out when the owner opened it on the desktop', async () => {
    await rebootForS2({ quiet: false, phone: true, atDesk: true })
    const since = Date.now()
    const phaseOf = async (taskId: string) => (await desktop<{ progress?: Array<{ id: string; phase: string }> }>('GET', '/v1/workbench/attention')).body.progress?.find(p => p.id === taskId)?.phase
    d.sendText(d.owner, '任务 项目')
    const list = await d.waitForOutbound(m => texts(m, d.owner).some(t => t.includes('选择要工作的项目')), 15_000)
    const projectId = texts(list, d.owner).filter(t => t.includes('选择要工作的项目')).at(-1)!.match(/demo · (p-[a-f0-9]{20})/)![1]
    const dispatch = async (n: number, what: string) => {
      d.sendText(d.owner, `任务 新建 ${projectId} 用 @codex ${what}`)
      const ack = await d.waitForOutbound(m => texts(m, d.owner).filter(t => t.startsWith('已接下这件事')).length >= n, 15_000)
      const id = texts(ack, d.owner).filter(t => t.startsWith('已接下这件事')).at(-1)!.match(/已接下这件事 · ([a-f0-9]{8})/)![1]!
      await expect.poll(() => phaseOf(id), { timeout: 30_000 }).toBe('replied')
      return id
    }
    const row = (taskId: string) => d.query<{ ref: string; outcome: string; channel: string | null }>("SELECT ref, outcome, channel FROM speech_log WHERE at >= ? AND ref LIKE ?", since, `turn:${taskId}:%`)

    // 没人看:做完那一刻只在桌面(账上一行,通道 desktop),App 那一条在 speech_pending 里等;2 秒后推一次,账还是那一行(desktop+app)
    const unseen = await dispatch(1, '再写一份笔记')
    await expect.poll(() => row(unseen).map(r => r.channel), { timeout: 15_000 }).toEqual(['desktop'])
    expect(pushesFor(unseen)).toEqual([])
    expect(d.query("SELECT 1 FROM speech_pending WHERE lane = 'push' AND ref LIKE ?", `later:task_done:${unseen}%`)).toHaveLength(1)
    await expect.poll(() => pushesFor(unseen).length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => row(unseen), { timeout: 5_000 }).toEqual([{ ref: expect.stringMatching(new RegExp(`^turn:${unseen}:\\d+$`)), outcome: 'allowed', channel: 'desktop+app' }])
    await expect.poll(() => d.query("SELECT 1 FROM speech_pending WHERE lane = 'push'"), { timeout: 5_000 }).toEqual([])   // 推完才删

    // 在桌面上打开看了(桌面读这件事的详情):到点不推,等着的那一条清掉;账一行,通道只有 desktop
    const seen = await dispatch(2, '写第三份笔记')
    await expect.poll(() => row(seen).map(r => r.channel), { timeout: 15_000 }).toEqual(['desktop'])
    expect((await desktop('GET', `/v1/matter?id=${seen}`)).status).toBe(200)
    await expect.poll(() => d.log().some(l => new RegExp(`push not escalated — seen on desktop \\(later:task_done:${seen}`).test(l)), { timeout: 15_000 }).toBe(true)
    expect(d.query("SELECT 1 FROM speech_pending WHERE lane = 'push'")).toEqual([])
    await new Promise(r => setTimeout(r, 1_000))
    expect(pushesFor(seen)).toEqual([])
    expect(row(seen).map(r => r.channel)).toEqual(['desktop'])
    expect(pushesFor(unseen)).toHaveLength(1)

    // S3c:详情已在屏幕上,完成后桌面显式确认;不靠再次读取详情。
    const foreground = await dispatch(3, '写第四份笔记')
    await expect.poll(() => row(foreground).map(r => r.channel), { timeout: 15_000 }).toEqual(['desktop'])
    expect((await desktop('POST', '/v1/matter/seen', { id: foreground, surface: 'desktop' })).status).toBe(200)
    for (let i = 0; i < 2; i++) expect((await desktop('POST', '/v1/matter/seen', { id: foreground })).status).toBe(200)
    await expect.poll(() => d.log().some(l => l.includes('push not escalated — seen on desktop') && l.includes(foreground)), { timeout: 15_000 }).toBe(true)
    expect(pushesFor(foreground)).toEqual([])
    expect(row(foreground).map(r => r.channel)).toEqual(['desktop'])
    expect(d.query("SELECT 1 FROM speech_pending WHERE lane = 'push'")).toEqual([])
  })

  it('S4 clock: the due brief fixture sends once at the exact Shanghai midnight that failed in CI', async () => {
    // 独立于上面那条时间线,可单独 -t 复现。不能只缩短 tick:旧 now-60s 夹具在这个时刻永远等不到当天早报。
    await d.stop()
    const at = Date.parse('2026-11-08T16:00:31.912Z') // 上海 11-09 00:00:31.912,CI #878 的开机时刻
    vi.setSystemTime(at)
    try {
      d = await startRealShapedDaemon({
        claudeScript,
        scheduledJobsIntervalMs: 200,
        seedFiles: { 'scheduled-jobs.json': fixedBriefJobs(at) },
      })
      await expect.poll(() => d.query("SELECT spoken_at FROM speech_log WHERE kind='brief' AND spoken_at IS NOT NULL"), { timeout: 15_000 }).toEqual([{ spoken_at: at }])
      await expect.poll(() => JSON.parse(readFileSync(join(d.stateDir, 'scheduled-jobs-state.json'), 'utf8')).jobs.j991, { timeout: 5_000 }).toMatchObject({ lastRunDay: '2026-11-09', lastStatus: 'sent', failStreak: 0 })
      expect(texts(d.ilink.outbox(), d.owner).filter(t => t === FIXED_BRIEF_REPLY)).toHaveLength(1)
      await new Promise(r => setTimeout(r, 600)) // 再过三拍:同一日只发一次
      expect(d.query("SELECT spoken_at FROM speech_log WHERE kind='brief' AND spoken_at IS NOT NULL")).toEqual([{ spoken_at: at }])
      expect(texts(d.ilink.outbox(), d.owner).filter(t => t === FIXED_BRIEF_REPLY)).toHaveLength(1)
      expect(unexpectedOutbound(d.fence.blocked())).toEqual([])
    } finally {
      vi.useRealTimers()
      await d.stop()
    }
  })
})

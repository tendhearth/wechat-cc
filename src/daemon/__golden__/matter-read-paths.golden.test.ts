/**
 * 「做事」读路径金样(设计稿 docs/superpowers/specs/2026-10-31-one-companion-one-skeleton-design.md §4 M0)。
 *
 * M 线要把今天的四套存法(workbench_events / run_execution / turn_usage、turn_records、终端每次重解析 transcript、
 * matter 详情现拼)换成 matter → turn → item。换之前先把客户端今天看到的东西逐字节钉住,M2–M6 每一步都拿它证明
 * 「产出没变」:
 *
 *   /v1/workbench/task    桌面工作台详情       workbenchRoutes(真 WorkbenchService)
 *   /v1/matter            桌面「一件事」详情    mattersRoutes(真 MattersService)
 *   /m/api/matter         手机「一件事」详情    makeSettingsPanel().handleRequest(设备令牌,同中继转进来的那一口)
 *   /m/api/chat           手机主人对话一页      同上
 *   /m/api/cli/activity   手机看终端会话几步    同上(cliActions = 真 makeCliPhoneActions + 真 CliEventHub + 真 steps,M6a)
 *   /m/api/cli/sessions   手机终端会话列表      同上(带 matter_id 与在跑那条的 now)
 *   /m/api/matters        手机「一件事」列表    同上(默认与 ?kind=act)
 *   终端 / act 那件事     /v1/matter、/m/api/matter(终端会话那件事;信那件 act,经 makeCcActs 写)
 *   topic matter/<id>     App 订阅的快照        makePhoneEventsWiring(daemon 同一份接线)订阅后收到的第一帧
 *
 * 接缝:路由处理器(桌面)/ 面板的 handleRequest(手机)/ 事件集线器的 subscribe(App topic)——都在 M 线要重写的
 * 表、store、service.detail() 与拼装代码**之上**。夹具经生产的写口灌进去:工作台走 create / resolvePermission /
 * continueTask(执行者是照剧本说话的假执行者,执行者那一侧 M 线不动),对话走 messagesStore.append,终端走 hub.ingest。
 *
 * 规整(只动真的不确定的):
 *   - 临时目录 ⇒ `<tmp>`;
 *   - 生成的 id:任务 / 一件事的 8 位 id ⇒ `<task:名字>` / `<chat>`;其余 UUID(runId、权限 / 提问 id、集线器 epoch……)
 *     按全局第一次出现的顺序 ⇒ `<uuid:N>`;终端那件事 ⇒ `<terminal>`;轮的 16 位 id 按 cursor 顺序 ⇒ `<turn:N>`
 *     (信那件 act 的 id 由名字定,本来就确定,不规整)。
 *   - 时间不规整:Date 用 vitest 假时钟钉死,每一步手动拨(见 at()),时间戳本身就是确定的。
 *
 * 红了先想是不是改到了客户端看得见的东西。确实要变(设计稿 §8 第 5 条:改它的那个 PR 里重录并逐行说明):
 *   UPDATE_MATTER_GOLDEN=1 bun --bun vitest run src/daemon/__golden__/matter-read-paths.golden.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestDb, type Db } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { createProviderRegistry } from '../../app/provider-registry'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMattersService } from '../../app/matters/service'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { makeWorkbenchService, type WorkbenchService } from '../../features/workbench/service'
import { workbenchRoutes } from '../../features/workbench/routes'
import { MANAGED_NATIVE_CAPABILITIES } from '../../domain/workbench/executor-capabilities'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { makePhoneChat, makePhoneOwner } from '../../features/phone'
import { makePhoneEventsWiring } from '../../features/phone/phone-topic-sources'
import { mattersRoutes } from '../internal-api/routes-matters'
import type { InternalApiDeps, RouteTable } from '../internal-api/types'
import { ownerChatReadingEvent } from '../wiring/owner-chat-reading'
import { makeCliEventHub, type CliEventHub } from '../../app/cli-events'
import { makeCliSessionStore } from '../../adapters/store/cli-session-store'
import { makeCliPhoneActions } from '../../features/terminal/phone-actions'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeTerminalTurnLog } from '../../adapters/store/terminal-turns'
import { makeTerminalStepStore } from '../../adapters/store/terminal-steps'
import { makeTerminalSteps, withTranscriptSteps } from '../../features/terminal/terminal-steps'
import { makeCcActs } from '../../adapters/store/cc-acts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, 'matter-read-paths')
const UPDATE = process.env.UPDATE_MATTER_GOLDEN === '1'

const OWNER = 'o9golden-owner@im.wechat'
const MACHINE = 'golden-mac'
/** 2026-10-31 10:00 北京时间。每一步 at(n) 拨到 T0 + n 分钟。 */
const T0 = Date.UTC(2026, 9, 31, 2, 0, 0)
const at = (minute: number) => vi.setSystemTime(T0 + minute * 60_000)

let root = ''
let db: Db
let workbench: WorkbenchService
let panel: SettingsPanel
let deviceToken = ''
let hub: CliEventHub
let desktopMatters: RouteTable
let desktopWorkbench: RouteTable
let topics: ReturnType<typeof makePhoneEventsWiring>
const ids: Record<'done' | 'permission' | 'question' | 'chat' | 'terminal', string> = { done: '', permission: '', question: '', chat: '', terminal: '' }
/** 信那件事的 id 由发起方名字定(cc-acts.ts 的 ccActMatterId),本来就是确定的,不规整。 */
let actId = ''
let matterStore: ReturnType<typeof makeMatterStore>

// ── 照剧本说话的假执行者 ─────────────────────────────────────────────
/** 测试拿着的闸门:执行者走到 hold(name) 就停,直到测试 open(name)。 */
const gates = new Map<string, { promise: Promise<void>; open: () => void }>()
const gate = (name: string) => {
  let g = gates.get(name)
  if (!g) { let open!: () => void; const promise = new Promise<void>(r => { open = r }); g = { promise, open }; gates.set(name, g) }
  return g
}
const turnsSeen = new Map<string, number>()

function registerScriptedClaude(registry: ReturnType<typeof createProviderRegistry>) {
  registry.register('claude', { async spawn(project, ctx) {
    const name = project.path.split('/').pop()!
    return {
      async *dispatch(text: string) {
        const turn = (turnsSeen.get(name) ?? 0) + 1
        turnsSeen.set(name, turn)
        yield { kind: 'init' as const, sessionId: `native-${name}` }
        if (name === 'done' && turn === 1) {
          yield { kind: 'text' as const, text: '先跑一遍测试。' }
          yield { kind: 'tool_call' as const, tool: 'Bash', activity: { id: 'call-1', type: 'command' as const, status: 'completed' as const, label: 'bun test', detail: '12 pass' } }
          const ok = await ctx.requestPermission!({ tool: 'Bash', description: 'Delete scratch.txt', command: 'rm scratch.txt', cwd: project.path })
          yield { kind: 'tool_call' as const, tool: 'Bash', activity: { id: 'call-2', type: 'command' as const, status: ok ? 'completed' as const : 'failed' as const, label: 'rm scratch.txt' } }
          await gate('done:artifact').promise
          yield { kind: 'text' as const, text: '测试全过,报告写好了。' }
        } else if (name === 'done') {
          yield { kind: 'text' as const, text: `第 ${turn} 轮:${text} —— 确认过了。` }
        } else if (name === 'permission') {
          yield { kind: 'tool_call' as const, tool: 'Read', activity: { id: 'call-1', type: 'read' as const, status: 'completed' as const, label: 'package.json' } }
          await ctx.requestPermission!({ tool: 'Bash', description: 'Run the migration against the local db', command: 'bun run migrate', cwd: project.path })
          yield { kind: 'text' as const, text: '迁移跑完了。' }
        } else if (name === 'question') {
          yield { kind: 'text' as const, text: '动手之前先问一句。' }
          await ctx.requestUserInput!({ questions: [{ id: 'q-scope', header: '范围', question: '只改 README,还是连 docs 一起?', options: [{ label: '只改 README', description: '改动最小' }, { label: '连 docs 一起', description: '一次改齐' }], multiSelect: false, allowOther: true }] })
          yield { kind: 'text' as const, text: '好的。' }
        }
        // 做完的那件每轮报用量(workbench_turn_usage → task.usage 汇总,M2 要搬的那张表)
        yield { kind: 'result' as const, sessionId: `native-${name}`, numTurns: turn, durationMs: 1000, ...(name === 'done' ? { usage: { input: 1200 * turn, output: 300 * turn, cacheRead: 800 } } : {}) }
      },
      async close() {},
    }
  } }, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
}

/** 等到条件成立(不用 expect.poll:它的超时按 Date 算,而 Date 被钉住了)。 */
async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const settled = (id: string) => { const s = workbench.detail(id).task.status; return s !== 'queued' && s !== 'running' }

// ── 夹具 ────────────────────────────────────────────────────────────
async function seedTasks(): Promise<void> {
  // (1) 做完了的一起做:两轮;第一轮一次工具调用 + 一张批了的权限卡 + 一份成果
  at(1)
  const done = join(root, 'projects', 'done'); mkdirSync(done, { recursive: true })
  ids.done = workbench.create({ title: '修好测试并写报告', path: done, providerId: 'claude', text: '把测试修好,写一份报告' }).id
  await until('done: permission asked', () => { const d = workbench.detail(ids.done); return d.permissions.length === 1 && d.events.some(e => e.kind === 'system') })
  at(2)
  workbench.resolvePermission(ids.done, workbench.detail(ids.done).permissions[0]!.id, 'allow')
  // 批过之后执行者接着出一步(rm);等它落库再拨钟,不然它的时间戳看谁跑得快
  await until('done: permission resolved', () => workbench.detail(ids.done).events.some(e => e.text === 'rm scratch.txt'))
  // 成果:执行者写进本任务的成果目录,本轮结束时登记
  const out = join(done, '.cc-workbench', ids.done)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'report.md'), '# 测试报告\n\n12 个测试全过。\n')
  at(3)
  gate('done:artifact').open()
  await until('done: turn 1 settled', () => settled(ids.done))
  at(5)
  workbench.continueTask(ids.done, '再确认一次')
  await until('done: turn 2 settled', () => turnsSeen.get('done') === 2 && settled(ids.done))

  // (2) 卡在一张权限卡上
  at(10)
  const permission = join(root, 'projects', 'permission'); mkdirSync(permission, { recursive: true })
  ids.permission = workbench.create({ title: '跑迁移', path: permission, providerId: 'claude', text: '跑一下数据库迁移' }).id
  await until('permission: asked', () => { const d = workbench.detail(ids.permission); return d.permissions.length === 1 && d.events.some(e => e.kind === 'system') })

  // (3) 卡在一个提问上
  at(12)
  const question = join(root, 'projects', 'question'); mkdirSync(question, { recursive: true })
  ids.question = workbench.create({ title: '改文档', path: question, providerId: 'claude', text: '把安装说明改一下' }).id
  await until('question: asked', () => { const d = workbench.detail(ids.question); return d.questions.length === 1 && d.events.some(e => e.kind === 'system') })
}

async function seedOwnerChat(messages: ReturnType<typeof makeMessagesStore>, matters: ReturnType<typeof makeMatterStore>): Promise<void> {
  // (4) 主人那条对话:微信进来的入站中间件建它(origin wechat),各表面的话进同一张 messages 表
  at(20)
  ids.chat = matters.ensureChat(OWNER, undefined, 'wechat').id
  const iso = (minute: number, sec = 0) => new Date(T0 + minute * 60_000 + sec * 1000).toISOString()
  const rows = [
    { id: 'm-01', ts: iso(20), direction: 'in' as const, kind: 'text', text: '早,今天帮我盯一下迁移', source: 'live' },
    { id: 'm-02', ts: iso(20, 8), direction: 'out' as const, kind: 'text', text: '早。迁移那件我在看,有卡住的地方叫你。', source: 'live', provider: 'claude' },
    { id: 'm-03', ts: iso(21), direction: 'in' as const, kind: 'text', text: '报告发我一份', source: 'phone' },
    { id: 'm-04', ts: iso(21, 12), direction: 'out' as const, kind: 'text', text: '发了,在附件里。', source: 'phone', provider: 'claude',
      extras: JSON.stringify({ narration: ['找到报告', '打包'], attachments: [{ kind: 'file', name: 'report.md', path: join(root, 'projects', 'done', 'report.md') }, { kind: 'voice', text: '报告发你了' }] }) },
    { id: 'm-05', ts: iso(22), direction: 'in' as const, kind: 'text', text: '收到,谢谢', source: 'desktop' },
    { id: 'm-06', ts: iso(22, 5), direction: 'out' as const, kind: 'text', text: '', source: 'desktop', provider: 'claude' },
  ]
  for (const r of rows) await messages.append({ chatId: OWNER, ...r })
}

function seedCliSession(): string {
  // (5) 终端里的 Claude Code 会话:hook 报来 prompt(带 transcript 路径),手机读记录尾巴
  at(30)
  const dir = join(root, 'cli'); mkdirSync(dir, { recursive: true })
  const path = join(dir, 'claude-session.jsonl')
  const T = (sec: number) => new Date(T0 + 30 * 60_000 + sec * 1000).toISOString()
  const L = (o: object) => JSON.stringify(o)
  writeFileSync(path, [
    L({ type: 'user', timestamp: T(0), message: { role: 'user', content: '登录页报 500,修一下' } }),
    L({ type: 'assistant', timestamp: T(3), message: { role: 'assistant', content: [{ type: 'text', text: '先看日志。' }, { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'tail -n 50 logs/server.log', description: '看服务端日志' } }] } }),
    L({ type: 'user', timestamp: T(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'TypeError: user is undefined\n    at login (src/auth.ts:42)' }] } }),
    L({ type: 'assistant', timestamp: T(8), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/w/app/src/auth.ts' } }] } }),
    L({ type: 'user', timestamp: T(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: '…' }] } }),
    L({ type: 'assistant', timestamp: T(12), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-3', name: 'Edit', input: { file_path: '/w/app/src/auth.ts', old_string: 'const name = user.name', new_string: 'const name = user?.name ?? \'\'' } }] } }),
    L({ type: 'user', timestamp: T(13), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'ok' }] } }),
    L({ type: 'assistant', timestamp: T(15), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-4', name: 'Bash', input: { command: 'bun test src/auth.test.ts' } }] } }),
    L({ type: 'user', timestamp: T(20), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-4', is_error: true, content: '1 fail\nexpected 200, got 401' }] } }),
    L({ type: 'assistant', timestamp: T(25), message: { role: 'assistant', content: [{ type: 'text', text: '500 修好了;还有一个 401 的测试没过,要接着看吗?' }] } }),
  ].join('\n') + '\n')
  hub.ingest({ source: 'claude', kind: 'prompt', session_id: 'cli-golden-1', cwd: '/w/app', machine: MACHINE, transcript_path: path })
  // 钩子进来那一刻生产就建了这件事(terminal-turns 的 ensure)并把记录读进步(withTranscriptSteps)
  ids.terminal = matterStore.findBySurface('cli', 'cli-golden-1')?.id ?? ''
  if (!ids.terminal) throw new Error('terminal matter not created')
  // 步真的读进来了 ⇒ steps.view 不会回 null,activity 走的是步而不是退路解析
  const steps = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM matter_items WHERE matter_id=? AND kind IN ('user_message','agent_message','tool_call')").get(ids.terminal)?.n ?? 0
  if (steps !== 7) throw new Error(`terminal steps not imported: ${steps}`)
  return 'cli-golden-1'
}

function seedLetterAct(db: Db): void {
  // (6) CC 自己做的一件事:信(M5b)。照 features/letters/wire.ts 建 makeCcActs,照 runtime.ts 的 actTurn / filed / deliverIn 写一轮
  const acts = makeCcActs({ db, log: makeMatterLog(db), matters: makeMatterStore(db), onError: (what, err) => { throw new Error(`${what}: ${String(err)}`) } })
  at(32)
  const t = acts.begin('letters', { startedAt: Date.now(), policy: { trigger: 'owner' } })
  t.step('artifact', { letter: 'letter-golden-1', pages: 2, chars: 480, opening: '大人:' })
  at(33)
  t.step('delivery', { letter: 'letter-golden-1', result: 'sent', via: 'wechat' }, { status: 'completed' })
  t.finish('completed', { endedAt: Date.now() })
  actId = acts.matterIdOf('letters')
}

// ── 组装(照 daemon/wiring 的 pipeline-deps / wire-phone / wire-settings-panel)────────────
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(0)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-golden-')))
  db = openTestDb()
  const matters = makeMatterStore(db)
  matterStore = matters
  const messages = makeMessagesStore(db)
  const registry = createProviderRegistry()
  registerScriptedClaude(registry)
  workbench = makeWorkbenchService({
    store: makeWorkbenchStore(db), registry, stateDir: root, managedWorkspaceRoot: join(root, 'managed'),
    ownerChatId: () => OWNER, defaultProvider: 'claude', matters, retainedIdleCloseMs: 0, handoffGraceMs: 0,
  })
  const inboxDir = join(root, 'inbox')
  // pipeline-deps.ts 的 mattersService(chat.recent 那一行是那里的原样)
  const service = makeMattersService({
    store: matters,
    ownerChatId: () => OWNER,
    executorName: (id: string) => registry.namesOf(id).name,
    workbench,
    chat: {
      ownerChatId: () => OWNER,
      say: async () => ({ reply: '' }),
      recent: async (chatId: string, limit: number) => (await messages.listRange(chatId, { limit })).map(row => ownerChatReadingEvent(row, inboxDir)).filter(r => r.text.trim() !== '' || r.replyExtras),
    },
    // CC 自己做的事(M5c):act 的列表行与详情读轮与步(pipeline-deps.ts 原样)
    log: makeMatterLog(db),
  })
  // wire-phone.ts:主人对话(peek / ensure)+ 手机对话
  const phoneOwner = makePhoneOwner({ ownerChatId: () => OWNER, matters, origin: () => null })
  const phoneChat = makePhoneChat({ converse: async () => ({ reply: '' }), ownerMatterId: () => phoneOwner.ensure() })
  // features/terminal/wire.ts:终端那件事的轮(terminal-turns)+ 记录增量读进步(terminal-steps),hub 的 turns 是两者叠起来的那一份
  const matterLog = makeMatterLog(db)
  const terminalTurns = makeTerminalTurnLog({ db, log: matterLog, matters })
  const terminalSteps = makeTerminalSteps({ store: makeTerminalStepStore({ db, log: matterLog, matters }) })
  let lookupSession: (id: string) => ReturnType<CliEventHub['lookup']> = () => null
  const turnsWithSteps = withTranscriptSteps({ turns: terminalTurns, steps: terminalSteps, localMachine: MACHINE, lookup: id => lookupSession(id), log: () => {} })
  hub = makeCliEventHub({ send: async () => 'sent', projectName: c => c.split('/').pop()!, log: () => {}, store: makeCliSessionStore(db), localMachine: MACHINE, turns: turnsWithSteps })
  lookupSession = id => hub.lookup(id)
  // 手机看终端几步:wire.ts 的 phoneActions,带生产的 steps(先读步,没有那件事才退回直接解析记录)。
  // 拍板 / 说一句的两样(relay / core)这里用不到,给空的;开着的窗口读本机 Claude 登记,不确定 ⇒ 给空集
  const cliActions = makeCliPhoneActions({
    hub, localMachine: MACHINE, log: () => {}, liveIds: () => new Set(), steps: terminalSteps,
    relay: { pendingHash: () => null, owns: () => false },
    core: { resume: async () => { throw new Error('not used') } },
    resolve: () => false,
  })
  // wire-settings-panel.ts:matters 那一组、chat 那一组、cliActions
  panel = makeSettingsPanel({
    stateDir: root, ownerChatId: () => OWNER, log: () => {},
    chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    executorName: (id: string) => registry.namesOf(id).name,
    matters: { list: f => service.list(f), withActs: rows => service.withActs(rows), detail: id => service.detail(id), inputReceipt: service.inputReceipt, say: (id, text, input) => service.say(id, text, 'phone', input), permission: service.permission, answer: service.answer, stop: service.stop, worktree: service.worktree, rewindPreview: service.rewindPreview, rewind: service.rewind, artifactChunk: service.artifactChunk, handoff: service.handoff, seenOnPhone: id => matters.bind(id, 'phone', 'pwa') },
    chat: { owner: () => phoneOwner.peek(), inboxDir, history: (chatId, o) => messages.listRange(chatId, o), chat: phoneChat, message: (chatId, id) => messages.get(chatId, id) },
    // daemon/wiring/module.ts:登记处列表每行带上这条会话的那件事
    cliSessions: () => hub.list({ limit: 50 }).map(v => { const m = matters.findBySurface('cli', v.session_id)?.id; return m ? { ...v, matter_id: m } : v }),
    cliActions,
  })
  const link = panel.issueToken()
  deviceToken = ((await (await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${link}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).json()) as { device_token: string }).device_token
  // wire-phone.ts 的订阅接线(pollMs 拉长:只要订阅时那一帧)
  topics = makePhoneEventsWiring({
    workbench, changes: workbench.changes, matters, home: (limit, o) => panel.home(limit, o),
    chat: { latestAt: async chatId => { const ts = await messages.latestTs(chatId); return ts ? Date.parse(ts) : null }, pendingMatter: () => phoneChat.pendingMatter() },
    pollMs: 60 * 60_000,
  })
  desktopMatters = mattersRoutes({ matters: service } as unknown as InternalApiDeps)
  desktopWorkbench = workbenchRoutes({ workbench } as unknown as Parameters<typeof workbenchRoutes>[0])

  await seedTasks()
  await seedOwnerChat(messages, matters)
  seedCliSession()
  seedLetterAct(db)
  at(40)
}, 30_000)

afterAll(async () => {
  topics?.dispose()
  hub?.dispose()
  for (const g of gates.values()) g.open()
  await workbench?.shutdown()
  db?.close()
  vi.useRealTimers()
  if (root) removeTempDir(root)
})

// ── 读与规整 ────────────────────────────────────────────────────────
interface Raw { status: number; payload: string }
const desktop = async (table: RouteTable, key: string, query: Record<string, string>): Promise<Raw> => {
  const r = await table[key]!(new URLSearchParams(query), undefined, {} as never)
  // internal-api/index.ts 的 send():JSON.stringify(body)
  return { status: r.status, payload: JSON.stringify(r.body) }
}
const phone = async (path: string): Promise<Raw> => {
  const r = await panel.handleRequest(new Request(`http://127.0.0.1${path}${path.includes('?') ? '&' : '?'}d=${encodeURIComponent(deviceToken)}`))
  return { status: r.status, payload: await r.text() }
}
const topic = (name: string): Promise<Raw> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no frame for ${name}`)), 5000)
  const off = topics.events.subscribe(name, undefined, ev => { clearTimeout(timer); off(); resolve({ status: 200, payload: JSON.stringify(ev) }) })
})

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const uuidLabels = new Map<string, string>()
function normalise(payload: string): string {
  let s = payload.split(root).join('<tmp>')
  for (const [name, id] of Object.entries(ids)) if (id) s = s.split(id).join(name === 'chat' || name === 'terminal' ? `<${name}>` : `<task:${name}>`)
  // matter_turns 的 id(16 位随机 hex,act / 终端详情里露出来):按轮的 cursor 顺序 ⇒ <turn:N>
  db.query<{ id: string }, []>('SELECT id FROM matter_turns ORDER BY cursor').all().forEach((t, i) => { s = s.split(t.id).join(`<turn:${i + 1}>`) })
  return s.replace(UUID, m => {
    const k = m.toLowerCase()
    if (!uuidLabels.has(k)) uuidLabels.set(k, `<uuid:${uuidLabels.size + 1}>`)
    return uuidLabels.get(k)!
  })
}

/** 逐字节:负载必须是规范 JSON(parse 再 stringify 一字不差),金样存它的缩进版 —— 两者一一对应,diff 才读得了。 */
function pin(file: string, raw: Raw): void {
  expect(JSON.stringify(JSON.parse(raw.payload))).toBe(raw.payload)
  const text = JSON.stringify({ status: raw.status, body: JSON.parse(normalise(raw.payload)) }, null, 2) + '\n'
  const path = join(GOLDEN, file)
  if (UPDATE || !existsSync(path)) {
    if (!UPDATE) throw new Error(`金样 ${file} 不存在:UPDATE_MATTER_GOLDEN=1 生成`)
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(path, text)
    return
  }
  expect(text).toBe(readFileSync(path, 'utf8'))
}

// 读的顺序是钉死的:/m/api/matter 会登记一次手机露面(matter_bindings 多一行 phone),所以桌面那两条先读。
// 全文件共用一份规整表(uuid 编号按全局第一次出现),所以 it 不能单独 -t 跑。
describe.skipIf(process.platform === 'win32')('做事读路径金样(M0)', () => {
  for (const name of ['done', 'permission', 'question'] as const) {
    it(`任务 ${name}:/v1/workbench/task · /v1/matter · topic matter/<id> · /m/api/matter`, async () => {
      const id = ids[name]
      pin(`task-${name}.v1-workbench-task.json`, await desktop(desktopWorkbench, 'GET /v1/workbench/task', { id }))
      pin(`task-${name}.v1-matter.json`, await desktop(desktopMatters, 'GET /v1/matter', { id }))
      pin(`task-${name}.topic-matter.json`, await topic(`matter/${id}`))
      pin(`task-${name}.m-api-matter.json`, await phone(`/m/api/matter?id=${id}`))
    })
  }

  it('任务 done 的长轮询增量:/v1/workbench/task?since=8', async () => {
    // 桌面详情页带 since 拉增量:8 是第一轮中途的一个版本号(今天的增量从「权限结果」那一条起),钉住「since 之后」那份长什么样
    pin('task-done.v1-workbench-task.since.json', await desktop(desktopWorkbench, 'GET /v1/workbench/task', { id: ids.done, since: '8' }))
  })

  it('主人对话:/v1/matter · topic matter/<id> · /m/api/matter · /m/api/chat', async () => {
    pin('chat.v1-matter.json', await desktop(desktopMatters, 'GET /v1/matter', { id: ids.chat }))
    pin('chat.topic-matter.json', await topic(`matter/${ids.chat}`))
    pin('chat.m-api-matter.json', await phone(`/m/api/matter?id=${ids.chat}`))
    pin('chat.m-api-chat.json', await phone('/m/api/chat'))
    pin('chat.m-api-chat.page.json', await phone('/m/api/chat?limit=2&before=' + encodeURIComponent(new Date(T0 + 22 * 60_000).toISOString())))
  })

  // M6a:activity 走生产的步(steps.view);字节和 M0 钉的「直接解析记录」那份一样 ⇒ 步和退路解析一样
  it('终端会话:/m/api/cli/activity · /m/api/cli/sessions(带 now)· 那件事的 /v1/matter · /m/api/matter', async () => {
    pin('cli.m-api-cli-activity.json', await phone('/m/api/cli/activity?session_id=cli-golden-1'))
    pin('cli.m-api-cli-sessions.json', await phone('/m/api/cli/sessions'))
    pin('cli.v1-matter.json', await desktop(desktopMatters, 'GET /v1/matter', { id: ids.terminal }))
    pin('cli.m-api-matter.json', await phone(`/m/api/matter?id=${ids.terminal}`))
  })

  it('CC 自己做的事(信):/m/api/matter', async () => {
    pin('act-letters.m-api-matter.json', await phone(`/m/api/matter?id=${actId}`))
  })

  // 列表放最后:/m/api/matters 给每一行登记手机露面(matter_bindings 多一行),先读的详情才不受它影响
  it('手机列表:/m/api/matters · ?kind=act', async () => {
    pin('matters.m-api-matters.json', await phone('/m/api/matters'))
    pin('matters.m-api-matters.kind-act.json', await phone('/m/api/matters?kind=act'))
  })
})

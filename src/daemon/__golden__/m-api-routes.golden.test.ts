/**
 * `/m/api` 回包金样(P3a,设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「分步 · P3a」)。
 *
 * P3c / P3e 要把 35 条和 `/v1` 重复的手机路由并成「一条 `/v1` 路径一个处理器」,`/m/api` 那条变成别名 + 转换。
 * 并之前先把手机今天收到的东西逐字节钉住:每条成功一份 + 一个错误码一份;链接令牌能读的几条(home、matters、matter、
 * art/presence,外加唯一能写的 matter/stop)再钉一份链接令牌下的。M0 的 matter-read-paths.golden.test.ts 已经钉了
 * matter / matters / cli/sessions 等的真数据成功回包,这里不重复那几份。
 *
 * 接缝:面板的 handleRequest(同中继转进来的那一口),deps 在面板的注入口上给照剧本回话的假实现 —— 钉的是面板这一层
 * 加上去的东西:`{ ok }` 信封、phone 那一列错误码、手机默认筛选、链接令牌少读的、帧预算的裁剪、响应头。底下的服务怎么算
 * 不在这里(M0 金样和各服务自己的测试管)。合并时 deps 的形状可以变,这里的字节不许变。
 *
 * P3c 起并成别名的那几条(wire-compat.ts 的 MERGED_ALIAS_KEYS)走内部 API 同一个分发:面板的 `v1` 接一个真的
 * createInternalApi(只用 panelDispatch,不起监听),它的 MattersService / 语音口 / 终端与连接是同一份剧本(`v1Service`、`voiceRoutes`、`v1Reads`)。
 * 剧本的形状故意只有几个字段,所以这里关掉响应契约的核对(`responseContracts: false`)—— 契约由别的测试管。
 *
 * 规整:临时目录 ⇒ `<tmp>`;别的都由剧本定死(Date 用假时钟钉住)。art/presence 两张 PNG ~257KB,只钉长度与 sha256。
 * 每个文件存 { status, headers(content-type / cache-control), body }。
 *
 * 红了先想是不是改到了手机看得见的东西。确实要变:改它的那个 PR 里重录并逐行说明:
 *   UPDATE_M_API_GOLDEN=1 bun --bun vitest run src/daemon/__golden__/m-api-routes.golden.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTempDir } from '../../lib/test-temp'
import { makeSettingsPanel, type SettingsPanel, type SettingsPanelDeps } from '../../features/phone/settings-panel'
import type { MessageRecord } from '../../lib/messages-store'
import { createInternalApi } from '../internal-api'
import { voiceRoutes } from '../../features/voice/routes'
import { terminalRoutes, type TerminalRoutesDeps } from '../../features/terminal/routes'
import { memoryRoutes } from '../../features/memory/routes'
import { journalRoutes } from '../../features/journal/routes'
import { workbenchRoutes } from '../../features/workbench/routes'
import type { WorkbenchService } from '../../features/workbench'
import { makeOwnerChatFileReader } from '../wiring/owner-chat-reading'
import { fileChunkResponse } from '../../features/phone/mobile-chat'
import { phoneMayOpenMatter } from '../../domain/matters/phone-scope'
import type { MattersService } from '../../app/matters/service'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, 'm-api-routes')
const UPDATE = process.env.UPDATE_M_API_GOLDEN === '1'

const OWNER = 'o9golden-owner@im.wechat'
const GUEST = 'o9golden-guest@im.wechat'
/** 2026-11-05 10:00 北京时间。 */
const T0 = Date.UTC(2026, 10, 5, 2, 0, 0)

const TASK = 'a1b2c3d4', CHAT = 'c0ffee00', OTHER_CHAT = 'ffff0000', MISSING = '0000dead'
const RUN = '11111111-1111-4111-8111-111111111111'
const REQ = '22222222-2222-4222-8222-222222222222'
const ART = '33333333-3333-4333-8333-333333333333'
const COMMENT = '44444444-4444-4444-8444-444444444444'
const DRAFT = '55555555-5555-4555-8555-555555555555'
const UPLOAD = '66666666-6666-4666-8666-666666666666'
const SHA = 'ab'.repeat(32)
const PROJECT = 'p-0123456789abcdef0123'

/** 剧本里「这一次抛错」的开关:it 里 fail('x') 之后,名叫 x 的假实现抛 Error(code)。 */
const failing = new Map<string, Error>()
const fail = (name: string, code: string, extra: Record<string, unknown> = {}) => failing.set(name, Object.assign(new Error(code), extra))
const check = (name: string) => { const e = failing.get(name); if (e) { failing.delete(name); throw e } }

let root = ''
let panel: SettingsPanel
let deviceToken = ''
let linkToken = ''
let seenAt: string | null = null

const msg = (r: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'direction' | 'text'>): MessageRecord =>
  ({ chatId: OWNER, ts: new Date(T0 - 60_000).toISOString(), kind: 'text', source: 'phone', ...r } as MessageRecord)

/** 照剧本回话的 MattersService(并成别名的那几条经 /v1 读它;形状同 pipeline-deps.ts 交给内部 API 的那一份)。 */
function v1Service(panel: SettingsPanelDeps): MattersService {
  const m = panel.matters!, chat = panel.chat!
  const hits = [msg({ id: 'm-in-1', direction: 'in', text: '发我报告' }), msg({ id: 'm-out-1', direction: 'out', text: '报告在附件里。' })]
  return {
    list: f => m.list(f as never) as never,
    withActs: rows => rows,
    detail: id => m.detail(id) as never,
    phoneMayOpen: matter => phoneMayOpenMatter(matter, OWNER),
    seenOnPhone: id => m.seenOnPhone(id),
    say: (id, text, _surface, input) => (input ? m.say(id, text, input) : m.say(id, text)) as never,
    // pipeline-deps.ts 的 chat.search 那一行(messagesStore.search → 事件形状)
    searchOwnerChat: async () => { check('search'); return { hits: hits.map(r => ({ id: r.id, kind: r.direction === 'in' ? 'user' as const : 'text' as const, text: r.text, createdAt: Date.parse(r.ts), source: r.source })) as never } },
    // pipeline-deps.ts 的 chat.file 那一行
    ownerChatFile: makeOwnerChatFileReader({ ownerChatId: () => OWNER, inboxDir: chat.inboxDir!, readChunk: fileChunkResponse, stickerDir: join(root, 'stickers'), message: (chatId, id) => chat.message!(chatId, id) }),
  } as Partial<MattersService> as MattersService
}

/**
 * P3c-2 起 `/m/api/cli/sessions`、`today`、`connections` 是别名,翻到 `/v1/cli/sessions`、`/v1/overseer/today`、`/v1/connections`:
 * 剧本挂在内部 API 上(终端模块的路由 + `connections`),同生产(features/terminal/index.ts 的 mount、wiring/module.ts 的 provide)。
 */
function v1Reads() {
  return {
    phoneSessions: () => { check('cliSessions'); return [] },
    overseerToday: () => { check('today'); return { generatedAt: T0, since: T0 - 86_400_000, windowHours: 24, needsYou: [], done: [{ title: '修好登录' }], running: [], stuck: [], counts: { needsYou: 0, done: 1, running: 0, stuck: 0 }, unavailable: [], ccDecided: null, jobs: null } as never },
    connections: () => {
      check('connections')
      return {
        generatedAt: T0, sources: [{ id: 'wechat', state: 'ok', label: '微信', detail: '/Users/someone/plugins/wechat' }], computers: [{ id: 'mac', label: 'golden-mac', online: true, since: T0 - 3_600_000, version: '1.7.8' }],
        recent: [{ matterId: TASK, title: '修好登录', phase: 'done', at: T0 - 60_000 }], outputs: [],
        capabilities: [{ id: 'voice', state: 'off', label: '语音', detail: 'stt-config.json 不在' }],
      } as never
    },
  }
}

/**
 * P3c-3 起 `/m/api/memory/retractions`、`memory/restore`、`todo`、`seen` 是别名,翻到 `/v1/memory/retractions`、
 * `/v1/memory/retractions/restore`、`/v1/knowledge/facts/set_fact_status`、`/v1/journal/seen`:剧本挂在内部 API 上
 * (记忆模块、日志模块自己挂的路由 + bootApi 交的 knowledge),同生产。
 */
function v1Owner() {
  return {
    nightly: {
      retractions: () => { check('retractions'); return [{ key: 'c:abc123', section: '喜好', text: '爱喝美式', day: '2026-11-01', verdict: 'outdated', note: '主人说过时了' }] },
      restore: async (key: string) => (key === 'c:abc123' ? { restored: ['爱喝美式'] } : null),
    },
    knowledge: { facts: { setFactStatus: () => ({ ok: true }) } },
    seen: { read: () => seenAt, write: (iso: string) => { seenAt = iso } },
  }
}

/**
 * P3c-4 起 `/m/api/entry/options`、`entry/models`、`attachment/discard`、`sessions`、`session` 是别名,翻到
 * `/v1/workbench/entry-options`、`models`、`discard-attachment`、`sessions`、`session`:剧本挂在内部 API 上(工作台模块自己挂的
 * workbenchRoutes,原生会话的读法同生产经 phoneSessions 交进去),同生产。
 */
function v1Workbench() {
  return {
    workbench: {
      entryOptions: () => { check('entryOptions'); return { providers: [{ id: 'claude', name: 'Claude Code' }], projects: [{ id: PROJECT, name: 'app' }] } as never },
      entryModels: async ({ providerId }: { providerId: string }) => ({ providerId, models: [{ id: 'opus', label: 'Opus' }], default: 'opus' }) as never,
      discardAttachmentUpload: () => { check('discard') },
    } as Partial<WorkbenchService> as WorkbenchService,
    sessions: {
      list: async (provider: 'claude' | 'codex', input: { q: string }) => ({ items: [{ key: `${provider}:s1`, providerId: provider, nativeId: 's1', title: `会话 ${input.q || '全部'}`, titleSource: 'first_prompt' as const, cwd: '/w/app', updatedAt: T0 - 600_000, remote: false, observedState: 'active' as const }], nextCursor: null, coverage: 'native_supported_history' as const }),
      read: async (key: string) => ({ session: { key, providerId: 'claude' as const, nativeId: 's1', title: '会话', titleSource: 'first_prompt' as const, cwd: '/w/app', updatedAt: T0 - 600_000, remote: false, observedState: 'observed' as const }, messages: [{ id: 'u1', role: 'user' as const, text: '修登录', truncated: false }, { id: 'a1', role: 'assistant' as const, text: '好', truncated: false }], nextCursor: null, sourceFingerprint: 'fp', page: { limit: 20, cursor: null }, truncated: false }),
    },
  }
}

function deps(): SettingsPanelDeps {
  const reportPath = join(root, 'files', 'report.md')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, '# 报告\n\n全过。\n')
  const reply = msg({ id: 'm-out-1', direction: 'out', text: '报告在附件里。', provider: 'claude', extras: JSON.stringify({ attachments: [{ kind: 'file', name: 'report.md', path: reportPath }, { kind: 'voice', text: '发你了' }] }) } as never)
  const chatJob = { requestId: REQ, matterId: CHAT, text: '在吗', status: 'pending' as const, since: T0 - 5_000 }
  const matterRow = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, title: `事 ${id}`, status: 'open', updatedAt: T0 - 120_000, ...extra })
  const detailOf = (id: string) => {
    if (id === MISSING) throw new Error('matter_not_found')
    if (id === OTHER_CHAT) return { matter: matterRow(id, 'chat', { ownerChatId: GUEST }), events: [] }
    if (id === CHAT) return {
      matter: matterRow(id, 'chat', { ownerChatId: OWNER }),
      events: [
        { kind: 'message', role: 'owner', text: '发我报告', createdAt: T0 - 90_000, messageId: 'm-in-1' },
        { kind: 'message', role: 'cc', text: '报告在附件里。', createdAt: T0 - 60_000, messageId: 'm-out-1', replyExtras: { narration: ['找到报告'], attachments: [{ kind: 'file', name: 'report.md' }] } },
      ],
    }
    return { matter: matterRow(id, 'task'), task: { id, status: 'running', phase: 'working' }, runId: RUN, permissions: [], questions: [], artifacts: [], events: [{ kind: 'text', text: '在跑', createdAt: T0 - 30_000 }] }
  }
  return {
    stateDir: root, ownerChatId: () => OWNER, log: () => {}, now: () => Date.now(),
    chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => '大人', setUserName: async () => {},
    executorName: id => ({ claude: 'Claude Code', codex: 'Codex' } as Record<string, string>)[id] ?? id,
    matters: {
      list: () => [matterRow(TASK, 'task'), matterRow(CHAT, 'chat', { ownerChatId: OWNER }), matterRow(OTHER_CHAT, 'chat', { ownerChatId: GUEST }), matterRow('7e000001', 'terminal'), matterRow('ac000001', 'act')],
      detail: (id: string) => detailOf(id),
      say: async (id: string, text: string, input?: { requestId: string }) => { check('say'); return { accepted: true, matterId: id, chars: text.length, ...(input ? { requestId: input.requestId } : {}) } },
      seenOnPhone: () => {},
      stop: async () => { check('stop') },
      permission: () => { check('permission') },
      answer: () => { check('answer') },
      artifactChunk: (_id: string, q: { sha256: string; offset: number }) => { check('artifact'); return { name: 'report.md', mime: 'text/markdown', size: 12, sha256: q.sha256, offset: q.offset, nextOffset: 12, contentBase64: Buffer.from('# 报告\n').toString('base64') } },
      handoff: async (id: string, input: { providerId: string }) => { check('handoff'); return { taskId: id, providerId: input.providerId, created: true } },
      worktree: (id: string, action: string) => { check('worktree'); return { worktree: { taskId: id, action, branch: 'cc/a1b2c3d4', state: 'committed' } } },
      worktreeScript: async () => { check('worktreeScript'); return { script: { state: 'running' } } },
      rewindPreview: async (_id: string, artifactId: string) => { check('rewindPreview'); return { artifactId, token: SHA, files: [{ path: 'README.md', kind: 'modified' }] } },
      rewind: async (_id: string, artifactId: string) => { check('rewind'); return { artifactId, rewound: true } },
    } as never,
    entry: {
      createEntry: input => { check('createEntry'); return { requestId: input.requestId, taskId: TASK, created: true } as never },
      entryReceipt: requestId => requestId === REQ ? { requestId, taskId: TASK, created: false } as never : null,
    },
    uploads: {
      chunk: input => { check('chunk'); return { id: input.id, draftId: input.draftId, taskId: null, size: input.size, sha256: input.sha256, nextOffset: input.size, status: 'ready' } },
      status: input => { check('uploadStatus'); return { id: input.id, draftId: input.draftId, taskId: null, size: 4, sha256: SHA, nextOffset: 2, status: 'uploading' } },
    },
    changes: id => {
      if (id === MISSING) throw new Error('not_found')
      return [{ artifactId: ART, createdAt: T0 - 60_000, status: 'complete', rewindable: { start: true, end: true }, files: [{ path: 'README.md', kind: 'modified', diff: '@@ -1 +1 @@\n-old\n+new\n', hunks: [{ index: 0, sha256: SHA, header: '@@ -1 +1 @@' }] }] }] as never
    },
    review: {
      mark: () => { check('reviewMark') },
      ret: async () => { check('reviewReturn') },
      comment: () => { check('reviewComment') },
      sendComments: () => { check('sendComments'); return { sent: 2, remaining: 0, skippedDiscarded: 1, receipt: 'not-for-phone' } },
    },
    chat: {
      inboxDir: join(root, 'inbox'),
      owner: () => ({ matterId: CHAT, chatId: OWNER, title: '主人' }),
      history: async () => [reply],
      chat: { say: () => chatJob, state: () => ({ pending: null, failed: null }), pendingMatter: () => null },
      message: async (_chatId, id) => (id === reply.id ? reply : null),
    },
    todos: { facts: { findFacts: () => ({ results: [] }) }, names: () => [] },
    seen: { read: () => seenAt },
    presence: async () => ({ presence: 'near', activity: { kind: 'idle', label: '在旁边', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } } as never),
    feed: { journal: { list: () => [] }, planLogDays: () => [], turnsRecent: () => [{ chatId: OWNER, startedAt: T0 - 300_000, endedAt: T0 - 240_000, outcome: 'replied', mode: 'solo' }], timezone: () => 'Asia/Shanghai' },
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mapi-golden-')))
  const d = deps()
  const reads = v1Reads()
  const owner = v1Owner()
  const api = createInternalApi({ stateDir: root, daemonPid: 1, matters: v1Service(d), connections: reads.connections, knowledge: owner.knowledge as never }, { responseContracts: false })
  api.mount('memory', memoryRoutes({ stateDir: root, memoryLlm: () => null, memoryNightly: () => owner.nightly as never }))
  api.mount('journal', journalRoutes({ stateDir: root, journal: {} as never, seen: owner.seen }))
  api.mount('terminal', terminalRoutes({ overseerToday: reads.overseerToday, phoneSessions: reads.phoneSessions } as Partial<TerminalRoutesDeps> as TerminalRoutesDeps))
  const wb = v1Workbench()
  api.mount('workbench', workbenchRoutes({ workbench: wb.workbench, resolveAdminChatId: () => OWNER, phoneSessions: { sessions: wb.sessions, ...(d.executorName ? { executorName: d.executorName } : {}) } }))
  api.mount('voice', voiceRoutes({ voice: { transcribe: async () => { check('transcribe'); return { text: '  你好,帮我看看  ' } } } as never }))
  panel = makeSettingsPanel({ ...d, v1: api.panelDispatch })
  const pairLink = panel.issueToken()
  deviceToken = ((await (await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${pairLink}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).json()) as { device_token: string }).device_token
  linkToken = panel.issueToken()
})

afterAll(() => {
  vi.useRealTimers()
  if (root) removeTempDir(root)
})

// ── 读与钉 ─────────────────────────────────────────────────────────
interface Raw { status: number; headers: Record<string, string>; payload: string }
async function call(method: 'GET' | 'POST', path: string, body?: unknown, as: 'device' | 'link' = 'device'): Promise<Raw> {
  const tok = as === 'device' ? `d=${encodeURIComponent(deviceToken)}` : `t=${encodeURIComponent(linkToken)}`
  const init: RequestInit = { method, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }
  const r = await panel.handleRequest(new Request(`http://127.0.0.1${path}${path.includes('?') ? '&' : '?'}${tok}`, init))
  const headers: Record<string, string> = {}
  for (const h of ['content-type', 'cache-control']) { const v = r.headers.get(h); if (v !== null) headers[h] = v }
  return { status: r.status, headers, payload: await r.text() }
}

function write(file: string, text: string): void {
  const path = join(GOLDEN, file)
  if (UPDATE || !existsSync(path)) {
    if (!UPDATE) throw new Error(`金样 ${file} 不存在:UPDATE_M_API_GOLDEN=1 生成`)
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(path, text)
    return
  }
  expect(text).toBe(readFileSync(path, 'utf8'))
}

/** 逐字节:负载必须是规范 JSON(parse 再 stringify 一字不差),金样存它的缩进版。 */
function pin(file: string, raw: Raw): void {
  expect(JSON.stringify(JSON.parse(raw.payload)), file).toBe(raw.payload)
  const body = JSON.parse(raw.payload.split(root).join('<tmp>'))
  write(file, JSON.stringify({ status: raw.status, headers: raw.headers, body }, null, 2) + '\n')
}

/** 大回包只钉长度与哈希(art/presence 两张 PNG)。 */
function pinDigest(file: string, raw: Raw): void {
  expect(JSON.stringify(JSON.parse(raw.payload)), file).toBe(raw.payload)
  write(file, JSON.stringify({ status: raw.status, headers: raw.headers, bytes: Buffer.byteLength(raw.payload), sha256: createHash('sha256').update(raw.payload).digest('hex') }, null, 2) + '\n')
}

const audio = Buffer.from('golden-audio-bytes').toString('base64')

describe.skipIf(process.platform === 'win32')('/m/api 回包金样(P3a)', () => {
  // ── P3c-1 一件事与主人对话 ────────────────────────────────────────
  it('matters · matter · matter/say', async () => {
    pin('matters.error.json', await call('GET', '/m/api/matters?kind=bogus'))
    pin('matter.error.json', await call('GET', `/m/api/matter?id=${MISSING}`))
    pin('matter.other-chat.json', await call('GET', `/m/api/matter?id=${OTHER_CHAT}`))
    pin('matter-say.ok.json', await call('POST', '/m/api/matter/say', { id: TASK, text: '再确认一次', requestId: REQ, runId: RUN }))
    fail('say', 'input_stale')
    pin('matter-say.error.json', await call('POST', '/m/api/matter/say', { id: TASK, text: '再确认一次' }))
  })

  it('chat/search · chat/file · chat/transcribe(POST)', async () => {
    pin('chat-search.ok.json', await call('GET', '/m/api/chat/search?q=' + encodeURIComponent('报告')))
    pin('chat-search.error.json', await call('GET', '/m/api/chat/search'))
    pin('chat-file.ok.json', await call('GET', '/m/api/chat/file?id=m-out-1&i=0'))
    pin('chat-file.error.json', await call('GET', '/m/api/chat/file?id=m-out-1&i=1'))
    pin('chat-transcribe.ok.json', await call('POST', '/m/api/chat/transcribe', { mime: 'audio/mp4', audioBase64: audio }))
    fail('transcribe', 'no stt config')
    pin('chat-transcribe.error.json', await call('POST', '/m/api/chat/transcribe', { mime: 'audio/mp4', audioBase64: audio }))
  })

  // ── P3c-2 终端与总览 ──────────────────────────────────────────────
  it('cli/sessions · today · connections', async () => {
    fail('cliSessions', 'boom')
    pin('cli-sessions.error.json', await call('GET', '/m/api/cli/sessions'))
    pin('today.ok.json', await call('GET', '/m/api/today'))
    fail('today', 'boom')
    pin('today.error.json', await call('GET', '/m/api/today'))
    pin('connections.ok.json', await call('GET', '/m/api/connections'))
    fail('connections', 'boom')
    pin('connections.error.json', await call('GET', '/m/api/connections'))
  })

  // ── P3c-3 记忆、待办、看到哪了 ────────────────────────────────────
  it('memory/retractions · memory/restore · todo · seen', async () => {
    pin('memory-retractions.ok.json', await call('GET', '/m/api/memory/retractions'))
    fail('retractions', 'boom')
    pin('memory-retractions.error.json', await call('GET', '/m/api/memory/retractions'))
    pin('memory-restore.ok.json', await call('POST', '/m/api/memory/restore', { key: 'c:abc123' }))
    pin('memory-restore.error.json', await call('POST', '/m/api/memory/restore', { key: 'c:gone' }))
    pin('todo.ok.json', await call('POST', '/m/api/todo', { id: 7, status: 'resolved' }))
    pin('todo.error.json', await call('POST', '/m/api/todo', { id: '7', status: 'resolved' }))
    pin('seen.ok.json', await call('POST', '/m/api/seen', { until: new Date(T0 - 60_000).toISOString() }))
    pin('seen.future-clamped.json', await call('POST', '/m/api/seen', { until: new Date(T0 + 3_600_000).toISOString() }))
    pin('seen.error.json', await call('POST', '/m/api/seen', { until: 'yesterday' }))
  })

  // ── P3c-4 交办选项与会话 ──────────────────────────────────────────
  it('entry/options · entry/models · attachment/* · sessions · session', async () => {
    pin('entry-options.ok.json', await call('GET', '/m/api/entry/options'))
    fail('entryOptions', 'module_off')
    pin('entry-options.error.json', await call('GET', '/m/api/entry/options'))
    pin('entry-models.ok.json', await call('GET', '/m/api/entry/models?providerId=claude&projectId=' + PROJECT))
    pin('entry-models.error.json', await call('GET', '/m/api/entry/models?providerId=Bad!'))
    pin('attachment-upload.ok.json', await call('GET', `/m/api/attachment/upload?id=${UPLOAD}&draftId=${DRAFT}`))
    pin('attachment-upload.error.json', await call('GET', `/m/api/attachment/upload?id=${UPLOAD}`))
    pin('attachment-chunk.ok.json', await call('POST', '/m/api/attachment/chunk', { id: UPLOAD, draftId: DRAFT, name: 'a.png', mime: 'image/png', size: 4, sha256: SHA, offset: 0, contentBase64: 'AAAAAA==' }))
    pin('attachment-chunk.error.json', await call('POST', '/m/api/attachment/chunk', 'not json'))
    pin('attachment-discard.ok.json', await call('POST', '/m/api/attachment/discard', { id: UPLOAD, draftId: DRAFT }))
    fail('discard', 'attachment_scope')
    pin('attachment-discard.error.json', await call('POST', '/m/api/attachment/discard', { id: UPLOAD, draftId: DRAFT }))
    pin('sessions.ok.json', await call('GET', '/m/api/sessions?provider=claude&q=' + encodeURIComponent('登录')))
    pin('sessions.error.json', await call('GET', '/m/api/sessions?provider=cursor'))
    pin('session.ok.json', await call('GET', '/m/api/session?key=' + encodeURIComponent('claude:s1')))
    pin('session.error.json', await call('GET', '/m/api/session?key=claude:s1&window=middle'))
  })

  // ── P3e 一件事上的动作 + 交办 ─────────────────────────────────────
  it('matter/stop · permission · answer · artifact · handoff · worktree', async () => {
    pin('matter-stop.ok.json', await call('POST', '/m/api/matter/stop', { id: TASK, runId: RUN }))
    fail('stop', 'not_found')
    pin('matter-stop.error.json', await call('POST', '/m/api/matter/stop', { id: TASK, runId: RUN }))
    pin('matter-permission.ok.json', await call('POST', '/m/api/matter/permission', { id: TASK, runId: RUN, requestId: REQ, decision: 'allow' }))
    fail('permission', 'permission_stale')
    pin('matter-permission.error.json', await call('POST', '/m/api/matter/permission', { id: TASK, runId: RUN, requestId: REQ, decision: 'allow' }))
    pin('matter-answer.ok.json', await call('POST', '/m/api/matter/answer', { id: TASK, runId: RUN, requestId: REQ, answers: { 'q-scope': ['只改 README'] } }))
    fail('answer', 'question_stale')
    pin('matter-answer.error.json', await call('POST', '/m/api/matter/answer', { id: TASK, runId: RUN, requestId: REQ, answers: null }))
    pin('matter-artifact.ok.json', await call('GET', `/m/api/matter/artifact?id=${TASK}&artifactId=${ART}&sha256=${SHA}&offset=0`))
    fail('artifact', 'attachment_scope')
    pin('matter-artifact.error.json', await call('GET', `/m/api/matter/artifact?id=${TASK}&artifactId=${ART}&sha256=${SHA}&offset=0`))
    pin('matter-handoff.ok.json', await call('POST', '/m/api/matter/handoff', { id: TASK, requestId: REQ, providerId: 'codex' }))
    fail('handoff', 'unavailable_provider')
    pin('matter-handoff.error.json', await call('POST', '/m/api/matter/handoff', { id: TASK, requestId: REQ, providerId: 'codex' }))
    pin('matter-worktree.ok.json', await call('POST', '/m/api/matter/worktree', { id: TASK, action: 'commit' }))
    fail('worktreeScript', 'script_approval_required')
    pin('matter-worktree.error.json', await call('POST', '/m/api/matter/worktree', { id: TASK, action: 'run' }))
  })

  it('matter/changes · review-mark · review-return · review-comment · review-comments-send', async () => {
    pin('matter-changes.ok.json', await call('GET', `/m/api/matter/changes?id=${TASK}`))
    pin('matter-changes.error.json', await call('GET', `/m/api/matter/changes?id=${MISSING}`))
    pin('matter-review-mark.ok.json', await call('POST', '/m/api/matter/review-mark', { id: TASK, artifactId: ART, path: 'README.md', mark: 'accepted' }))
    fail('reviewMark', 'review_file_unmarkable')
    pin('matter-review-mark.error.json', await call('POST', '/m/api/matter/review-mark', { id: TASK, artifactId: ART, path: 'README.md', mark: 'accepted' }))
    pin('matter-review-return.ok.json', await call('POST', '/m/api/matter/review-return', { id: TASK, artifactId: ART, paths: ['README.md'], comment: '标题再短一点' }))
    fail('reviewReturn', 'restart_confirmation_required')
    pin('matter-review-return.error.json', await call('POST', '/m/api/matter/review-return', { id: TASK, artifactId: ART, paths: ['README.md'], comment: '标题再短一点' }))
    pin('matter-review-comment.ok.json', await call('POST', '/m/api/matter/review-comment', { id: TASK, commentId: COMMENT.toUpperCase(), artifactId: ART, path: 'README.md', hunk: 0, hunkSha256: SHA, body: '这里换个说法' }))
    pin('matter-review-comment.deleted.json', await call('POST', '/m/api/matter/review-comment', { id: TASK, commentId: COMMENT, delete: true }))
    fail('reviewComment', 'review_hunk_stale')
    pin('matter-review-comment.error.json', await call('POST', '/m/api/matter/review-comment', { id: TASK, commentId: COMMENT, delete: true }))
    pin('matter-review-comments-send.ok.json', await call('POST', '/m/api/matter/review-comments-send', { id: TASK, summary: '两处', inputRequestId: REQ }))
    pin('matter-review-comments-send.error.json', await call('POST', '/m/api/matter/review-comments-send', { id: TASK, extra: 1 }))
  })

  it('matter/rewind(GET / POST)· matter/create · matter/create-receipt', async () => {
    pin('matter-rewind-get.ok.json', await call('GET', `/m/api/matter/rewind?id=${TASK}&artifactId=${ART}`))
    fail('rewindPreview', 'rewind_unavailable', { reason: 'not_latest' })
    pin('matter-rewind-get.error.json', await call('GET', `/m/api/matter/rewind?id=${TASK}&artifactId=${ART}`))
    pin('matter-rewind-post.ok.json', await call('POST', '/m/api/matter/rewind', { id: TASK, artifactId: ART, token: SHA }))
    fail('rewind', 'rewind_failed', { rolledBack: true })
    pin('matter-rewind-post.error.json', await call('POST', '/m/api/matter/rewind', { id: TASK, artifactId: ART, token: SHA }))
    const entry = { requestId: REQ, text: '把安装说明改一下', target: { kind: 'project', projectId: 'p-0123456789abcdef0123' } }
    pin('matter-create.ok.json', await call('POST', '/m/api/matter/create', entry))
    fail('createEntry', 'unattended_ack_required')
    pin('matter-create.error.json', await call('POST', '/m/api/matter/create', entry))
    pin('matter-create-receipt.ok.json', await call('GET', `/m/api/matter/create-receipt?requestId=${REQ}`))
    pin('matter-create-receipt.error.json', await call('GET', `/m/api/matter/create-receipt?requestId=${RUN}`))
  })

  // ── 链接令牌能走的几条:同一条路,链接令牌下的那一份(设备令牌的那一份并排钉,差别一眼看得出)────
  it('链接令牌:home · matters · matter · art/presence · matter/stop', async () => {
    pin('home.device.json', await call('GET', '/m/api/home'))
    pin('home.link.json', await call('GET', '/m/api/home', undefined, 'link'))
    pin('matters.device.json', await call('GET', '/m/api/matters'))
    pin('matters.link.json', await call('GET', '/m/api/matters', undefined, 'link'))
    pin('matter.device.json', await call('GET', `/m/api/matter?id=${CHAT}`))
    pin('matter.link.json', await call('GET', `/m/api/matter?id=${CHAT}`, undefined, 'link'))
    pinDigest('art-presence.device.json', await call('GET', '/m/api/art/presence'))
    pinDigest('art-presence.link.json', await call('GET', '/m/api/art/presence', undefined, 'link'))
    pin('matter-stop.link.json', await call('POST', '/m/api/matter/stop', { id: TASK, runId: RUN }, 'link'))
    // 链接令牌走不了的(只读的那几条之外):钉一份 403,范围收窄 / 放宽都会红
    pin('matter-say.link.json', await call('POST', '/m/api/matter/say', { id: TASK, text: 'x' }, 'link'))
  })
})

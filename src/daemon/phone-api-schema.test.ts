/**
 * phone-api-schema.test.ts — 手机协议第 12 步:`/m/api/*`、`/set/api/*` 每条路由
 * 都有一份 zod schema(`packages/protocol/src/api.ts`),对着真实面板返回 `parse`。
 *
 * 两层:
 *   1. 守卫 —— `PHONE_ROUTES`(phone-routes.ts)与 `PHONE_API_SCHEMAS` +
 *      `PHONE_HTML_ROUTES`(协议包)双向核对,新路由忘了配 schema、或 schema
 *      配错了键,这里先红。
 *   2. 真实返回 —— 用真 workbench / matters / settings-panel 搭出的面板发真
 *      请求,拿真实 JSON 对着 schema `parse`(不是手写 fixture)。少一个必需字段
 *      或类型不对,`parse` 会抛,测试就红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PHONE_API_SCHEMAS, PHONE_HTML_ROUTES } from '@wechat-cc/protocol'
import { removeTempDir } from '../lib/test-temp'
import { encodeNativeHistoryKey, historyPreview, type NativeHistoryItem, type NativeHistoryReader } from '../core/workbench/native-history'
import { openDb, type Db } from '../lib/db'
import { createProviderRegistry } from '../core/provider-registry'
import { makeMatterStore } from '../core/matters/store'
import { makeMattersService } from '../core/matters/service'
import { buildConnections } from './connections'
import { makeWorkbenchStore } from '../core/workbench/store'
import { makeWorkbenchService, type WorkbenchService } from '../core/workbench/service'
import { MANAGED_NATIVE_CAPABILITIES } from '../core/workbench/executor-capabilities'
import { saveArtifactSnapshot } from '../core/workbench/artifacts'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'
import { PHONE_ROUTES } from './phone-routes'
import { makePhoneInsight } from './phone-insight'
import { makeApprovalExplainer } from './phone-explain'
import { makeProgressSummarizer } from './phone-progress'
import { makePhoneOwner } from './mobile-chat'
import { makePhoneChat } from './phone-chat'
import { makeMessagesStore } from '../lib/messages-store'

// ── 1) 守卫:PHONE_ROUTES ↔ (PHONE_API_SCHEMAS ∪ PHONE_HTML_ROUTES) 双向核对 ──

describe('手机接口 schema 守卫', () => {
  it('PHONE_ROUTES 每条要么是 HTML(登记在 PHONE_HTML_ROUTES 并带理由)要么有 schema', () => {
    for (const route of PHONE_ROUTES) {
      const isHtml = PHONE_HTML_ROUTES.has(route)
      const hasSchema = Object.hasOwn(PHONE_API_SCHEMAS, route)
      expect(isHtml || hasSchema, `${route} 既不在 PHONE_HTML_ROUTES 也没有 schema`).toBe(true)
      expect(isHtml && hasSchema, `${route} 不能同时是 HTML 又有 JSON schema`).toBe(false)
      if (isHtml) expect(PHONE_HTML_ROUTES.get(route)!.length, `${route} 的 HTML 排除理由不能是空串`).toBeGreaterThan(0)
    }
  })

  it('反向:PHONE_API_SCHEMAS 与 PHONE_HTML_ROUTES 的每个键都在 PHONE_ROUTES 里(没有登记漂移)', () => {
    for (const key of Object.keys(PHONE_API_SCHEMAS)) expect(PHONE_ROUTES.has(key), `${key} 有 schema 但不在 PHONE_ROUTES 里`).toBe(true)
    for (const key of PHONE_HTML_ROUTES.keys()) expect(PHONE_ROUTES.has(key), `${key} 在 PHONE_HTML_ROUTES 里但不在 PHONE_ROUTES 里`).toBe(true)
  })
})

// ── 2) 真实返回:workbench + matters(entry / attachment / permission / answer / artifact / say / matter 详情）──

describe('真实返回校验 — workbench + matters', () => {
  let root: string, managedRoot: string, db: Db, workbench: WorkbenchService, panel: SettingsPanel, base: string, token: string, nativeDir: string
  let store: ReturnType<typeof makeWorkbenchStore>, matters: ReturnType<typeof makeMatterStore>

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'phone-schema-workbench-')))
    managedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'phone-schema-managed-')))
    db = openDb({ path: join(root, 'state.db') })
    matters = makeMatterStore(db)
    store = makeWorkbenchStore(db)
    // 电脑上的一条原生会话(spec 2026-10-01-tendhearth-continue-sessions):nativeId 与假执行者 init 报的一致,恢复才对得上。
    nativeDir = join(root, 'native'); mkdirSync(nativeDir)
    const nativeItem: NativeHistoryItem = { key: encodeNativeHistoryKey('claude', 'phone-schema-native'), providerId: 'claude', nativeId: 'phone-schema-native', title: '原会话', titleSource: 'native_custom', cwd: nativeDir, updatedAt: 1, remote: false, observedState: 'unknown' }
    const nativeRead: NativeHistoryReader['read'] = async (_key, page) => historyPreview(nativeItem, 1, [{ id: 'u', role: 'user', text: '原来的要求', truncated: false }], null, page)
    const nativeReader: NativeHistoryReader = { list: async () => ({ items: [nativeItem], nextCursor: null, coverage: 'native_supported_history' }), read: nativeRead, currentFingerprint: async (key, page = { limit: 100 }) => (await nativeRead(key, page)).sourceFingerprint }
    const registry = createProviderRegistry()
    registry.register('claude', {
      async spawn(project, ctx) {
        return {
          async *dispatch() {
            yield { kind: 'init' as const, sessionId: 'phone-schema-native' }
            const allowed = await ctx.requestPermission!({ tool: 'Bash', description: '清一个临时探测文件' })
            const answers = await ctx.requestUserInput!({
              questions: [{ id: 'format', header: '格式', question: '保存成哪种？', options: [{ label: '文字', description: '纯文本' }], allowOther: true }],
            })
            yield { kind: 'text' as const, text: `已保存(允许=${allowed} 答=${JSON.stringify(answers)})` }
          },
          async steer() {},
          async close() {},
        }
      },
    }, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
    workbench = makeWorkbenchService({ store, registry, stateDir: root, managedWorkspaceRoot: managedRoot, ownerChatId: () => 'owner', defaultProvider: 'claude', matters, nativeHistory: { claude: nativeReader } })
    const service = makeMattersService({ store: matters, workbench })
    panel = makeSettingsPanel({
      stateDir: root, ownerChatId: () => 'owner', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {},
      uploads: {
        chunk: input => workbench.uploadAttachmentChunk(input, { ownerKey: 'owner', surface: 'phone' }),
        status: input => workbench.attachmentUploadStatus(input, { ownerKey: 'owner', surface: 'phone' }),
        discard: input => workbench.discardAttachmentUpload(input, { ownerKey: 'owner', surface: 'phone' }),
      },
      entry: {
        entryOptions: () => workbench.entryOptions({ ownerKey: 'owner', surface: 'phone' }),
        createEntry: input => workbench.createEntry(input, { ownerKey: 'owner', surface: 'phone' }),
        entryReceipt: id => workbench.entryReceipt(id, { ownerKey: 'owner', surface: 'phone' }),
      },
      insight: makePhoneInsight({ detail: id => service.detail(id), explainer: makeApprovalExplainer({ cheapEval: () => null, budgetMs: () => 1000, log: () => {} }), summarizer: makeProgressSummarizer({ cheapEval: () => null, budgetMs: () => 1000, now: () => Date.now(), log: () => {} }) }),
      changes: id => workbench.reviewList(id),
      matters: { ...service, say: (id, text, input) => service.say(id, text, 'phone', input), seenOnPhone: id => { matters.bind(id, 'phone', 'pwa') } },
      connections: () => buildConnections({ plugins: () => null, wechatSyncedAt: () => null, knowledge: () => ({ enabled: false, built: false, latestAt: null, syncedAt: null }), computer: () => ({ label: 'test', since: null, version: null }), workbench }),
      sessions: { list: async () => ({ items: [], nextCursor: null, coverage: 'native_supported_history' as const }), read: async () => { throw new Error('native_history_unsupported') } },
      sessionContinue: { preview: k => workbench.previewNativeContinue(k), adopt: k => workbench.adoptNativeSession(k) },
      chat: (() => {
        const owner = makePhoneOwner({ ownerChatId: () => 'owner', matters })
        return {
          owner: () => owner.peek(),
          history: (chatId: string, o: { beforeTs?: string; limit: number }) => makeMessagesStore(db).listRange(chatId, o),
          chat: makePhoneChat({ converse: async () => ({ reply: 'ok' }), ownerMatterId: () => owner.ensure() }),
          message: (chatId: string, id: string) => makeMessagesStore(db).get(chatId, id),
          speak: async (text: string) => ({ audio: Buffer.from(`voice:${text}`), mime: 'audio/mpeg' }),
        }
      })(),
    })
    const started = await panel.start(0)
    base = `http://127.0.0.1:${started.port}`
    token = panel.issueToken()
  })
  afterEach(async () => { await panel?.stop(); await workbench?.shutdown(); db?.close(); removeTempDir(root); removeTempDir(managedRoot) })

  function create(name: string) { const path = join(root, name); mkdirSync(path); return workbench.create({ path, providerId: 'claude', text: name }) }
  function request(path: string, body?: unknown, auth = token) {
    return fetch(base + path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(auth), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  async function ready(id: string) { await expect.poll(() => workbench.detail(id).permissions.length).toBe(1); return workbench.detail(id) }
  /** key 用响应自己的 method+path 拼(不带查询串),跟 PHONE_API_SCHEMAS 同一套键。 */
  function parseAs(key: string, body: unknown) {
    const schema = PHONE_API_SCHEMAS[key]
    expect(schema, `${key} 没有登记 schema`).toBeDefined()
    return schema!.parse(body)
  }

  it('connections 真实返回符合 schema', async () => {
    create('conn')
    parseAs('GET /m/api/connections', await (await request('/m/api/connections')).json())
  })

  it('sessions / session 真实返回符合 schema', async () => {
    parseAs('GET /m/api/sessions', await (await request('/m/api/sessions?provider=claude')).json())
    const res = await request('/m/api/session?key=x')
    expect(res.status).toBe(404)
    parseAs('GET /m/api/session', await res.json())
  })

  it('session/continue:预览 → 接成一件事 → managed → 详情 nativeStart → 第一句 say,真实返回都符合 schema', async () => {
    const key = encodeNativeHistoryKey('claude', 'phone-schema-native')
    expect(parseAs('GET /m/api/session/continue', await (await request(`/m/api/session/continue?key=${key}`)).json()))
      .toEqual({ ok: true, state: 'ready', provider: 'claude', project: 'native', mode: 'native_resume', matterId: null })
    const post = parseAs('POST /m/api/session/continue', await (await request('/m/api/session/continue', { key })).json()) as { ok: true; matterId: string; created: boolean }
    expect(post.created).toBe(true)
    expect(parseAs('GET /m/api/session/continue', await (await request(`/m/api/session/continue?key=${key}`)).json())).toMatchObject({ state: 'managed', matterId: post.matterId })
    expect(matters.bindings(post.matterId).map(b => b.surface).sort()).toEqual(['phone', 'wechat'])
    expect(parseAs('GET /m/api/matter', await (await request(`/m/api/matter?id=${post.matterId}`)).json())).toMatchObject({ nativeStart: { mode: 'native_resume', providerId: 'claude' } })
    const said = await request('/m/api/matter/say', { id: post.matterId, text: '接着做', requestId: randomUUID() })
    expect(said.status).toBe(200)
    parseAs('POST /m/api/matter/say', await said.json())
    const bad = await request('/m/api/session/continue', { key, extra: 1 })
    expect(bad.status).toBe(400)
    parseAs('POST /m/api/session/continue', await bad.json())
  })

  it('entry/options 真实返回符合 schema', async () => {
    const res = await request('/m/api/entry/options')
    parseAs('GET /m/api/entry/options', await res.json())
  })

  // apps/mobile/src/entry.js:80 读 provider.capabilities.features.attachments 来决定
  // 能不能带材料交办 —— schema 必须收得住这个字段的类型漂移,不能是 z.unknown()。
  it('entry/options 的 capabilities.features.attachments 类型漂移会被 schema 挡住', async () => {
    const body = await (await request('/m/api/entry/options')).json() as { providers: Array<{ capabilities: { features: { attachments: boolean } } }> }
    expect(body.providers[0]!.capabilities.features.attachments).toBe(true)
    const mutated = structuredClone(body)
    mutated.providers[0]!.capabilities.features.attachments = 'nope' as unknown as boolean
    expect(() => parseAs('GET /m/api/entry/options', mutated)).toThrow()
  })

  it('matter/create 与 matter/create-receipt 真实返回符合 schema', async () => {
    const body = { requestId: randomUUID(), text: '从手机开始', target: { kind: 'managed' } }
    const created = await request('/m/api/matter/create', body)
    expect(created.status).toBe(202)
    parseAs('POST /m/api/matter/create', await created.json())
    const receipt = await request('/m/api/matter/create-receipt?requestId=' + body.requestId)
    parseAs('GET /m/api/matter/create-receipt', await receipt.json())
  })

  it('attachment/chunk、attachment/upload(status)、attachment/discard 真实返回符合 schema', async () => {
    const bytes = Buffer.from('phone schema material')
    const id = randomUUID(), draftId = randomUUID()
    const chunkBody = { id, draftId, name: 'material.txt', mime: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), offset: 0, contentBase64: bytes.toString('base64') }
    const chunked = await request('/m/api/attachment/chunk', chunkBody)
    parseAs('POST /m/api/attachment/chunk', await chunked.json())
    const status = await request(`/m/api/attachment/upload?id=${id}&draftId=${draftId}`)
    parseAs('GET /m/api/attachment/upload', await status.json())
    const discarded = await request('/m/api/attachment/discard', { id, draftId })
    parseAs('POST /m/api/attachment/discard', await discarded.json())
  })

  it('matter/permission、matter/answer、matter/say(task)、GET matter 详情 真实返回符合 schema', async () => {
    const task = create('c'), live = await ready(task.id)
    const permission = live.permissions[0]!
    const decided = await request('/m/api/matter/permission', { id: task.id, runId: live.runId, requestId: permission.id, decision: 'allow' })
    parseAs('POST /m/api/matter/permission', await decided.json())
    await expect.poll(() => workbench.detail(task.id).questions.length).toBe(1)
    const question = workbench.detail(task.id).questions[0]!
    const answered = await request('/m/api/matter/answer', { id: task.id, runId: live.runId, requestId: question.id, answers: { format: ['文字'] } })
    parseAs('POST /m/api/matter/answer', await answered.json())
    const said = await request('/m/api/matter/say', { id: task.id, runId: live.runId, requestId: randomUUID(), text: '补充条件' })
    parseAs('POST /m/api/matter/say', await said.json())
    const detail = await request('/m/api/matter?id=' + task.id)
    parseAs('GET /m/api/matter', await detail.json())
  })

  it('matter/artifact 与 matters 列表 真实返回符合 schema', async () => {
    const task = create('art'); await ready(task.id)
    const bytes = Buffer.from('small artifact bytes, well under one chunk')
    saveArtifactSnapshot(store, task.id, { name: 'note.txt', mime: 'text/plain', bytes }, root)
    const artifact = store.artifacts(task.id)[0]!
    const chunk = await request(`/m/api/matter/artifact?id=${task.id}&artifactId=${artifact.id}&sha256=${artifact.sha256}&offset=0`)
    parseAs('GET /m/api/matter/artifact', await chunk.json())
    const list = await request('/m/api/matters?kind=task')
    parseAs('GET /m/api/matters', await list.json())
  })

  it('matter/insight 真实返回符合 schema(无模型 ⇒ raw)', async () => {
    const task = create('ins'), live = await ready(task.id)
    const res = await request(`/m/api/matter/insight?id=${task.id}&lang=zh-Hans`)
    const body = parseAs('GET /m/api/matter/insight', await res.json()) as { ok: boolean; explanations: Record<string, { source: string }> }
    expect(body.ok).toBe(true)
    expect(body.explanations[live.permissions[0]!.id]?.source).toBe('raw')
  })

  it('chat 一页与 chat/say 真实返回符合 schema(读前没有主人对话 ⇒ 404 也过 schema)', async () => {
    parseAs('GET /m/api/chat', await (await request('/m/api/chat')).json())
    const ms = makeMessagesStore(db)
    for (let i = 0; i < 3; i++) await ms.append({ id: `x${i}`, chatId: 'owner', ts: new Date(Date.UTC(2026, 8, 30, 0, 0, i)).toISOString(), direction: i % 2 ? 'out' : 'in', kind: 'text', text: `t${i}`, source: 'live' })
    const said = await request('/m/api/chat/say', { requestId: randomUUID(), text: '你好' })
    expect(said.status).toBe(200)
    parseAs('POST /m/api/chat/say', await said.json())
    const page = parseAs('GET /m/api/chat', await (await request('/m/api/chat?limit=2')).json()) as { hasMore: boolean; messages: unknown[] }
    expect(page).toMatchObject({ hasMore: true })
    expect(page.messages).toHaveLength(2)
  })

  // 回复交付(2026-10-04):回复行的附件与旁白随页带出,文件只给名字;语音按需合成,只念库里那一行真有的那段。
  it('chat 页带出回复的附件与旁白(文件不带路径),chat/voice 只合成那一行的语音附件', async () => {
    await request('/m/api/chat/say', { requestId: randomUUID(), text: '先登记主人对话' })
    const ms = makeMessagesStore(db)
    const extras = JSON.stringify({
      attachments: [{ kind: 'voice', text: '晚安' }, { kind: 'sticker', label: '开心', file: 'a.png' }, { kind: 'file', name: 'r.pdf', path: '/Users/me/r.pdf' }],
      narration: ['我先看看日程。'],
    })
    await ms.append({ id: 'app:phone:1:out', chatId: 'owner', ts: new Date(Date.UTC(2026, 9, 4)).toISOString(), direction: 'out', kind: 'text', text: '好了', source: 'phone', extras })
    const raw = await (await request('/m/api/chat')).json() as { messages: Array<Record<string, unknown>> }
    expect(JSON.stringify(raw)).not.toContain('/Users/me')
    const page = parseAs('GET /m/api/chat', raw) as { messages: Array<{ id: string; attachments?: unknown; narration?: unknown }> }
    expect(page.messages.find(m => m.id === 'app:phone:1:out')).toMatchObject({
      attachments: [{ kind: 'voice', text: '晚安' }, { kind: 'sticker', label: '开心', file: 'a.png' }, { kind: 'file', name: 'r.pdf' }],
      narration: ['我先看看日程。'],
    })
    const ok = await request('/m/api/chat/voice?id=app:phone:1:out&i=0')
    expect(ok.status).toBe(200)
    expect(parseAs('GET /m/api/chat/voice', await ok.json())).toEqual({ ok: true, mime: 'audio/mpeg', data: Buffer.from('voice:晚安').toString('base64') })
    // 第 1 个是表情,不是语音;没有的行;坏参数 —— 都不念。
    const notVoice = await request('/m/api/chat/voice?id=app:phone:1:out&i=1')
    expect(notVoice.status).toBe(404)
    parseAs('GET /m/api/chat/voice', await notVoice.json())
    expect((await request('/m/api/chat/voice?id=nope&i=0')).status).toBe(404)
    expect((await request('/m/api/chat/voice?id=app:phone:1:out')).status).toBe(400)
  })

  it('matter/changes 真实返回符合 schema(无改动 ⇒ turn:null;未知任务 ⇒ 404)', async () => {
    const task = create('chg')
    const res = await request(`/m/api/matter/changes?id=${task.id}`)
    const body = parseAs('GET /m/api/matter/changes', await res.json()) as { ok: boolean; turn: unknown }
    expect(body).toEqual({ ok: true, turn: null })
    const missing = await request('/m/api/matter/changes?id=deadbeef')
    expect(missing.status).toBe(404)
    parseAs('GET /m/api/matter/changes', await missing.json())
  })
})

// ── 3) 真实返回:随身 CC 首页 / 设置页 / 记忆 / 贴纸(settings-panel.ts 自带的 deps 分支）──

describe('真实返回校验 — 首页 / 设置页 / 记忆 / 贴纸', () => {
  const OWNER = 'owner_schema@im.wechat'
  let dir: string, panel: SettingsPanel, base: string, token: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'phone-schema-panel-'))
    mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
    mkdirSync(join(dir, 'stickers'), { recursive: true })
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude', bot_name: 'CC' }))
    writeFileSync(join(dir, 'memory', OWNER, 'portrait.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><circle cx="1" cy="1" r="1" fill="none" stroke="#5a3f2d"/></svg>')
    writeFileSync(join(dir, 'stickers', 'bear.png'), 'png-bytes')
    panel = makeSettingsPanel({
      stateDir: dir, ownerChatId: () => OWNER,
      chatPrefs: { get: () => ({}), set: (_c, p) => p },
      getUserName: () => '大人', setUserName: async () => {}, log: () => {},
      remote: { isEnabled: () => false, setEnabled: () => {}, requestRestart: () => {} },
      todos: {
        facts: {
          findFacts: (_k, _p, _q, status) => ({ results: status === 'active' ? [{ id: 7, contact: 'wx_f', predicate: '还书', value: '答应还《三体》', time_ref: null, updated_at: 100 }] : [] }),
          setFactStatus: () => ({ ok: true }),
        },
        names: () => [{ username: 'wx_f', display: '小飞' }],
      },
      stickers: { list: () => [{ file: 'bear.png', tags: ['开心'] }], dir: join(dir, 'stickers') },
      feed: {
        journal: { list: () => [{ id: 'j1', ts: '2026-09-06T02:43:36.412Z', chat_id: OWNER, title: '好玩的东西', url: 'https://x', note: '', status: 'new', kind: 'hunt', image_svg: null, matter_id: null }] },
        planLogDays: () => [{ at: '2026-09-06T03:03:55.347Z', chatId: OWNER, candidates: ['visit'], decision: 'none', why: '没朋友,在家歇着。', source: 'model' }],
        turnsRecent: () => [{ chatId: OWNER, endedAt: Date.parse('2026-09-05T01:00:00.000Z'), outcome: 'completed', mode: 'solo', startedAt: Date.parse('2026-09-05T01:00:00.000Z') }],
        timezone: () => 'Asia/Shanghai',
      },
      presence: async () => ({ presence: 'ok' as const, activity: { kind: 'idle' as const, label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }),
      seen: { read: () => null, write: () => {} },
      push: { register: () => true, test: async () => ({ ok: true, code: 'ok' }), unregister: () => {}, forgetAll: () => {} },
      curatedMemory: () => ({
        updated_at: '2026-09-25T04:05:00.000Z', when_label: '今天凌晨 4 点', mood: 'changed' as const, failures: 0,
        changes: [{ kind: 'add' as const, label: '新记下' as const, section: '承诺' as const, text: '周五回话' }],
        sections: [{ name: '偏好' as const, items: [{ id: 'b1', text: '回复直接', display: '回复直接', due: null, due_label: null, person: null, changed: true }] }],
      }),
      now: () => Date.parse('2026-09-06T08:00:00.000Z'),
    })
    const started = await panel.start(0)
    base = `http://127.0.0.1:${started.port}`
    token = panel.issueToken()
  })
  afterEach(async () => { await panel.stop(); removeTempDir(dir) })

  function get(path: string, tok = token) { return fetch(`${base}${path}${path.includes('?') ? '&' : '?'}t=${tok}`) }
  function post(path: string, body: unknown, tok = token) {
    return fetch(`${base}${path}${path.includes('?') ? '&' : '?'}t=${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  function parseAs(key: string, body: unknown) {
    const schema = PHONE_API_SCHEMAS[key]
    expect(schema, `${key} 没有登记 schema`).toBeDefined()
    return schema!.parse(body)
  }

  it('set/api/state(含配对后的设备列表)、set/api/apply、set/api/pair 真实返回符合 schema', async () => {
    const paired = await (await post('/set/api/pair', {})).json()
    token = panel.issueToken()   // 链接令牌一次性(plan 7a):配对后用新码继续
    parseAs('POST /set/api/pair', paired)
    // 设备令牌不能再铸设备令牌(plan 7a D1):403 的回包也在 schema 里。
    const again = await post('/set/api/pair', {}, (paired as { device_token: string }).device_token)
    expect(again.status).toBe(403)
    expect(parseAs('POST /set/api/pair', await again.json())).toEqual({ ok: false, error: 'link_only' })
    const state = await get('/set/api/state')
    parseAs('GET /set/api/state', await state.json())
    const applied = await post('/set/api/apply', { op: 'set_pref', key: 'split', value: true })
    parseAs('POST /set/api/apply', await applied.json())
  })

  it('m/api/state、art/blink、art/presence 真实返回符合 schema', async () => {
    parseAs('GET /m/api/state', await (await get('/m/api/state')).json())
    parseAs('GET /m/api/art/blink', await (await get('/m/api/art/blink')).json())
    parseAs('GET /m/api/art/presence', await (await get('/m/api/art/presence')).json())
  })

  // apps/mobile/src/home.js:10 直接把 r.time_ref 拼进 innerHTML —— schema 必须收得住
  // 这个字段的类型漂移(真实类型是 string|null,src/core/knowledge/store.ts 的 FactRow),
  // 不能是 z.unknown()。
  it('m/api/state 的 todos.active[].time_ref 类型漂移会被 schema 挡住', async () => {
    const body = await (await get('/m/api/state')).json() as { todos: { active: Array<{ time_ref: unknown }> } }
    expect(body.todos.active[0]!.time_ref).toBeNull()
    const mutated = structuredClone(body)
    mutated.todos.active[0]!.time_ref = { not: 'a string' }
    expect(() => parseAs('GET /m/api/state', mutated)).toThrow()
  })

  it('m/api/home、m/api/feed、m/api/seen 真实返回符合 schema', async () => {
    parseAs('GET /m/api/home', await (await get('/m/api/home')).json())
    parseAs('GET /m/api/feed', await (await get('/m/api/feed')).json())
    parseAs('POST /m/api/seen', await (await post('/m/api/seen', { until: '2026-09-06T07:00:00.000Z' })).json())
  })

  it('m/api/push/register、m/api/push/test 真实返回符合 schema', async () => {
    const paired = await (await post('/set/api/pair', {})).json() as { device_token: string }
    token = panel.issueToken()   // 链接令牌一次性(plan 7a):配对后用新码继续
    const dt = paired.device_token
    parseAs('POST /m/api/push/register', await (await post('/m/api/push/register', { platform: 'apns', token: 'ab'.repeat(32) }, dt)).json())
    parseAs('POST /m/api/push/register', await (await post('/m/api/push/register', { platform: 'apns', token: 'ab'.repeat(32) })).json())   // 链接令牌 ⇒ device_only
    const t = await (await post('/m/api/push/test', {}, dt)).json()
    expect(t).toEqual({ ok: true, result: { ok: true, code: 'ok' } })
    parseAs('POST /m/api/push/test', t)
  })

  it('m/api/memory、m/api/todo、m/api/sticker(b64) 真实返回符合 schema', async () => {
    parseAs('GET /m/api/memory', await (await get('/m/api/memory')).json())
    parseAs('POST /m/api/todo', await (await post('/m/api/todo', { id: 7, status: 'resolved' })).json())
    parseAs('GET /m/api/sticker/', await (await get('/m/api/sticker/bear.png?b64=1')).json())
  })
})

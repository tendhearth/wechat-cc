/**
 * P3c-1 并的六条(设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「P3c」):手机令牌从面板那一口走
 * `/v1` 那一个处理器以后,看得见的和并之前 `/m/api` 手机处理器让它看见的**一样多**,不多一点。
 *
 * 并之前,`/v1/matters`、`/v1/matter` 只给 operator(桌面 / CLI,看全部);别人的聊天不到手机、链接令牌不读回复附带的东西、
 * 详情按中继一帧裁 —— 这些写在手机处理器里。P3b 提醒过:`/v1` 处理器把「不是会话令牌」当成不受限,手机令牌要是原样走进去,
 * 就和 operator 同权。这里拿真配对的设备令牌、真发的链接令牌,新键(`/v1/…`)和别名键(`/m/api/…`)两条路都打一遍,
 * 再拿 operator 从 127.0.0.1 打同一条作对照(那边一字不变)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTempDir } from '../../lib/test-temp'
import { createInternalApi, type InternalApi } from './index'
import { makeSettingsPanel, type SettingsPanel } from '../../features/phone/settings-panel'
import { voiceRoutes } from '../../features/voice/routes'
import { phoneMayOpenMatter } from '../../domain/matters/phone-scope'
import type { MattersService } from '../../app/matters/service'

const OWNER = 'owner@im.wechat', GUEST = 'guest@im.wechat'
const TASK = 'aaaa0001', MINE = 'cccc0001', THEIRS = 'dddd0001', BIG = 'eeee0001', HUGE = 'ffff0001'
const row = (id: string, kind: string, ownerChatId: string | null = null) => ({ id, kind, title: id, status: 'open', ownerChatId, updatedAt: 1 })
const ROWS = [row(TASK, 'task'), row(MINE, 'chat', OWNER), row(THEIRS, 'chat', GUEST), row(BIG, 'task'), row(HUGE, 'task')]
const reply = (narration: string[], text = '回你了') => ({ kind: 'message', role: 'cc', text, createdAt: 2, messageId: 'm-1', replyExtras: { narration, attachments: [{ kind: 'file', name: 'a.md' }] } })

let stateDir: string, api: InternalApi, panel: SettingsPanel, localBase: string, operator: string
let device: string, link: string
let service: MattersService
let spies: { seenOnPhone: ReturnType<typeof vi.fn>; say: ReturnType<typeof vi.fn>; searchOwnerChat: ReturnType<typeof vi.fn>; ownerChatFile: ReturnType<typeof vi.fn> }
let transcribe: ReturnType<typeof vi.fn>
let desktopSeen: ReturnType<typeof vi.fn<(matterId: string) => void>>

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'panel-v1-matters-'))
  writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  const detail = vi.fn(async (id: string) => {
    const matter = ROWS.find(r => r.id === id)
    if (!matter) throw new Error('matter_not_found')
    // BIG:旁白大到要裁(去掉旁白就装得下);HUGE:正文本身就装不下
    const events = id === BIG ? [reply(['x'.repeat(200 * 1024)]), reply(['y'.repeat(200 * 1024)])] : id === HUGE ? [reply([], 'z'.repeat(400 * 1024))] : [reply(['找到了'])]
    return { matter, events }
  })
  spies = {
    seenOnPhone: vi.fn(),
    say: vi.fn(async () => ({ kind: 'chat', reply: '好' })),
    searchOwnerChat: vi.fn(async () => ({ hits: [] })),
    ownerChatFile: vi.fn(async () => ({ status: 404, body: { ok: false, error: 'not_found' } })),
  }
  service = { list: vi.fn(() => ROWS), withActs: vi.fn((rows: unknown) => rows), detail, phoneMayOpen: (m: unknown) => phoneMayOpenMatter(m, OWNER), ...spies } as never
  transcribe = vi.fn(async () => ({ text: '你好' }))
  desktopSeen = vi.fn<(matterId: string) => void>()
  api = createInternalApi({ stateDir, daemonPid: 1, matters: service, desktopSeen }, { responseContracts: false })
  api.mount('voice', voiceRoutes({ voice: { transcribe } as never }))
  const s = await api.start()
  localBase = `http://127.0.0.1:${s.port}`
  operator = readFileSync(s.operatorTokenFilePath, 'utf8').trim()
  panel = makeSettingsPanel({
    stateDir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {},
    log: () => {}, tokens: api.panelTokens, v1: api.panelDispatch,
  })
  device = ((await (await viaPanel('/set/api/pair', panel.issueToken(), { method: 'POST' })).json()) as { device_token: string }).device_token
  link = panel.issueToken()
})
afterEach(async () => {
  await panel.stop()
  await api.stop()
  removeTempDir(stateDir)
})

function viaPanel(path: string, tok: string, init: RequestInit = {}) {
  return panel.handleRequest(new Request(`http://127.0.0.1:1${path}${path.includes('?') ? '&' : '?'}${tok.startsWith('d') ? 'd' : 't'}=${tok}`, init))
}
const viaOperator = (path: string, init: RequestInit = {}) => fetch(`${localBase}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${operator}` } })
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ids = (body: unknown) => ((body as { matters: Array<{ id: string }> }).matters).map(m => m.id)

describe('GET /v1/matters:手机令牌只见主人能在手机上打开的', () => {
  it('设备 / 链接令牌(新键与别名键)看不到别人的聊天;operator 照旧看全部', async () => {
    for (const tok of [device, link]) {
      for (const path of ['/v1/matters', '/m/api/matters']) {
        const r = await viaPanel(path, tok)
        expect(r.status, `${tok[0]} ${path}`).toBe(200)
        const got = ids(await r.json())
        if(tok===device)expect(got, `${tok[0]} ${path}`).toContain(MINE)
        else expect(got, `${tok[0]} ${path}`).not.toContain(MINE)
        expect(got, `${tok[0]} ${path}`).not.toContain(THEIRS)
      }
    }
    const op = await viaOperator('/v1/matters')
    expect(op.status).toBe(200)
    expect(ids(await op.json())).toEqual(ROWS.map(r => r.id))
  })

  it('点名 kind 也一样筛;手机令牌读过的记一次手机露面,operator 读不记', async () => {
    const r = await viaPanel('/v1/matters?kind=chat', device)
    expect(ids(await r.json())).not.toContain(THEIRS)
    expect(spies.seenOnPhone).toHaveBeenCalled()
    expect(spies.seenOnPhone.mock.calls.map((c: unknown[]) => c[0])).not.toContain(THEIRS)
    spies.seenOnPhone.mockClear()
    await viaOperator('/v1/matters')
    expect(spies.seenOnPhone).not.toHaveBeenCalled()
  })
})

describe('GET /v1/matter:别人的聊天按 id 也打不开;链接令牌不读回复附带的;按帧裁', () => {
  it('别人的聊天:设备 / 链接令牌 404 matter_not_found(和没有这件一样,也不记露面);operator 200', async () => {
    for (const tok of [device, link]) {
      const v1 = await viaPanel(`/v1/matter?id=${THEIRS}`, tok)
      expect(v1.status).toBe(404)
      expect(await v1.json()).toEqual({ error: 'matter_not_found' })
      const old = await viaPanel(`/m/api/matter?id=${THEIRS}`, tok)
      expect(old.status).toBe(404)
      expect(await old.json()).toEqual({ ok: false, error: 'matter_not_found' })
    }
    expect(spies.seenOnPhone.mock.calls.map((c: unknown[]) => c[0])).not.toContain(THEIRS)
    expect((await viaOperator(`/v1/matter?id=${THEIRS}`)).status).toBe(200)
  })

  it('桌面(operator)读详情 ⇒ 记「在电脑上看过」(S3b),不记手机;手机令牌读 ⇒ 记手机,不记桌面', async () => {
    expect((await viaOperator(`/v1/matter?id=${MINE}`)).status).toBe(200)
    expect(desktopSeen.mock.calls.map((c: unknown[]) => c[0])).toEqual([MINE])
    expect(spies.seenOnPhone).not.toHaveBeenCalled()
    expect((await viaPanel(`/v1/matter?id=${MINE}`, device)).status).toBe(200)
    expect(desktopSeen).toHaveBeenCalledTimes(1)
    expect(spies.seenOnPhone.mock.calls.map((c: unknown[]) => c[0])).toEqual([MINE])
  })

  it('链接令牌:事件里没有 replyExtras / messageId(新键与别名键);设备令牌、operator 有', async () => {
    for (const path of [`/v1/matter?id=${MINE}`, `/m/api/matter?id=${MINE}`]) {
      const denied = await viaPanel(path, link)
      expect(denied.status,path).toBe(404)
      const viaLink = await (await viaPanel(path.replace(MINE,TASK),link)).json() as {events:Array<Record<string,unknown>>}
      expect(viaLink.events,path).toEqual([])
      expect(JSON.stringify(viaLink),path).not.toContain('replyExtras')
      expect(JSON.stringify(viaLink),path).not.toContain('messageId')
      const viaDevice = await (await viaPanel(path, device)).json() as { events: Array<Record<string, unknown>> }
      expect(viaDevice.events[0], path).toHaveProperty('replyExtras')
      expect(viaDevice.events[0], path).toHaveProperty('messageId', 'm-1')
    }
    const op = await (await viaOperator(`/v1/matter?id=${MINE}`)).json() as { events: Array<Record<string, unknown>> }
    expect(op.events[0]).toHaveProperty('replyExtras')
  })

  it('帧预算:手机令牌的详情去掉最早的旁白直到装得下,还装不下 ⇒ 413 detail_too_large;operator 不裁', async () => {
    const big = await (await viaPanel(`/v1/matter?id=${BIG}`, device)).json() as { events: Array<{ replyExtras: Record<string, unknown> }> }
    expect(big.events[0]!.replyExtras).not.toHaveProperty('narration')
    expect(big.events[0]!.replyExtras).toHaveProperty('attachments')
    const huge = await viaPanel(`/v1/matter?id=${HUGE}`, device)
    expect(huge.status).toBe(413)
    expect(await huge.json()).toEqual({ error: 'detail_too_large' })
    const oldHuge = await viaPanel(`/m/api/matter?id=${HUGE}`, device)
    expect(oldHuge.status).toBe(413)
    expect(await oldHuge.json()).toEqual({ ok: false, error: 'detail_too_large' })
    const op = await (await viaOperator(`/v1/matter?id=${BIG}`)).json() as { events: Array<{ replyExtras: Record<string, unknown> }> }
    expect(op.events[0]!.replyExtras).toHaveProperty('narration')
    expect((await viaOperator(`/v1/matter?id=${HUGE}`)).status).toBe(200)
  })
})

describe('只给设备的四条:链接令牌一律 403(LINK_WRITE_OK 不收送话给执行者的),处理器不跑', () => {
  const calls: Array<[string, string, RequestInit?]> = [
    ['POST', '/v1/matter/say', post({ id: TASK, text: 'x' })],
    ['POST', '/m/api/matter/say', post({ id: TASK, text: 'x' })],
    ['GET', '/v1/matter/owner-chat/search?q=a'],
    ['GET', '/m/api/chat/search?q=a'],
    ['GET', '/v1/matter/owner-chat/file?id=m-1&i=0'],
    ['GET', '/m/api/chat/file?id=m-1&i=0'],
    ['POST', '/v1/companion/transcribe', post({ audio_b64: 'AAAA', mime: 'audio/mp4' })],
    ['POST', '/m/api/chat/transcribe', post({ audioBase64: 'AAAA', mime: 'audio/mp4' })],
  ]
  it('链接令牌 403 route_not_allowed;设备令牌能走', async () => {
    for (const [, path, init] of calls) {
      const r = await viaPanel(path, link, init)
      expect(r.status, path).toBe(403)
      expect((await r.json() as { error: string }).error, path).toBe('route_not_allowed')
    }
    expect(spies.say).not.toHaveBeenCalled()
    expect(spies.searchOwnerChat).not.toHaveBeenCalled()
    expect(spies.ownerChatFile).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    for (const [, path, init] of calls) expect((await viaPanel(path, device, init)).status, path).not.toBe(403)
    expect(spies.say).toHaveBeenCalledTimes(2)
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('说一句:手机令牌按手机表面说(附件策略、出生地);operator 照旧按桌面', async () => {
    await viaPanel('/v1/matter/say', device, post({ id: TASK, text: '从手机' }))
    expect(spies.say).toHaveBeenLastCalledWith(TASK, '从手机', 'phone', undefined)
    await viaOperator('/v1/matter/say', post({ id: TASK, text: '从桌面' }))
    expect(spies.say).toHaveBeenLastCalledWith(TASK, '从桌面')
  })
})

describe('POST /v1/matter/seen', () => {
  it('accepts repeated desktop acknowledgements, rejects malformed bodies and phone tokens', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await viaOperator('/v1/matter/seen', post({ id: TASK }))
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true })
    }
    expect(desktopSeen.mock.calls).toEqual([[TASK], [TASK]])
    for (const body of [{}, { id: 'bad' }, { id: TASK, extra: true }, []]) {
      expect((await viaOperator('/v1/matter/seen', post(body))).status).toBe(400)
    }
    for (const tok of [device, link]) {
      expect((await viaPanel('/v1/matter/seen', tok, post({ id: TASK }))).status).not.toBe(200)
    }
    expect(desktopSeen).toHaveBeenCalledTimes(2)
  })
})

it('T5 link: task status keeps current progress, counts and stop identity while excluding private process, requests and files',async()=>{
 vi.mocked(service.detail).mockImplementation(async(id)=>({matter:{...row(id,'task'),projectPath:'/PRIVATE',originMessageId:'PRIVATE-ID'},task:{id,title:id,status:'running',phase:'working',providerId:'codex',path:'/PRIVATE',updatedAt:1,error:null,prompt:'PRIVATE-PROMPT'},runId:'11111111-1111-4111-8111-111111111111',events:[{kind:'text',text:'PRIVATE-RESULT',createdAt:1},{kind:'tool_call',text:'PRIVATE-COMMAND',createdAt:2,activity:{type:'command',status:'running',label:'核对备份'}}],permissions:[{id:'p',taskId:id,createdAt:1,tool:'Bash',description:'PRIVATE-PERMISSION'}],questions:[{id:'q',taskId:id,createdAt:1,questions:[{question:'PRIVATE-QUESTION'}]}],artifacts:[{name:'PRIVATE-FILE'}],inputs:[{text:'PRIVATE-INPUT'}],bindings:[],sessions:[]}) as never)
 for(const path of [`/v1/matter?id=${TASK}`,`/m/api/matter?id=${TASK}`]){
  const linked=await viaPanel(path,link),body=await linked.json() as any;expect(linked.status).toBe(200);expect(JSON.stringify(body)).not.toContain('PRIVATE');expect(body.events[0].activity.label).toBe('核对备份');expect(body.permissions).toHaveLength(1);expect(body.questions).toHaveLength(1);expect(body.runId).toBe('11111111-1111-4111-8111-111111111111')
  const paired=await viaPanel(path,device);expect(JSON.stringify(await paired.json())).toContain('PRIVATE-PERMISSION')
 }
})

/**
 * 信寄到 App(手机伙伴第 2 步,2026-10-18):微信窗口关了 / 微信断着、App 收得到 ⇒ 寄到 App;收不到 ⇒ 照旧等主人开口。
 * 微信寄成 ⇒ 整封记成主人对话里的一行(mirror);存档只读(archive.ts)。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeLetterRuntime, readLetterState, type LetterApp, type LetterDeps } from './runtime'
import { letterPagePath, listLetters } from './archive'
import { letterToApp, LETTER_PUSH_BODY } from './wire'
import { lettersTestSpeech } from './test-speech'
import type { AppChannel } from '../../daemon/companion/proactive-channel'

const TZ = 'Asia/Shanghai'
const EVENING = Date.parse('2026-10-16T12:00:00Z')
const OWNER = 'owner@im.wechat'
const LETTER = JSON.stringify({ salutation: '你好:', paragraphs: ['终于接上 Cursor 了,替你高兴。'], signoff: '' })
const WINDOW_CLOSED = 'ilink/sendmessage errcode=-2: prepare failed'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(o: Partial<LetterDeps> & { appOk?: boolean; deliverable?: boolean; noApp?: boolean; quiet?: () => boolean; careOff?: () => boolean } = {}) {
  const { quiet, careOff, ...over } = o
  const stateDir = mkdtempSync(join(tmpdir(), 'letters-app-'))
  dirs.push(stateDir)
  const wechat: string[] = []
  const mirrored: string[][] = []
  const logs: string[] = []
  const app: LetterApp = {
    deliverable: vi.fn((c: string) => (over.deliverable ?? true) && c === OWNER),
    deliver: vi.fn(async () => over.appOk ?? true),
  }
  let now = EVENING
  const deps: LetterDeps = {
    stateDir, enabled: () => true, timezone: () => TZ, ownerChatId: () => OWNER,
    memory: () => '', chatSince: async () => ['主人:终于接上 Cursor 了'], lastInboundAt: async () => null,
    evalText: () => async () => LETTER, wechatSuspended: () => false,
    sendText: async (_c, t) => { wechat.push(t); return {} },
    sendFile: async (_c, p) => { wechat.push(p) },
    rasterize: (_svg, dir, name) => { mkdirSync(dir, { recursive: true }); const p = join(dir, `${name}.png`); writeFileSync(p, 'png'); return p },
    now: () => now, random: () => 0, newId: () => 'abc123', log: (_t, l) => { logs.push(l) },
    mirror: (_c, pages) => { mirrored.push(pages) },
    speech: lettersTestSpeech({ ...(quiet ? { quiet } : {}), ...(careOff ? { careOff } : {}) }),
    ...(over.noApp ? {} : { app: () => app }),
    ...over,
  }
  return { rt: makeLetterRuntime(deps), app, wechat, mirrored, logs, stateDir, setNow: (v: number) => { now = v } }
}

describe('信:微信不通时寄到 App', () => {
  it('微信窗口关了(-2)+ App 收得到 ⇒ 寄到 App,记 sent_via=app,不再等', async () => {
    const t = setup({ sendFile: async () => { throw new Error(WINDOW_CLOSED) } })
    expect(await t.rt.writeNow()).toEqual({ status: 'sent', id: '2026-10-16-abc123' })
    expect(t.app.deliver).toHaveBeenCalledOnce()
    const [chat, letter] = (t.app.deliver as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(chat).toBe(OWNER)
    expect(letter).toMatchObject({ id: '2026-10-16-abc123', pages: [join(t.stateDir, 'letters', '2026-10-16-abc123', 'page-1.png')] })
    expect(readLetterState(t.stateDir)).toMatchObject({ pending: null, lastSentAt: EVENING })
    expect(listLetters(t.stateDir)[0]).toMatchObject({ id: '2026-10-16-abc123', via: 'app', pages: 1 })
    expect(t.mirrored).toEqual([])   // 微信没寄成,不记「微信那一行」
  })

  it('微信窗口关了 + App 收不到 / 记失败 / 没接 ⇒ 同以前:等主人开口', async () => {
    for (const o of [{ deliverable: false }, { appOk: false }, { noApp: true }]) {
      const t = setup({ ...o, sendFile: async () => { throw new Error(WINDOW_CLOSED) } })
      expect(await t.rt.writeNow()).toEqual({ status: 'waiting', id: '2026-10-16-abc123' })
      expect(readLetterState(t.stateDir).pending?.blockedAt).toBe(EVENING)
      expect(listLetters(t.stateDir)).toEqual([])   // 没寄出去的不进抽屉
    }
  })

  it('已经在等主人开口的那封:下一拍 App 收得到了 ⇒ 寄到 App(不撞微信)', async () => {
    let deliverable = false
    const t = setup({ sendFile: async () => { throw new Error(WINDOW_CLOSED) } })
    ;(t.app.deliverable as ReturnType<typeof vi.fn>).mockImplementation(() => deliverable)
    await t.rt.writeNow()
    expect(readLetterState(t.stateDir).pending).not.toBeNull()
    deliverable = true
    t.setNow(EVENING + 3_600_000)
    await t.rt.tick()
    expect(readLetterState(t.stateDir).pending).toBeNull()
    expect(t.wechat).toEqual([])
  })

  it('微信断着(suspended)+ App 收得到 ⇒ 寄到 App;收不到 ⇒ 照旧等,不碰微信', async () => {
    const a = setup({ wechatSuspended: () => true })
    expect((await a.rt.writeNow()).status).toBe('sent')
    expect(a.wechat).toEqual([])
    const b = setup({ wechatSuspended: () => true, deliverable: false })
    expect((await b.rt.writeNow()).status).toBe('waiting')
    expect(b.wechat).toEqual([])
  })

  it('微信能用 ⇒ 照旧寄微信,整封记成一行(mirror),App 不推', async () => {
    const t = setup()
    expect((await t.rt.writeNow()).status).toBe('sent')
    expect(t.wechat).toHaveLength(1)
    expect(t.mirrored).toEqual([t.wechat])
    expect(t.app.deliver).not.toHaveBeenCalled()
    expect(listLetters(t.stateDir)[0]).toMatchObject({ via: 'wechat' })
  })

  it('不改排期:寄到 App 也照常排下一封', async () => {
    const t = setup({ sendFile: async () => { throw new Error(WINDOW_CLOSED) } })
    await t.rt.tick()   // 第一次只排期
    const due = readLetterState(t.stateDir).dueAt!
    t.setNow(due + 60_000)
    await t.rt.tick()
    const s = readLetterState(t.stateDir)
    expect(s.pending).toBeNull()
    expect(s.dueAt).toBe(due + 60_000 + 24 * 86_400_000)
  })
})

describe('免打扰(10-20):不定期的信在主人的免打扰时段里不写不寄,时段过了照常;当面要的照常', () => {
  it('quiet ⇒ a due letter waits (no compose, still due); after the window it goes', async () => {
    let quiet = true
    const t = setup({ quiet: () => quiet })
    await t.rt.tick()   // 第一次只排期
    const due = readLetterState(t.stateDir).dueAt!
    t.setNow(due + 60_000)
    await t.rt.tick()
    expect(t.wechat).toEqual([])
    expect(readLetterState(t.stateDir).dueAt).toBe(due)
    quiet = false
    await t.rt.tick()
    expect(t.wechat.length).toBeGreaterThan(0)
  })
  it('a letter the owner asked for is not held back', async () => {
    const t = setup({ quiet: () => true })
    const r = await t.rt.writeNow('给我写封信')
    expect(r.status).not.toBe('failed')
    expect(t.wechat.length).toBeGreaterThan(0)
  })
})

describe('别烦我(SpeechPolicy,第三批 3a):不定期的信是 initiative,当面要的是 requested', () => {
  it('到点了但主人说了别烦我 ⇒ 这一封不写(不调模型)、排下一封', async () => {
    const t = setup({ careOff: () => true })
    await t.rt.tick()   // 第一次只排期
    const due = readLetterState(t.stateDir).dueAt!
    t.setNow(due + 60_000)
    await t.rt.tick()
    expect(t.wechat).toEqual([])
    expect(listLetters(t.stateDir)).toEqual([])
    expect(readLetterState(t.stateDir).dueAt).toBeGreaterThan(due)
    expect(t.logs.some(l => l.includes('not written: care_off'))).toBe(true)
  })
  it('写好没寄的不定期的信,主人说了别烦我 ⇒ 不寄了,存档里留着', async () => {
    let off = false
    // 微信窗口关着、App 收不到 ⇒ 写好了但压着
    const t = setup({ careOff: () => off, deliverable: false, sendFile: async () => { throw new Error(WINDOW_CLOSED) } })
    await t.rt.tick()
    t.setNow(readLetterState(t.stateDir).dueAt! + 60_000)
    await t.rt.tick()
    expect(readLetterState(t.stateDir).pending).toBeTruthy()
    off = true
    await t.rt.tick()
    expect(readLetterState(t.stateDir).pending ?? null).toBeNull()
    expect(t.logs.some(l => l.includes('not sent: care_off (kept in archive)'))).toBe(true)
  })
  it('当面要的信 ⇒ 免打扰、别烦我都照写照寄', async () => {
    const t = setup({ quiet: () => true, careOff: () => true })
    const r = await t.rt.writeNow('给我写封信')
    expect(r.status).toBe('sent')
    expect(t.wechat.length).toBeGreaterThan(0)
  })
})

describe('letterToApp —— 几页图记成一行 + 一条推送', () => {
  function fakeApp(ok = true) {
    const app: AppChannel = { deliverable: () => true, record: vi.fn(async () => ok), push: vi.fn() }
    return app
  }
  it('有图 ⇒ 一行(附件 = 存档里那几页的引用)+ 推「CC 给你写了一封信」', async () => {
    const app = fakeApp()
    expect(await letterToApp(app).deliver(OWNER, { id: 'x', pages: ['/s/letters/x/page-1.png', '/s/letters/x/page-2.png'], text: '全文' })).toBe(true)
    expect(app.record).toHaveBeenCalledWith(OWNER, '', [{ kind: 'file', name: 'page-1.png', path: '/s/letters/x/page-1.png' }, { kind: 'file', name: 'page-2.png', path: '/s/letters/x/page-2.png' }])
    expect(app.push).toHaveBeenCalledWith(LETTER_PUSH_BODY)
  })
  it('排不成图 ⇒ 文字(同微信的「(一封信)」);记失败 ⇒ 不推', async () => {
    const app = fakeApp(false)
    expect(await letterToApp(app).deliver(OWNER, { id: 'x', pages: [], text: '全文' })).toBe(false)
    expect(app.record).toHaveBeenCalledWith(OWNER, '（一封信）\n\n全文')
    expect(app.push).not.toHaveBeenCalled()
  })
})

describe('存档(手机「CC 的信」读的)', () => {
  function archive() {
    const stateDir = mkdtempSync(join(tmpdir(), 'letters-archive-'))
    dirs.push(stateDir)
    const put = (id: string, rec: Record<string, unknown>, pages: number) => {
      const dir = join(stateDir, 'letters', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'letter.json'), JSON.stringify({ id, day: id.slice(0, 10), created_at: `${id.slice(0, 10)}T00:00:00Z`, requested: false, letter: { salutation: '你好：', paragraphs: ['第一段'.repeat(30), '第二段'], signoff: '' }, ...rec }))
      for (let i = 1; i <= pages; i++) writeFileSync(join(dir, `page-${i}.png`), `png${i}`)
    }
    return { stateDir, put }
  }
  it('只列寄出去了的,新的在前;开头截短;排不成图的给全文;previews 与坏目录跳过', () => {
    const a = archive()
    put3(a)
    mkdirSync(join(a.stateDir, 'letters', 'previews'), { recursive: true })
    mkdirSync(join(a.stateDir, 'letters', 'broken'), { recursive: true })
    const list = listLetters(a.stateDir)
    expect(list.map(l => l.id)).toEqual(['2026-10-16-bbbbbb', '2026-09-10-aaaaaa'])
    expect(list[0]).toMatchObject({ pages: 2, via: 'app', requested: true, sentAt: Date.parse('2026-10-16T12:00:00Z') })
    expect(list[0]!.text).toBeUndefined()
    expect(list[0]!.opening.endsWith('…')).toBe(true)
    expect([...list[0]!.opening].length).toBe(61)
    expect(list[1]).toMatchObject({ pages: 0, via: 'wechat' })
    expect(list[1]!.text).toContain('— CC')
    expect(listLetters(join(a.stateDir, 'nope'))).toEqual([])
  })
  it('取页:只认 id 形状 + 寄出去了的 + 存在的普通文件(符号链接不认)', () => {
    const a = archive()
    put3(a)
    expect(letterPagePath(a.stateDir, '2026-10-16-bbbbbb', 2)).toBe(join(a.stateDir, 'letters', '2026-10-16-bbbbbb', 'page-2.png'))
    expect(letterPagePath(a.stateDir, '2026-10-16-bbbbbb', 3)).toBeNull()
    expect(letterPagePath(a.stateDir, '2026-10-16-bbbbbb', 0)).toBeNull()
    expect(letterPagePath(a.stateDir, '2026-10-17-cccccc', 1)).toBeNull()   // 还没寄出
    expect(letterPagePath(a.stateDir, '../2026-10-16-bbbbbb', 1)).toBeNull()
    expect(letterPagePath(a.stateDir, 'previews', 1)).toBeNull()
    if (process.platform !== 'win32') {
      a.put('2026-10-18-dddddd', { sent_at: '2026-10-18T12:00:00Z' }, 0)
      symlinkSync('/etc/hosts', join(a.stateDir, 'letters', '2026-10-18-dddddd', 'page-1.png'))
      expect(letterPagePath(a.stateDir, '2026-10-18-dddddd', 1)).toBeNull()
    }
  })
  function put3(a: ReturnType<typeof archive>) {
    a.put('2026-09-10-aaaaaa', { sent_at: '2026-09-10T12:00:00Z' }, 0)
    a.put('2026-10-16-bbbbbb', { sent_at: '2026-10-16T12:00:00Z', sent_via: 'app', requested: true, created_at: '2026-10-16T11:00:00Z' }, 2)
    a.put('2026-10-17-cccccc', { sent_at: null, created_at: '2026-10-17T11:00:00Z' }, 1)
  }
})

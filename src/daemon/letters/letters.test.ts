import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLetterPrompt, cjkQuotes, letterText, parseLetter, BODY_CAP } from './compose'
import { chineseDate, letterSvgs, linesFor, paginate, SIZES } from './render'
import { makeLetterRuntime, readLetterState, type LetterDeps } from './runtime'
import { DAY_MS, GAP_DAYS, inEveningWindow, isLetterDue, nextDueAt } from './schedule'

const TZ = 'Asia/Shanghai'
// 2026-10-16 20:00 上海 = 12:00Z
const EVENING = Date.parse('2026-10-16T12:00:00Z')
const NOON = Date.parse('2026-10-16T04:00:00Z')

describe('schedule', () => {
  it('picks a gap inside the range', () => {
    expect(nextDueAt(0, GAP_DAYS, () => 0)).toBe(24 * DAY_MS)
    expect(nextDueAt(0, GAP_DAYS, () => 1)).toBe(38 * DAY_MS)
  })
  it('writes only in the owner\'s evening window, once due', () => {
    expect(inEveningWindow(EVENING, TZ)).toBe(true)
    expect(inEveningWindow(NOON, TZ)).toBe(false)
    expect(isLetterDue({ nowMs: EVENING, tz: TZ, dueAt: EVENING - 1 })).toBe(true)
    expect(isLetterDue({ nowMs: EVENING, tz: TZ, dueAt: EVENING + 1 })).toBe(false)
    expect(isLetterDue({ nowMs: NOON, tz: TZ, dueAt: 0 })).toBe(false)
    expect(isLetterDue({ nowMs: EVENING, tz: TZ, dueAt: null })).toBe(false)
  })
})

describe('compose', () => {
  const material = { today: '2026-10-16', memory: '- 主人在做 Tendhearth', chat: ['主人:终于接上 Cursor 了'], previous: [] }
  it('prompt carries the material, the no-invention rule and the request', () => {
    const p = buildLetterPrompt({ ...material, request: '今天好累,想要一封信' })
    expect(p).toContain('终于接上 Cursor 了')
    expect(p).toContain('一个细节都不许编')
    expect(p).toContain('今天好累,想要一封信')
    expect(buildLetterPrompt(material)).toContain('没人要你写')
  })
  it('parses a fenced JSON letter', () => {
    const r = parseLetter('```json\n{"salutation":"亲爱的你:","paragraphs":["一","二"],"signoff":"晚安"}\n```')
    expect(r).toEqual({ kind: 'letter', letter: { salutation: '亲爱的你:', paragraphs: ['一', '二'], signoff: '晚安' } })
  })
  it('honours skip and rejects junk', () => {
    expect(parseLetter('{"skip":"素材太少"}')).toEqual({ kind: 'skip', reason: '素材太少' })
    expect(parseLetter('写不出来')).toEqual({ kind: 'skip', reason: 'unparseable' })
    expect(parseLetter('{"paragraphs":[]}')).toEqual({ kind: 'skip', reason: 'empty' })
  })
  it('parses the plain-text letter format', () => {
    const raw = '亲爱的你：\n\n周三晚上你说终于接上 Cursor 了。\n我替你高兴。\n\n这一个月你做了好多事。\n\n晚安。\n\n— CC'
    expect(parseLetter(raw)).toEqual({ kind: 'letter', letter: { salutation: '亲爱的你：', paragraphs: ['周三晚上你说终于接上 Cursor 了。我替你高兴。', '这一个月你做了好多事。'], signoff: '晚安。' } })
  })
  it('takes a short bare first line as the salutation and drops stray colons', () => {
    const r = parseLetter('时瑞\n\n：上次你说终于接上 Cursor 了,我替你高兴了好一阵。\n\n这一个月你做了好多事,我都看见了。')
    expect(r).toMatchObject({ kind: 'letter', letter: { salutation: '时瑞:', paragraphs: ['上次你说终于接上 Cursor 了,我替你高兴了好一阵。', '这一个月你做了好多事,我都看见了。'] } })
  })
  it('turns straight quotes into 「」 in pairs only', () => {
    expect(cjkQuotes('你发来"你好""在么"')).toBe('你发来「你好」「在么」')
    expect(cjkQuotes('他说“好”')).toBe('他说「好」')
    expect(cjkQuotes('一个"落单')).toBe('一个"落单')
  })
  it('reads SKIP in the plain format', () => {
    expect(parseLetter('SKIP：这段时间没怎么聊')).toEqual({ kind: 'skip', reason: '这段时间没怎么聊' })
  })
  it('caps a runaway letter at a paragraph boundary', () => {
    const long = '字'.repeat(400)
    const r = parseLetter(JSON.stringify({ salutation: '你好:', paragraphs: [long, long, long] }))
    expect(r.kind).toBe('letter')
    if (r.kind === 'letter') expect(r.letter.paragraphs.join('').length).toBeLessThanOrEqual(BODY_CAP)
  })
  it('plain text version ends with the signature', () => {
    expect(letterText({ salutation: '你好:', paragraphs: ['一'], signoff: '' })).toMatch(/— CC$/)
  })
})

describe('render', () => {
  it('fits an ordinary letter on one page at the largest size', () => {
    const pages = paginate({ salutation: '你好:', paragraphs: ['今天'.repeat(40), '明天'.repeat(30)], signoff: '晚安' })
    expect(pages).toHaveLength(1)
    expect(pages[0]!.size).toEqual(SIZES[0])
  })
  it('steps the font down before paginating', () => {
    const pages = paginate({ salutation: '你好:', paragraphs: Array.from({ length: 5 }, () => '字'.repeat(80)), signoff: '' })
    expect(pages).toHaveLength(1)
    expect(pages[0]!.size.font).toBeLessThan(SIZES[0]!.font)
  })
  it('paginates very long letters without splitting a paragraph mid-word', () => {
    const paras = Array.from({ length: 8 }, (_, i) => `第${i}段。` + '字'.repeat(90) + '。')
    const pages = paginate({ salutation: '你好:', paragraphs: paras, signoff: '' })
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]!.first && pages[pages.length - 1]!.last).toBe(true)
    const all = pages.flatMap(p => p.lines.map(l => l.text)).join('')
    expect(all).toBe('你好:' + paras.join(''))
  })
  it('escapes markup and puts the date and signature on the page', () => {
    const [svg] = letterSvgs({ salutation: '你好:', paragraphs: ['<script>&'], signoff: '' }, '2026-10-16')
    expect(svg).toContain('&lt;script&gt;&amp;')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('二〇二六年十月十六日')
    expect(svg).toContain('— CC')
  })
  it('counts ASCII as about half a character', () => {
    expect(linesFor('a'.repeat(40), false)).toBe(1)
  })
  it('writes Chinese dates', () => {
    expect(chineseDate('2026-01-09')).toBe('二〇二六年一月九日')
    expect(chineseDate('2026-12-30')).toBe('二〇二六年十二月三十日')
  })
})

describe('runtime', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const LETTER = JSON.stringify({ salutation: '你好:', paragraphs: ['终于接上 Cursor 了,替你高兴。'], signoff: '' })

  function setup(over: Partial<LetterDeps> = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), 'letters-'))
    dirs.push(stateDir)
    const sent: Array<{ kind: 'file' | 'text'; v: string }> = []
    const logs: string[] = []
    let now = EVENING
    let enabled = true
    let evalCalls = 0
    const deps: LetterDeps = {
      stateDir,
      enabled: () => enabled,
      timezone: () => TZ,
      ownerChatId: () => 'owner@im.wechat',
      memory: () => '- 主人在做 Tendhearth',
      chatSince: async () => ['主人:终于接上 Cursor 了'],
      lastInboundAt: async () => null,
      evalText: () => async () => { evalCalls++; return LETTER },
      wechatSuspended: () => false,
      sendText: async (_c, t) => { sent.push({ kind: 'text', v: t }); return {} },
      sendFile: async (_c, p) => { sent.push({ kind: 'file', v: p }) },
      rasterize: (_svg, dir, name) => { mkdirSync(dir, { recursive: true }); const p = join(dir, `${name}.png`); writeFileSync(p, 'png'); return p },
      now: () => now,
      random: () => 0,
      newId: () => 'abc',
      log: (_t, l) => { logs.push(l) },
      ...over,
    }
    return { deps, rt: makeLetterRuntime(deps), sent, logs, stateDir, setNow: (v: number) => { now = v }, setEnabled: (v: boolean) => { enabled = v }, evals: () => evalCalls }
  }

  it('does nothing while off', async () => {
    const t = setup()
    t.setEnabled(false)
    await t.rt.tick()
    expect(readLetterState(t.stateDir).dueAt).toBeNull()
    expect(t.sent).toEqual([])
  })

  it('schedules the first letter, then writes and sends it on a due evening', async () => {
    const t = setup()
    await t.rt.tick()
    const due = readLetterState(t.stateDir).dueAt!
    expect(due).toBe(EVENING + 2 * DAY_MS)
    t.setNow(due + 60_000)
    await t.rt.tick()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]!.kind).toBe('file')
    const s = readLetterState(t.stateDir)
    expect(s.pending).toBeNull()
    expect(s.lastSentAt).toBe(due + 60_000)
    expect(s.dueAt).toBe(due + 60_000 + 24 * DAY_MS)
    const rec = JSON.parse(readFileSync(join(t.stateDir, 'letters', '2026-10-18-abc', 'letter.json'), 'utf8'))
    expect(rec.sent_at).not.toBeNull()
    expect(rec.requested).toBe(false)
    expect(t.rt.status()).toMatchObject({ enabled: true, scheduled: true, pending: null })
    expect(JSON.stringify(t.rt.status())).not.toContain(String(s.dueAt))
  })

  it('does not write at noon even when due', async () => {
    const t = setup()
    await t.rt.tick()
    t.setNow(Date.parse('2026-10-19T04:00:00Z'))
    await t.rt.tick()
    expect(t.evals()).toBe(0)
  })

  it('looks again in a few days when there is nothing to write about', async () => {
    const t = setup({ evalText: () => async () => '{"skip":"这段时间没怎么聊"}' })
    await t.rt.tick()
    const due = readLetterState(t.stateDir).dueAt!
    t.setNow(due)
    await t.rt.tick()
    expect(t.sent).toEqual([])
    expect(readLetterState(t.stateDir).dueAt).toBe(due + 3 * DAY_MS)
  })

  it('holds the letter while WeChat refuses proactive sends, and sends it after the owner speaks', async () => {
    let refuse = true
    let inbound: number | null = null
    const t = setup({
      sendFile: async () => { if (refuse) throw new Error('ilink/sendmessage errcode=-2: prepare failed') },
      lastInboundAt: async () => inbound,
    })
    const r = await t.rt.writeNow('想要一封信')
    expect(r).toEqual({ status: 'waiting', id: '2026-10-16-abc' })
    expect(readLetterState(t.stateDir).pending?.blockedAt).toBe(EVENING)
    refuse = false
    t.setNow(EVENING + 3_600_000)
    await t.rt.tick()   // 主人还没开口:不撞关着的窗口
    expect(readLetterState(t.stateDir).pending).not.toBeNull()
    inbound = EVENING + 2 * 3_600_000
    t.setNow(EVENING + 3 * 3_600_000)
    await t.rt.tick()
    expect(readLetterState(t.stateDir).pending).toBeNull()
    expect(t.rt.status().letters[0]).toMatchObject({ requested: true })
  })

  it('gives up after three ordinary failures but keeps the letter in the archive', async () => {
    const t = setup({ sendFile: async () => { throw new Error('upload failed') } })
    await t.rt.writeNow()
    await t.rt.tick()
    await t.rt.tick()
    expect(readLetterState(t.stateDir).pending).toBeNull()
    expect(t.rt.status().letters).toHaveLength(1)
    expect(t.rt.status().letters[0]!.sent_at).toBeNull()
  })

  it('falls back to text when the page cannot be rendered', async () => {
    const t = setup({ rasterize: () => null })
    await t.rt.writeNow()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({ kind: 'text' })
    expect(t.sent[0]!.v).toContain('替你高兴')
  })

  it('tells the owner when a requested letter could not be written', async () => {
    const t = setup({ evalText: () => null })
    expect(await t.rt.writeNow()).toEqual({ status: 'failed', reason: 'no_model' })
    expect(t.sent[0]!.v).toContain('没写成')
  })

  it('rewrites once when the draft sounds like reading a file', async () => {
    const prompts: string[] = []
    const drafts = [
      JSON.stringify({ salutation: '你好:', paragraphs: ['刚才翻到那条消息,你说终于接上 Cursor 了。'], signoff: '' }),
      JSON.stringify({ salutation: '你好:', paragraphs: ['你说终于接上 Cursor 了,我一直记得。'], signoff: '' }),
    ]
    const t = setup({ evalText: () => async (p) => { prompts.push(p); return drafts[prompts.length - 1]! } })
    await t.rt.writeNow()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('「翻到」')
    expect(t.rt.status().letters[0]!.opening).toContain('我一直记得')
  })

  it('a requested letter works while scheduled letters are off', async () => {
    const t = setup()
    t.setEnabled(false)
    expect((await t.rt.writeNow()).status).toBe('sent')
    expect(readLetterState(t.stateDir).dueAt).toBeNull()
  })
})

describe('runtime preview', () => {
  it('renders without filing, sending or scheduling', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'letters-pv-'))
    const sent: string[] = []
    const rt = makeLetterRuntime({
      stateDir, enabled: () => true, timezone: () => TZ, ownerChatId: () => 'o',
      memory: () => '', chatSince: async () => [], lastInboundAt: async () => null,
      evalText: () => async () => JSON.stringify({ salutation: '你好:', paragraphs: ['一'], signoff: '' }),
      wechatSuspended: () => false, sendText: async (_c, t) => { sent.push(t); return {} }, sendFile: async (_c, p) => { sent.push(p) },
      rasterize: (_s, dir, name) => join(dir, `${name}.png`), now: () => EVENING, random: () => 0, newId: () => 'x', log: () => {},
    })
    const r = await rt.preview()
    expect(r.status).toBe('ok')
    expect(sent).toEqual([])
    expect(rt.status().letters).toEqual([])
    expect(readLetterState(stateDir)).toMatchObject({ dueAt: null, pending: null })
    rmSync(stateDir, { recursive: true, force: true })
  })
})

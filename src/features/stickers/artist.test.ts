import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { openTestDb } from '../../lib/db'
import { makeCcActs } from '../../adapters/store/cc-acts'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { NetworkUnprotectedError } from '../../lib/network-gate'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeStickerLib } from './stickers'
import { pickMissingMood, pickDrawTarget, buildStickerPrompt, runStickerArtist, STICKER_MOOD_POOL, STICKER_MOOD_POOL_EXTENDED, CC_DRAWN_CAP } from './artist'

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><circle cx="160" cy="150" r="90" fill="#f5ead8" stroke="#5a3f2d" stroke-width="4"/></svg>'

function tempPng(dir: string): string {
  const p = join(dir, `cc-drawn-${Math.random().toString(36).slice(2)}.png`)
  writeFileSync(p, 'png-bytes')
  return p
}

describe('pickMissingMood', () => {
  it('returns the first pool mood not already tagged; null when all covered', () => {
    expect(pickMissingMood([])).toBe(STICKER_MOOD_POOL[0])
    expect(pickMissingMood([STICKER_MOOD_POOL[0]!])).toBe(STICKER_MOOD_POOL[1])
    expect(pickMissingMood([...STICKER_MOOD_POOL])).toBeNull()
    expect(pickMissingMood([` ${STICKER_MOOD_POOL[0]!} `])).toBe(STICKER_MOOD_POOL[1])  // trim-insensitive
  })
})

describe('buildStickerPrompt', () => {
  it('asks CC to draw ITSELF expressing the mood, SVG-only, allowlist-friendly', () => {
    const p = buildStickerPrompt('晚安')
    expect(p).toContain('晚安')
    expect(p).toContain('为你自己设计')
    expect(p).toContain('只输出 JSON')
    expect(p).toContain('不要重画身体')
  })
})

describe('runStickerArtist', () => {
  function setup(over: { tags?: string[][]; evalOut?: string; rasterOk?: boolean } = {}) {
    const stateDir = mkdtempSync(join(tmpdir(), 'artist-'))
    const lib = makeStickerLib(stateDir)
    for (const tags of over.tags ?? []) {
      const src = join(stateDir, `seed${Math.random().toString(36).slice(2)}.png`)
      writeFileSync(src, 'x')
      lib.save(src, tags)
    }
    const cheapEval = vi.fn(async () => over.evalOut ?? JSON.stringify({form:"dark",pose:"company",sceneSvg:GOOD_SVG}))
    const rasterize = vi.fn(async (_svg: string, workDir: string) =>
      over.rasterOk === false ? null : tempPng(workDir))
    const notify = vi.fn(async () => {})
    return { stateDir, lib, cheapEval, rasterize, notify }
  }

  it('draws one missing mood, saves it tagged, notifies, and stamps the marker', async () => {
    const { stateDir, lib, cheapEval, rasterize, notify } = setup()
    const r = await runStickerArtist({ stateDir, lib, cheapEval, rasterize, notify, log: () => {}, now: () => 1_000 })
    expect(r.drawn).toBe(STICKER_MOOD_POOL[0])
    expect(lib.allTags()).toContain(STICKER_MOOD_POOL[0])
    expect(notify).toHaveBeenCalledWith(STICKER_MOOD_POOL[0])
    // second run same instant → interval gate, no second draw
    const r2 = await runStickerArtist({ stateDir, lib, cheapEval, rasterize, notify, log: () => {}, now: () => 2_000 })
    expect(r2.drawn).toBeNull()
    expect(cheapEval).toHaveBeenCalledTimes(1)
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('「贴纸」那件事(M5b):画成了 = 一轮(画了什么一步、说了没有一步);被节奏门挡下不开轮;渲染失败也收掉', async () => {
    const turns: Array<{ policy: unknown; steps: unknown[]; end?: unknown[]; startedAt?: number }> = []
    const actsOn = (turns: Array<{ policy: unknown; steps: unknown[]; end?: unknown[]; startedAt?: number }>) => ({
      begin: (_w: string, o?: { policy?: unknown; startedAt?: number }) => { const t: (typeof turns)[number] = { policy: o?.policy, steps: [], ...(o?.startedAt !== undefined ? { startedAt: o.startedAt } : {}) }; turns.push(t); return { id: 't', step: (k: string, p: unknown) => { t.steps.push([k, p]) }, finish: (st: string, f?: { errorCode?: string }) => { t.end ??= [st, f?.errorCode] } } },
      // M5d:节奏门读这件事最近一轮的 startedAt
      runs: () => [...turns].reverse().map(t => ({ startedAt: t.startedAt ?? 0, errorCode: (t.end?.[1] as string | undefined) ?? null })),
    })
    const acts = actsOn(turns)
    const a = setup()
    a.notify.mockResolvedValue('sent' as never)
    await runStickerArtist({ ...a, acts: acts as never, log: () => {}, now: () => 1_000 })
    await runStickerArtist({ ...a, acts: acts as never, log: () => {}, now: () => 2_000 })   // 节奏门
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ policy: { mood: STICKER_MOOD_POOL[0] }, end: ['completed', undefined] })
    expect(turns[0]!.steps.map(x => (x as unknown[])[0])).toEqual(['artifact', 'delivery'])
    expect((turns[0]!.steps[1] as unknown[])[1]).toEqual({ mood: STICKER_MOOD_POOL[0], result: 'sent' })
    const b = setup({ rasterOk: false }), bTurns: typeof turns = []
    await runStickerArtist({ ...b, acts: actsOn(bTurns) as never, log: () => {}, now: () => 1_000 })
    expect(bTurns[0]).toMatchObject({ steps: [], end: ['failed', 'render_failed'] })
    rmSync(a.stateDir, { recursive: true, force: true }); rmSync(b.stateDir, { recursive: true, force: true })
  })

  it('both pools covered + no CC-drawn variations possible → no model call', async () => {
    const { stateDir, lib, cheapEval, rasterize, notify } = setup({
      tags: [...STICKER_MOOD_POOL, ...STICKER_MOOD_POOL_EXTENDED].map(m => [m]),
    })
    const r = await runStickerArtist({ stateDir, lib, cheapEval, rasterize, notify, log: () => {}, now: () => 1_000 })
    expect(r.drawn).toBeNull()
    expect(cheapEval).not.toHaveBeenCalled()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('growth curve: phase 1 daily; phase 2 weekly; variations after both pools; cap retires the brush', () => {
    const entry = (file: string, tag: string) => ({ file, tags: [tag] })
    // phase 1: first uncovered base mood, daily cadence
    const t1 = pickDrawTarget([])!
    expect(t1.mood).toBe(STICKER_MOOD_POOL[0])
    expect(t1.intervalMs).toBeLessThan(24 * 3600_000)
    // phase 2: base covered → extended mood, weekly cadence
    const base = STICKER_MOOD_POOL.map((m, i) => entry(`cc-drawn-${i}.png`, m))
    const t2 = pickDrawTarget(base)!
    expect(t2.mood).toBe(STICKER_MOOD_POOL_EXTENDED[0])
    expect(t2.intervalMs).toBeGreaterThan(100 * 3600_000)
    // variations: both pools covered → a new take on an existing CC-drawn mood
    const all = [...base, ...STICKER_MOOD_POOL_EXTENDED.map((m, i) => entry(`cc-drawn-x${i}.png`, m))]
    const t3 = pickDrawTarget(all, () => 0)!
    expect(t3.variation).toBe(true)
    expect(t3.mood).toBe(STICKER_MOOD_POOL[0])
    // cap: CC_DRAWN_CAP drawn files → done
    const capped = Array.from({ length: CC_DRAWN_CAP }, (_, i) => entry(`cc-drawn-c${i}.png`, STICKER_MOOD_POOL[i % 10]!))
      .concat(STICKER_MOOD_POOL_EXTENDED.map((m, i) => entry(`seed${i}.png`, m)))
    expect(pickDrawTarget(capped)).toBeNull()
    // starter-pack files (non cc-drawn) never count toward the cap
    const starterOnly = [...STICKER_MOOD_POOL, ...STICKER_MOOD_POOL_EXTENDED].map((m, i) => entry(`starter${i}.png`, m))
    expect(pickDrawTarget(starterOnly)).toBeNull()   // nothing CC-drawn to vary either
  })

  it('variation prompt asks for a different take', () => {
    const p = buildStickerPrompt('晚安', { variation: true })
    expect(p).toContain('保持角色结构')
    expect(p).toContain('换一个构图/眼神/C 姿势/小道具')
  })

  it('unsafe SVG or failed rasterize → nothing saved, notify not called, marker still stamped', async () => {
    const bad = setup({ evalOut: '<svg onload="alert(1)"><circle r="5"/></svg>' })
    const r1 = await runStickerArtist({ stateDir: bad.stateDir, lib: bad.lib, cheapEval: bad.cheapEval, rasterize: bad.rasterize, notify: bad.notify, log: () => {}, now: () => 1_000 })
    expect(r1.drawn).toBeNull()
    expect(bad.lib.list()).toHaveLength(0)
    expect(bad.notify).not.toHaveBeenCalled()
    rmSync(bad.stateDir, { recursive: true, force: true })

    const noRaster = setup({ rasterOk: false })
    const r2 = await runStickerArtist({ stateDir: noRaster.stateDir, lib: noRaster.lib, cheapEval: noRaster.cheapEval, rasterize: noRaster.rasterize, notify: noRaster.notify, log: () => {}, now: () => 1_000 })
    expect(r2.drawn).toBeNull()
    expect(noRaster.lib.list()).toHaveLength(0)
    rmSync(noRaster.stateDir, { recursive: true, force: true })
  })

  it('notify failure is non-fatal — the sticker stays in the library', async () => {
    const { stateDir, lib, cheapEval, rasterize } = setup()
    const notify = vi.fn(async () => { throw new Error('prepare failed') })
    const r = await runStickerArtist({ stateDir, lib, cheapEval, rasterize, notify, log: () => {}, now: () => 1_000 })
    expect(r.drawn).toBe(STICKER_MOOD_POOL[0])
    expect(lib.allTags()).toContain(STICKER_MOOD_POOL[0])
    rmSync(stateDir, { recursive: true, force: true })
  })
  it('M5d:节奏门的「上次试画」从「贴纸」那件事的轮推,不再写 sticker-artist.json;旧标记照样挡;网络守护拒掉的那一轮不算;开不出轮才退回写旧标记', async () => {
    const db = openTestDb()
    const acts = makeCcActs({ db, log: makeMatterLog(db), matters: makeMatterStore(db) })
    const a = setup()
    const marker = join(a.stateDir, 'sticker-artist.json')
    expect((await runStickerArtist({ ...a, acts, log: () => {}, now: () => 1_000 })).drawn).toBe(STICKER_MOOD_POOL[0])
    expect(existsSync(marker)).toBe(false)
    expect((await runStickerArtist({ ...a, acts, log: () => {}, now: () => 2_000 })).drawn).toBeNull()   // 一天一次:轮挡住
    expect(a.cheapEval).toHaveBeenCalledTimes(1)
    // 旧标记(M5d 之前写的),还没有轮:照样挡
    const b = setup()
    writeFileSync(join(b.stateDir, 'sticker-artist.json'), JSON.stringify({ last_at: 1_000 }))
    const db2 = openTestDb(), acts2 = makeCcActs({ db: db2, log: makeMatterLog(db2), matters: makeMatterStore(db2) })
    expect((await runStickerArtist({ ...b, acts: acts2, log: () => {}, now: () => 2_000 })).drawn).toBeNull()
    expect(b.cheapEval).not.toHaveBeenCalled()
    // 被网络守护拒掉:那一轮记成 network_unprotected,不算一次尝试,下一拍再来
    const c = setup()
    let refuse = true
    const cheapEval = vi.fn(async () => {
      if (refuse) throw new NetworkUnprotectedError({ safe: false, source: 'bx', detail: 'bx 未保护' }, 'Claude')
      return JSON.stringify({ form: 'dark', pose: 'company', sceneSvg: GOOD_SVG })
    })
    const db3 = openTestDb(), acts3 = makeCcActs({ db: db3, log: makeMatterLog(db3), matters: makeMatterStore(db3) })
    expect((await runStickerArtist({ ...c, cheapEval, acts: acts3, log: () => {}, now: () => 1_000 })).drawn).toBeNull()
    refuse = false
    expect((await runStickerArtist({ ...c, cheapEval, acts: acts3, log: () => {}, now: () => 2_000 })).drawn).toBe(STICKER_MOOD_POOL[0])
    expect(acts3.runs('stickers').map(t => t.errorCode)).toEqual([null, 'network_unprotected'])
    // 开不出轮(库写不进)⇒ 退回写旧标记,坏掉的库不会让每一拍都去调模型
    const d = setup()
    const broken = { begin: () => ({ id: null, step: () => false, finish: () => false }), runs: () => [] }
    await runStickerArtist({ ...d, acts: broken, log: () => {}, now: () => 1_000 })
    expect(JSON.parse(readFileSync(join(d.stateDir, 'sticker-artist.json'), 'utf8'))).toEqual({ last_at: 1_000 })
    expect((await runStickerArtist({ ...d, acts: broken, log: () => {}, now: () => 2_000 })).drawn).toBeNull()
    expect(d.cheapEval).toHaveBeenCalledTimes(1)
    for (const x of [a, b, c, d]) rmSync(x.stateDir, { recursive: true, force: true })
    db.close(); db2.close(); db3.close()
  })
})

// 评审 #193 P2-3:画画那次模型调用被网络守护拒了 —— 不算「试过一次」,标记不前移,下一拍还能画。
describe('runStickerArtist — guard refusal (review #193)', () => {
  it('refused eval → marker unchanged (no attempt consumed), next run tries again', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'artist-guard-'))
    const lib = makeStickerLib(stateDir)
    let refuse = true
    const cheapEval = vi.fn(async () => {
      if (refuse) throw new NetworkUnprotectedError({ safe: false, source: 'bx', detail: 'bx 未保护' }, 'Claude')
      return JSON.stringify({ form: 'dark', pose: 'company', sceneSvg: GOOD_SVG })
    })
    const rasterize = vi.fn(async (_svg: string, workDir: string) => tempPng(workDir))
    const d = { stateDir, lib, cheapEval, rasterize, notify: vi.fn(async () => {}), log: () => {} }
    expect((await runStickerArtist({ ...d, now: () => 1_000 })).drawn).toBeNull()
    expect(existsSync(join(stateDir, 'sticker-artist.json'))).toBe(false)
    refuse = false
    expect((await runStickerArtist({ ...d, now: () => 2_000 })).drawn).toBe(STICKER_MOOD_POOL[0])
    expect(cheapEval).toHaveBeenCalledTimes(2)
    rmSync(stateDir, { recursive: true, force: true })
  })

})

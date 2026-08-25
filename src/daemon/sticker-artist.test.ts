import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeStickerLib } from './stickers'
import { pickMissingMood, buildStickerPrompt, runStickerArtist, STICKER_MOOD_POOL } from './sticker-artist'

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><circle cx="160" cy="150" r="90" fill="#f5ead8" stroke="#5a3f2d" stroke-width="4"/></svg>'

function tempPng(dir: string): string {
  const p = join(dir, 'drawn.png')
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
    expect(p).toContain('画你自己')
    expect(p).toContain('只输出 SVG')
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
    const cheapEval = vi.fn(async () => over.evalOut ?? `画好了:\n${GOOD_SVG}`)
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

  it('all moods covered → no model call, no marker churn', async () => {
    const { stateDir, lib, cheapEval, rasterize, notify } = setup({ tags: STICKER_MOOD_POOL.map(m => [m]) })
    const r = await runStickerArtist({ stateDir, lib, cheapEval, rasterize, notify, log: () => {}, now: () => 1_000 })
    expect(r.drawn).toBeNull()
    expect(cheapEval).not.toHaveBeenCalled()
    rmSync(stateDir, { recursive: true, force: true })
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
})

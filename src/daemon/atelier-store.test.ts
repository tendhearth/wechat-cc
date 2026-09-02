import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAtelierStore } from './atelier-store'
import type { ArtImpulse } from './art-impulse'

const impulse: ArtImpulse = {
  shouldPaint: true,
  feeling: '安静但仍有一点牵挂',
  whyNow: '一段只应该留在本机的原因',
  subject: '两条错开的鱼',
  surface: '潮湿的沙滩',
  medium: '一根小树枝',
  gesture: '轻轻地反复描画',
  composition: '主体靠近水线，其余留白',
  shareIntent: 'private',
}

function png(width = 64, height = 32): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'wcc-atelier-'))
}

describe('atelier store', () => {
  it('atomically saves image and metadata while keeping whyNow local-only', () => {
    const stateDir = freshDir()
    const store = makeAtelierStore(stateDir, { makeId: () => 'work-1', now: () => new Date('2026-09-01T12:00:00Z') })
    const record = store.save({
      imageBytes: png(), impulse, privateCauseSummary: impulse.whyNow,
      rendererId: 'fake-brush:v1', caption: '我把它画在退潮以后。',
    })
    expect(record).toMatchObject({ id: 'work-1', width: 64, height: 32, shareState: 'private' })
    expect(record.impulse).not.toHaveProperty('whyNow')
    expect(record.privateCauseSummary).toBe(impulse.whyNow)
    expect(existsSync(join(stateDir, 'atelier', 'works', 'work-1.png'))).toBe(true)
    expect(store.load('work-1')).toEqual(record)
    expect(readdirSync(join(stateDir, 'atelier', 'works')).some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('lists newest first, respects bounds, and skips corrupt records', () => {
    const stateDir = freshDir()
    const ids = ['old', 'new']
    const store = makeAtelierStore(stateDir, { makeId: () => ids.shift()! })
    store.save({ imageBytes: png(), impulse, rendererId: 'fake', createdAt: '2026-08-30T00:00:00Z' })
    store.save({ imageBytes: png(), impulse, rendererId: 'fake', createdAt: '2026-09-01T00:00:00Z' })
    writeFileSync(join(stateDir, 'atelier', 'works', 'broken.json'), '{oops')
    expect(store.list(1).map(record => record.id)).toEqual(['new'])
    expect(store.list(10).map(record => record.id)).toEqual(['new', 'old'])
    writeFileSync(join(stateDir, 'atelier', 'works', 'new.png'), new Uint8Array([1, 2, 3]))
    expect(store.list(10).map(record => record.id)).toEqual(['old'])
  })

  it('rejects path traversal and never resolves uncommitted images', () => {
    const stateDir = freshDir()
    const store = makeAtelierStore(stateDir)
    expect(store.load('../secret')).toBeNull()
    expect(store.imagePath('../secret')).toBeNull()
    const works = join(stateDir, 'atelier', 'works')
    const initialized = makeAtelierStore(stateDir, { makeId: () => 'seed' })
    initialized.save({ imageBytes: png(), impulse, rendererId: 'fake' })
    writeFileSync(join(works, 'orphan.png'), png())
    expect(store.imagePath('orphan')).toBeNull()
  })

  it('rejects invalid, oversized, or implausibly large PNGs and duplicate ids', () => {
    const stateDir = freshDir()
    const store = makeAtelierStore(stateDir, { makeId: () => 'same', maxBytes: 40 })
    expect(() => store.save({ imageBytes: new Uint8Array([1, 2, 3]), impulse, rendererId: 'fake' })).toThrow(/PNG|bytes/)
    expect(() => store.save({ imageBytes: png(8192, 8192), impulse, rendererId: 'fake' })).toThrow(/dimensions/)
    store.save({ imageBytes: png(), impulse, rendererId: 'fake' })
    expect(() => store.save({ imageBytes: png(), impulse, rendererId: 'fake' })).toThrow(/already exists/)
    expect(() => store.save({ imageBytes: new Uint8Array(41), impulse, rendererId: 'fake' })).toThrow(/too large/)
  })
})

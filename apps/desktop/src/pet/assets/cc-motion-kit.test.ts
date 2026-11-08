import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readRGBA } from '../../../scripts/cc-png.mjs'

const root = resolve(__dirname, '../../assets/pet/cc-v1')
const raw = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const behaviors = ['thinking', 'working', 'permission', 'receive', 'done', 'look', 'sleep', 'wake', 'error', 'drag']
const bytes = (path: string) => readFileSync(join(root, path))
const hash = (path: string) => createHash('sha256').update(bytes(path)).digest('hex')

describe('paired continuous CC motion materials', () => {
  it('gives both states the same complete performances with individually registered geometry masks', () => {
    expect(raw.artStatus).toBe('production-candidate')
    for (const behavior of behaviors) {
      const light = raw.forms.lit.states[behavior]
      const dark = raw.forms.unlit.states[behavior]
      expect(light.frames.length).toBeGreaterThanOrEqual(8)
      expect(dark.frames).toHaveLength(light.frames.length)
      expect(dark.fps).toBe(light.fps)
      expect(dark.loop).toBe(light.loop)
      expect(new Set(light.frames.map(hash)).size).toBeGreaterThanOrEqual(3)
      expect(new Set(dark.frames.map(hash)).size).toBeGreaterThanOrEqual(3)
      for (let i = 0; i < light.frames.length; i++) {
        const a = raw.assets[light.frames[i]]
        const b = raw.assets[dark.frames[i]]
        expect(a.geometryMask).toBe(b.geometryMask)
        expect(a.artStatus).toBe('production-candidate')
        expect(b.artStatus).toBe('production-candidate')
        expect(a.visualReview.owner).toBeUndefined()
        expect(b.visualReview.owner).toBeUndefined()
        expect(raw.assets[a.geometryMask].sha256).toBe(hash(a.geometryMask))
      }
    }
  })

  it('closes sustained loops and returns completed gestures to exact accepted canonical bytes', () => {
    for (const form of ['lit', 'unlit']) {
      const states = raw.forms[form].states
      for (const behavior of ['thinking', 'working', 'permission', 'sleep']) {
        const frames = states[behavior].frames
        expect(hash(frames[0])).toBe(hash(frames.at(-1)))
      }
      for (const behavior of ['receive', 'done', 'error', 'look']) {
        const frames = states[behavior].frames
        expect(bytes(frames[0]).equals(bytes(`canonical/${form}/front.png`))).toBe(true)
        expect(bytes(frames.at(-1)).equals(bytes(`canonical/${form}/front.png`))).toBe(true)
      }
    }
  })

  it('keeps Dark matte and both forms registered to the same fixed feet across every new pose', () => {
    const base = readRGBA(bytes('masks/front.png')).alpha
    for (const behavior of behaviors) {
      const light = raw.forms.lit.states[behavior].frames
      const dark = raw.forms.unlit.states[behavior].frames
      for (let n = 0; n < light.length; n++) {
        const entity = readRGBA(bytes(raw.assets[light[n]].geometryMask)).alpha
        const a = readRGBA(bytes(light[n])).alpha
        const b = readRGBA(bytes(dark[n])).alpha
        expect(b.equals(entity)).toBe(true)
        expect(a.every((v, i) => v >= entity[i]! && (entity[i]! < 250 || v === entity[i]))).toBe(true)
        expect(a.every((v, i) => entity[i] !== 0 || v <= 89)).toBe(true)
        expect(entity.subarray(300 * 512).every((v, i) => (v >= 128) === (base[300 * 512 + i]! >= 128))).toBe(true)
        expect(entity.subarray(469 * 512, 470 * 512).some(v => v > 0)).toBe(true)
      }
    }
  }, 60_000)
})

import { describe, expect, it } from 'vitest'
import { buildMotionPlan, sampleClip } from './cc-motion-recipes.mjs'

describe('CC authored motion recipes', () => {
  it('eases a true completion into the happy C and back to the exact resting pose', () => {
    expect(sampleClip('done', 0)).toEqual({ pose: {}, eyeScale: 1, crescent: 0, gaze: 0 })
    expect(sampleClip('done', 0.4)).toEqual({ pose: { happy: 1 }, eyeScale: 1, crescent: 1, gaze: 0 })
    expect(sampleClip('done', 1)).toEqual(sampleClip('done', 0))
    const before = sampleClip('done', 0.1)
    expect(before.pose.happy).toBeGreaterThan(0)
    expect(before.pose.happy).toBeLessThan(1)
  })

  it('keeps sustained loops closed and all C deformations inside the frozen shape-key envelope', () => {
    const plan = buildMotionPlan()
    for (const clip of plan.clips) {
      if (clip.loop) expect(sampleClip(clip.id, 1)).toEqual(sampleClip(clip.id, 0))
      for (const frame of clip.frames) {
        expect(Object.values(frame.pose).every(v => v >= 0 && v <= 1)).toBe(true)
        expect(Object.values(frame.pose).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1.000001)
        expect(frame.eyeScale).toBeGreaterThanOrEqual(0.12)
        expect(frame.eyeScale).toBeLessThanOrEqual(1.15)
        expect(Math.abs(frame.gaze)).toBeLessThanOrEqual(0.07)
        expect(Object.keys(frame).sort()).toEqual(['crescent', 'eyeScale', 'gaze', 'pose'])
      }
    }
  })

  it('looks both ways then returns without moving the body or introducing a new behavior', () => {
    expect(sampleClip('look', 0.25).gaze).toBe(0.07)
    expect(sampleClip('look', 0.65).gaze).toBe(-0.05)
    expect(sampleClip('look', 1)).toEqual({ pose: {}, eyeScale: 1, crescent: 0, gaze: 0 })
    const plan = buildMotionPlan()
    expect(plan.clips.map(c => c.id).sort()).toEqual(['done', 'drag', 'error', 'look', 'permission', 'receive', 'sleep', 'thinking', 'wake', 'working'])
    expect(plan.forms).toEqual(['lit', 'unlit'])
    expect(plan.artStatus).toBe('production-candidate')
  })

  it('clamps sampling to clip endpoints and rejects invalid recipes instead of silently emitting idle', () => {
    expect(sampleClip('receive', -4)).toEqual(sampleClip('receive', 0))
    expect(sampleClip('receive', 9)).toEqual(sampleClip('receive', 1))
    expect(() => sampleClip('made-up', 0)).toThrow('Unknown CC motion')
    expect(() => sampleClip('working', Number.NaN)).toThrow('finite')
  })
})

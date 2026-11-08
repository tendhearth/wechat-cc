// Numeric performances for the owner-frozen C rig. No body/camera/material changes.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @typedef {{ pose: Record<string, number>, eyeScale: number, crescent: number, gaze: number }} MotionFrame */

const frame = (pose = {}, eyeScale = 1, crescent = 0, gaze = 0) => ({ pose, eyeScale, crescent, gaze })
const rest = () => frame()
const listen = (weight = 1, eyes = 1) => frame({ listening: weight }, eyes)

const clips = [
  { id: 'thinking', title: '想一想', fps: 6, count: 12, loop: true, knots: [
    [0, listen(0.94, 0.18)], [0.3, listen(1, 0.12)], [0.65, listen(0.88, 0.24)], [1, listen(0.94, 0.18)],
  ] },
  { id: 'working', title: '正在做', fps: 8, count: 16, loop: true, knots: [
    [0, listen(0.9)], [0.25, listen(1)], [0.45, listen(0.93)], [0.55, listen(0.91, 0.12)], [0.65, listen(0.9)], [0.8, listen(0.96)], [1, listen(0.9)],
  ] },
  { id: 'permission', title: '等你决定', fps: 4, count: 12, loop: true, knots: [
    [0, frame({ confused: 0.93 })], [0.45, frame({ confused: 1 })], [1, frame({ confused: 0.93 })],
  ] },
  { id: 'receive', title: '收到你的话', fps: 8, count: 12, loop: false, knots: [
    [0, rest()], [0.25, frame({ happy: 0.85 }, 1.15)], [0.5, frame({ happy: 1 }, 1.15)], [0.75, frame({ happy: 0.6 }, 1.05)], [1, rest()],
  ] },
  { id: 'done', title: '做好了', fps: 8, count: 16, loop: false, knots: [
    [0, rest()], [0.22, frame({ happy: 0.9 }, 1, 0.8)], [0.4, frame({ happy: 1 }, 1, 1)], [0.64, frame({ happy: 0.9 }, 1, 1)], [1, rest()],
  ] },
  { id: 'look', title: '轻轻张望', fps: 8, count: 16, loop: false, knots: [
    [0, rest()], [0.25, frame({}, 1, 0, 0.07)], [0.4, frame({}, 1, 0, 0.07)], [0.65, frame({}, 1, 0, -0.05)], [0.8, frame({}, 1, 0, -0.05)], [1, rest()],
  ] },
  { id: 'sleep', title: '安静歇着', fps: 4, count: 12, loop: true, knots: [
    [0, frame({ low: 1 }, 0.12)], [0.5, frame({ low: 0.96 }, 0.12)], [1, frame({ low: 1 }, 0.12)],
  ] },
  { id: 'wake', title: '回到身边', fps: 8, count: 12, loop: false, knots: [
    [0, frame({ low: 1 }, 0.12)], [0.35, frame({ low: 0.7 }, 0.35)], [0.7, frame({ low: 0.2 }, 0.8)], [1, rest()],
  ] },
  { id: 'error', title: '这一步没成', fps: 8, count: 12, loop: false, knots: [
    [0, rest()], [0.25, frame({ excited: 1 }, 1.15)], [0.5, frame({ excited: 0.9 }, 1.15)], [0.75, frame({ excited: 0.5 })], [1, rest()],
  ] },
  { id: 'drag', title: '被轻轻挪动', fps: 8, count: 12, loop: false, knots: [
    [0, frame({ excited: 0.75 }, 1.1)], [0.3, frame({ excited: 1 }, 1.15)], [0.65, frame({ excited: 0.85 }, 1.1)], [1, frame({ excited: 0.75 }, 1.1)],
  ] },
]

const round = value => Math.round(value * 1_000_000) / 1_000_000

/**
 * Sample authored key poses using smoothstep easing; time is normalized 0..1.
 * @param {string} id
 * @param {number} time
 * @returns {MotionFrame}
 */
export function sampleClip(id, time) {
  const clip = clips.find(c => c.id === id)
  if (!clip) throw Error(`Unknown CC motion: ${id}`)
  if (!Number.isFinite(time)) throw Error('CC motion time must be finite')
  const t = Math.min(1, Math.max(0, time))
  let right = clip.knots.findIndex(([at]) => at >= t)
  if (right < 0) right = clip.knots.length - 1
  const [end, b] = clip.knots[right]
  if (right === 0 || end === t) return structuredClone(b)
  const [start, a] = clip.knots[right - 1]
  const u = (t - start) / (end - start)
  const ease = u * u * (3 - 2 * u)
  const mix = (x, y) => round(x + (y - x) * ease)
  const pose = {}
  for (const name of new Set([...Object.keys(a.pose), ...Object.keys(b.pose)])) {
    const value = mix(a.pose[name] ?? 0, b.pose[name] ?? 0)
    if (value) pose[name] = value
  }
  return { pose, eyeScale: mix(a.eyeScale, b.eyeScale), crescent: mix(a.crescent, b.crescent), gaze: mix(a.gaze, b.gaze) }
}

export function buildMotionPlan() {
  return {
    schemaVersion: 1, artStatus: 'production-candidate', forms: ['lit', 'unlit'],
    source: 'apps/desktop/art/cc-v1/cc-v1.blend',
    canvas: { width: 512, height: 512, anchor: [0.5, 0.91796875], safeBboxPx: [80, 28, 432, 470] },
    clips: clips.map(({ id, title, fps, count, loop }) => ({
      id, title, fps, loop, frames: Array.from({ length: count }, (_, i) => sampleClip(id, i / (count - 1))),
    })),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]
  if (!output) throw Error('Usage: node cc-motion-recipes.mjs OUTPUT.json')
  const plan = buildMotionPlan()
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`)
  console.log(`${plan.clips.length} paired CC clips; ${plan.clips.reduce((n, c) => n + c.frames.length, 0)} authored samples`)
}

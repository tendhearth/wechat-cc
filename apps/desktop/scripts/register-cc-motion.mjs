import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readRGBA } from './cc-png.mjs'

const behaviors = new Set(['thinking', 'working', 'permission', 'receive', 'done', 'look', 'sleep', 'wake', 'error', 'drag'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Keep standalone Node CLI readers tolerant of the same UTF-8 BOM as runtime JSON.
const readJson = path => {
  const text = readFileSync(path, 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/** @typedef {{id: string, title: string, fps: number, loop: boolean, artStatus: string, frames: {lit: string[], unlit: string[]}, masks: string[], posterIndex: number}} CatalogClip */
/**
 * @returns {{schemaVersion: number, artStatus: string, generatedAt: string, source: unknown, baseUrl: string, forms: {id: string, label: string, description: string}[], clips: CatalogClip[], summary?: Record<string, number>}}
 */
export function buildMotionCatalog(plan, source, generatedAt) {
  const seen = new Set()
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.clips) || !plan.clips.length) throw Error('Invalid motion catalog plan')
  for (const clip of plan.clips) {
    if (!behaviors.has(clip.id) || seen.has(clip.id) || !Array.isArray(clip.frames) || clip.frames.length < 2 || clip.frames.length > 64) throw Error('Invalid motion clip')
    if (!Number.isFinite(clip.fps) || clip.fps < 1 || clip.fps > 24 || typeof clip.loop !== 'boolean') throw Error('Invalid motion clip timing')
    seen.add(clip.id)
  }
  return {
    schemaVersion: 1, artStatus: 'production-candidate', generatedAt, source,
    baseUrl: '../../../src/assets/pet/cc-v1/',
    forms: [
      { id: 'lit', label: 'Light CC', description: '在身边 · 发光的柔软瓷色' },
      { id: 'unlit', label: 'Dark CC', description: '暂时没连上 · 安静的炭黑哑光' },
    ],
    clips: plan.clips.map(clip => {
      const names = clip.frames.map((_, i) => `${String(i).padStart(3, '0')}.png`)
      return {
        id: clip.id, title: clip.title, fps: clip.fps, loop: clip.loop, artStatus: 'production-candidate',
        frames: Object.fromEntries(['lit', 'unlit'].map(form => [form, names.map(name => `motion/${form}/${clip.id}/${name}`)])),
        masks: names.map(name => `masks/motion/${clip.id}/${name}`), posterIndex: Math.floor(clip.frames.length / 2),
      }
    }),
  }
}

/** Validate every generated pair before returning any manifest/catalog to write. */
export function prepareMotionKit({ desktopRoot = desktop, kitRoot = join(desktopRoot, 'src/assets/pet/cc-v1'), planPath = join(desktopRoot, 'art/cc-v1/motion/recipes.json'), progressPath = join(desktopRoot, 'art/cc-v1/motion/render-progress.json'), reviewedAt = new Date().toISOString() } = {}) {
  const freeze = readJson(join(desktopRoot, 'art/cc-v1/design-freeze.json'))
  for (const [path, digest] of Object.entries(freeze.sha256)) {
    if (sha(readFileSync(resolve(desktopRoot, '../..', path))) !== digest) throw Error(`Frozen source changed: ${path}`)
  }
  const planBytes = readFileSync(planPath)
  const plan = JSON.parse(planBytes.toString())
  const progress = readJson(progressPath)
  const identity = progress.identity
  if (identity?.planSha256 !== sha(planBytes) || identity.sourceSha256 !== freeze.sha256['apps/desktop/art/cc-v1/cc-v1.blend']
      || identity.rendererSha256 !== sha(readFileSync(join(desktopRoot, 'scripts/render-cc.py')))
      || identity.geometrySha256 !== sha(readFileSync(join(desktopRoot, 'scripts/cc_motion_geometry.py'))) || identity.seed !== 11) throw Error('Motion render provenance changed')
  const source = { sha256: identity.sourceSha256, blender: identity.blender, samples: identity.samples, seed: identity.seed, planSha256: identity.planSha256, rendererSha256: identity.rendererSha256, geometrySha256: identity.geometrySha256 }
  const catalog = buildMotionCatalog(plan, source, reviewedAt)
  const manifest = readJson(join(kitRoot, 'manifest.json'))
  const referenceSha256 = manifest.reference.sha256
  const base = readRGBA(readFileSync(join(desktopRoot, 'src/assets/pet/cc-v1/masks/front.png'))).alpha
  const staticStates = manifest.motion?.staticStates ?? Object.fromEntries(['lit', 'unlit'].map(form => [form, Object.fromEntries(plan.clips.map(c => [c.id, structuredClone(manifest.forms[form].states[c.id])]))]))
  let bytesTotal = 0
  const uniqueImages = new Set()
  for (const [clipIndex, clip] of plan.clips.entries()) {
    const entry = catalog.clips[clipIndex]
    for (const [i, sample] of clip.frames.entries()) {
      const sampleKey = `${clip.id}/${String(i).padStart(3, '0')}`
      const record = progress.samples?.[sampleKey]
      if (!record || !isDeepStrictEqual(record.parameters, sample)) throw Error(`Incomplete motion sample: ${sampleKey}`)
      const paths = [entry.frames.lit[i], entry.frames.unlit[i], entry.masks[i]]
      const images = paths.map(path => {
        const data = readFileSync(join(kitRoot, path))
        const digest = sha(data)
        if (record.files?.[path] !== digest) throw Error(`Motion digest mismatch: ${path}`)
        bytesTotal += data.length
        uniqueImages.add(digest)
        return { path, digest, ...readRGBA(data) }
      })
      const [light, dark, mask] = images
      let foot = false
      for (let p = 0; p < mask.alpha.length; p++) {
        const entity = mask.alpha[p], a = light.alpha[p], b = dark.alpha[p]
        const x = p % 512, y = Math.floor(p / 512)
        if (a < entity || (entity >= 250 && a !== entity) || (entity === 0 && a > 89) || b !== entity) throw Error(`Motion entity coverage: ${sampleKey}/${p}`)
        if ((a || b) && (x < 80 || x >= 432 || y < 28 || y >= 470)) throw Error(`Motion safe bounds: ${sampleKey}`)
        if (y >= 300 && ((entity >= 128) !== (base[p] >= 128) || Math.abs(entity - base[p]) > 8)) throw Error(`Motion body/feet drift: ${sampleKey}`)
        if (y === 469 && entity) foot = true
      }
      if (!foot) throw Error(`Motion anchor missing: ${sampleKey}`)
      const visualReview = { reviewer: 'Implementation visual QA — owner review pending', reviewedAt, referenceSha256, method: 'paired contact sheets and pixel-contract checks' }
      for (const image of images) {
        manifest.assets[image.path] = {
          sha256: image.digest, view: 'three-quarter', expression: clip.id, artStatus: 'production-candidate',
          ...(image === mask ? {} : { geometryMask: mask.path }),
          motionSample: i, source: 'frozen-blender-rig', visualReview,
        }
      }
    }
    for (const form of ['lit', 'unlit']) manifest.forms[form].states[clip.id] = {
      frames: entry.frames[form], fps: clip.fps, loop: clip.loop, next: clip.loop ? null : 'idle', artStatus: 'production-candidate',
    }
  }
  manifest.artStatus = 'production-candidate'
  manifest.motion = { active: true, source, staticStates, catalog: 'art/cc-v1/motion/catalog.json' }
  catalog.summary = { clips: plan.clips.length, pairedSamples: plan.clips.reduce((n, c) => n + c.frames.length, 0), registeredFiles: plan.clips.reduce((n, c) => n + c.frames.length * 3, 0), uniqueImages: uniqueImages.size, bytes: bytesTotal }
  return { manifest, catalog }
}

const writeAtomic = (path, value) => {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2)
  if (flags.some(flag => flag !== '--activate')) throw Error('Usage: node register-cc-motion.mjs [--activate]')
  const { manifest, catalog } = prepareMotionKit()
  writeAtomic(join(desktop, 'art/cc-v1/motion/catalog.json'), catalog)
  if (flags.includes('--activate')) writeAtomic(join(desktop, 'src/assets/pet/cc-v1/manifest.json'), manifest)
  console.log(JSON.stringify({ ...catalog.summary, activated: flags.includes('--activate'), artStatus: catalog.artStatus }, null, 2))
}

// Deterministic code-native SVG placeholder pack; no raster art synthesis.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { CANVAS, ANATOMY, VIEWS, geometry, placeholderSvg } from '../src/assets/pet/cc-v1/placeholder.js'

const root = fileURLToPath(new URL('../src/assets/pet/cc-v1/', import.meta.url))
const write = (path, data) => { mkdirSync(root + path.substring(0, path.lastIndexOf('/') + 1), { recursive: true }); writeFileSync(root + path, data) }
const digest = (s) => createHash('sha256').update(s).digest('hex')
const assets = {}
const add = (path, form, view = 'front', expression = 'idle', mix, mask = false) => {
  const svg = placeholderSvg(form, view, expression, mix, mask)
  write(path, svg)
  assets[path] = { sha256: digest(svg), geometrySha256: digest(geometry(view, expression, mask)), view, expression, artStatus: 'normative-placeholder' }
  return path
}
const manifest = {
  schemaVersion: 1, kitId: 'cc-v1', name: 'CC Asset Kit', version: '1.0.0-alpha', artStatus: 'normative-placeholder',
  basedOnDevCommit: '7a0633368f1569b22f2b5637051c1154dfd73be0',
  reference: { path: 'CC_MASTER_V1.png', sha256: '2de9c2a97edbb6451b6acf644b39850906ecebaa58efc065bac58d4a92d4d072', role: 'approved-design-reference-only', conversation: '6a9d19cc-8a14-83ea-8af8-330402ca67db' },
  canvas: CANVAS, character: { ...ANATOMY, sameGeometry: true },
  forms: {}, canonical: {}, turnarounds: {}, transitions: {}, props: {}, assets,
}
const loops = new Set(['idle', 'thinking', 'working', 'sleep', 'permission', 'companion'])
for (const form of ['lit', 'unlit']) {
  const light = form === 'lit'
  const views = {}
  for (const view of VIEWS) views[view] = add(`canonical/${form}/${view}.svg`, form, view)
  manifest.turnarounds[form] = views
  manifest.canonical[form] = views.front
  const states = {}
  const names = light ? ['idle', 'blink', 'look', 'receive', 'thinking', 'working', 'done', 'sleep', 'permission', 'error', 'companion', 'drag', 'wake'] : ['idle', 'blink', 'working', 'sleep']
  for (const name of names) {
    const frame = (expression) => add(`sprites/${form}/${expression}.svg`, form, 'front', expression)
    const frames = name === 'blink' ? [views.front, frame('blink-half'), frame('blink-closed'), `sprites/${form}/blink-half.svg`, views.front] : name === 'idle' ? [views.front] : [frame(name)]
    states[name] = { frames, fps: name === 'blink' ? 8 : 4, loop: loops.has(name), next: loops.has(name) ? null : 'idle', artStatus: 'normative-placeholder', todo: name === 'blink' || name === 'sleep' || name === 'look' ? 'Replace with reviewed production animation' : 'Static normative pose; authored state performance pending' }
  }
  manifest.forms[form] = { displayName: light ? 'Light' : 'Dark', geometryId: 'cc-v1-placeholder-shared-geometry', master: views.front, material: { intrinsicGlow: light, body: light ? 'warm-ivory-frosted-porcelain-placeholder' : 'matte-charcoal', eyes: light ? 'black' : 'warm-white' }, states }
}
for (const view of VIEWS) add(`masks/${view}.svg`, 'unlit', view, 'idle', 0, true)
manifest.transitions['unlit-to-lit'] = { frames: Array.from({ length: 8 }, (_, i) => add(`transitions/dark-to-light/${String(i).padStart(3, '0')}.svg`, 'lit', 'front', 'idle', i / 7)), fps: 8, loop: false, next: 'idle', artStatus: 'normative-placeholder' }
// Existing standalone props preserve news/permission semantics; no body parts.
for (const name of ['micro-light', 'laptop', 'envelope', 'speech-bubble', 'thought-bubble', 'exclamation', 'mug']) manifest.props[name] = `../props/${name}.png`
write('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(`CC Asset Kit: ${Object.keys(assets).length} SVG assets generated; all normative placeholders.`)

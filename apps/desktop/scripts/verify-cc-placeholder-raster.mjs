// Optional offline visual QA for this alpha's SVG placeholders. Requires sharp
// in the caller's tools, not a new desktop/runtime dependency.
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const sharp = require(process.env.CC_SHARP_MODULE || 'sharp')
const root = fileURLToPath(new URL('../src/assets/pet/cc-v1/', import.meta.url))
const manifestText = readFileSync(root + 'manifest.json', 'utf8').replace(/^\uFEFF/, '') // 去 BOM,同 readJsonFile 契约
const manifest = JSON.parse(manifestText)
const rgba = new Map(), metrics = [], composites = []
let index = 0
for (const [path, meta] of Object.entries(manifest.assets)) {
  if (meta.artStatus !== 'normative-placeholder') throw Error('This raster gate only covers alpha placeholders; use a production visual review for replacements.')
  const { data, info } = await sharp(root + path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== 512 || info.height !== 512) throw Error(`dimensions:${path}`)
  rgba.set(path, data)
  let minX = 512, minY = 512, maxX = -1, maxY = -1
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (data[(y * 512 + x) * 4 + 3] > 0) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  }
  if (maxX < 0 || minX < 80 || maxX > 432 || minY < 28 || maxY > 470) throw Error(`bbox:${path}`)
  metrics.push({ path, width: info.width, height: info.height, bbox: [minX, minY, maxX, maxY] })
  if (process.argv[2]) {
    composites.push({ input: await sharp(root + path).resize(144, 144).png().toBuffer(), left: (index % 8) * 160 + 8, top: Math.floor(index / 8) * 176 + 8 })
    const label = path.replace('canonical/', 'c/').replace('sprites/', 's/').replace('transitions/dark-to-light/', 't/')
    composites.push({ input: Buffer.from(`<svg width="160" height="20"><text x="3" y="13" font-size="9" fill="#303030">${label}</text></svg>`), left: (index % 8) * 160, top: Math.floor(index / 8) * 176 + 152 })
  }
  index++
}
for (const view of ['front', 'three-quarter', 'side', 'back']) {
  const a = rgba.get(`canonical/lit/${view}.svg`), b = rgba.get(`canonical/unlit/${view}.svg`)
  for (let k = 3; k < a.length; k += 4) if (a[k] !== b[k]) throw Error(`alpha_pair:${view}`)
}
const pixel = (path, x, y) => Array.from(rgba.get(path).subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4))
const darkEye = pixel('canonical/unlit/front.svg', 225, 342), lightEye = pixel('canonical/lit/front.svg', 225, 342)
if (JSON.stringify(darkEye) !== '[255,247,230,255]' || JSON.stringify(lightEye) !== '[21,20,18,255]') throw Error(`eye_colors:${JSON.stringify({ darkEye, lightEye })}`)
for (const [frame, form] of [['000', 'unlit'], ['007', 'lit']]) if (!rgba.get(`transitions/dark-to-light/${frame}.svg`).equals(rgba.get(`canonical/${form}/front.svg`))) throw Error(`transition_endpoint:${frame}`)
if (process.argv[2]) {
  const output = resolve(process.argv[2]); mkdirSync(output, { recursive: true })
  await sharp({ create: { width: 1280, height: Math.ceil(index / 8) * 176, channels: 4, background: '#dedbd5' } }).composite(composites).png().toFile(resolve(output, 'raster-preview.png'))
  writeFileSync(resolve(output, 'raster-metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
}
console.log(JSON.stringify({ assets: index, safeBbox: 'PASS', pairAlpha: '4/4 PASS', transitionEndpoints: '2/2 pixel-identical', darkEye, lightEye }))

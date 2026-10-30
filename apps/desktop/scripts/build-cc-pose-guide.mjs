// Offline design study only. Validate every frozen-rig pair before composing guides.
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRGBA } from './cc-png.mjs'
const require = createRequire(import.meta.url)
const root = realpathSync(process.argv[2] ?? fileURLToPath(new URL('../art/cc-v1/studies/c-poses', import.meta.url)))
const text = readFileSync(join(root, 'poses.json'), 'utf8')
const record = JSON.parse(text.replace(/^\uFEFF/, ''))
const ids = ['default','listening','happy','confused','thinking','low','angry','excited']
if (record.schemaVersion !== 1 || record.artStatus !== 'production-candidate' || JSON.stringify(record.poses?.map(p => p.id)) !== JSON.stringify(ids)) throw Error('Expected the eight original candidate C poses')
const sharp = require(process.env.CC_SHARP_MODULE || 'sharp'); sharp.concurrency(1)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const assets = new Map()
for (const pose of record.poses) {
  const expected = [`motion/lit/${pose.id}/000.png`, `motion/unlit/${pose.id}/000.png`, `masks/${pose.id}.png`]
  if (JSON.stringify([pose.frames.lit, pose.frames.unlit, pose.geometryMask]) !== JSON.stringify(expected)) throw Error(`Invalid paired paths: ${pose.id}`)
  for (const path of expected) {
    const full = realpathSync(join(root, path)), rel = relative(root, full)
    if (rel === '..' || rel.startsWith('..' + sep) || resolve(full) === root) throw Error('Pose PNG escapes its study folder')
    const bytes = readFileSync(full)
    if (sha(bytes) !== pose.sha256[path]) throw Error(`Pose digest mismatch: ${path}`)
    const decoded = readRGBA(bytes)
    await sharp(bytes, { failOn: 'error' }).raw().toBuffer()
    assets.set(path, { bytes, ...decoded })
  }
}
const base = assets.get(record.poses[0].geometryMask).alpha
for (const pose of record.poses) {
  const light = assets.get(pose.frames.lit).alpha, dark = assets.get(pose.frames.unlit).alpha, entity = assets.get(pose.geometryMask).alpha
  if (!dark.equals(entity)) throw Error(`Dark exterior haze: ${pose.id}`)
  let baseline = false
  for (let i = 0; i < entity.length; i++) {
    const a = light[i], mask = entity[i], x = i % 512, y = Math.floor(i / 512)
    if (a < mask || (mask >= 250 && a !== mask) || (mask === 0 && a > 89)) throw Error(`Light coverage: ${pose.id}`)
    if ((a || mask) && (x < 80 || x >= 432 || y < 28 || y >= 470)) throw Error(`Pose bounds: ${pose.id}`)
    if (y >= 300 && ((mask >= 128) !== (base[i] >= 128) || Math.abs(mask - base[i]) > 8)) throw Error(`Body/feet drift: ${pose.id}`)
    if (y === 469 && mask) baseline = true
  }
  if (!baseline) throw Error(`Pose anchor: ${pose.id}`)
}
const xml = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
const label = (text, width, height, color, size = 14) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="0" y="${size + 3}" fill="${color}" font-size="${size}" font-family="sans-serif">${xml(text)}</text></svg>`)
const width = 1472, height = 620, frameSize = 160, cardWidth = 360, rowHeight = 248
for (const [name, background, ink, subtle] of [['paper','#faf7f2','#2a2622','#776e64'],['slate','#424850','#ffffff','#ddd6cb']]) {
  const layers = [
    { input: label('CC · 原定的八种 C 姿态', width - 48, 32, ink, 22), left: 24, top: 16 },
    { input: label('Light / Dark · 同一冻结模型 · 设计研究，非新增运行时情绪 · production-candidate', width - 48, 24, subtle, 12), left: 24, top: 50 },
  ]
  for (const [index, pose] of record.poses.entries()) {
    const x = 24 + (index % 4) * cardWidth, y = 94 + Math.floor(index / 4) * rowHeight
    layers.push({ input: label(`${String(index + 1).padStart(2,'0')}  ${pose.label}`, cardWidth - 20, 26, ink, 16), left: x, top: y })
    for (const [column, form] of ['lit','unlit'].entries()) {
      const left = x + column * 172
      layers.push({ input: label(form === 'lit' ? 'Light CC' : 'Dark CC', frameSize, 22, subtle, 12), left, top: y + 30 })
      layers.push({ input: await sharp(assets.get(pose.frames[form]).bytes).resize(frameSize, frameSize).png().toBuffer(), left, top: y + 52 })
    }
  }
  layers.push({ input: label(`候选素材 · 主人美术验收待定 · frozen source ${record.source.sha256.slice(0,16)}`, width - 48, 24, subtle, 11), left: 24, top: height - 30 })
  await sharp({create:{width,height,channels:4,background}}).composite(layers).png().toFile(join(root, `guide-${name}.png`))
}
console.log(JSON.stringify({poses:record.poses.length,pairedFiles:record.poses.length*3,sourceSha256:record.source.sha256,width,height,artStatus:record.artStatus,checks:'strict decode, digests, paired masks, matte Dark, Light coverage, safe bounds, fixed body/feet'}))

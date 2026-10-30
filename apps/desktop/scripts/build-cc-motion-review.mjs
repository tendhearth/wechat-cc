// Offline only: consume the authored motion catalog, validate every referenced PNG,
// then render contact sheets. Never promotes candidate art or edits the asset kit.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateCatalog } from '../art/cc-v1/motion/catalog.mjs'
import { readRGBA } from './cc-png.mjs'
const require = createRequire(import.meta.url)
const desktop = fileURLToPath(new URL('../', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const label = (value, width, height, color) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="12" y="22" fill="${color}" font-size="13" font-family="sans-serif">${xml(value)}</text></svg>`)
export async function buildMotionReview({ catalogPath = join(desktop, 'art/cc-v1/motion/catalog.json'), kitPath = join(desktop, 'src/assets/pet/cc-v1'), outputPath = join(desktop, 'art/cc-v1/motion/contact-sheets'), sizes = [48, 96, 128, 256] } = {}) {
  let bytes, catalog
  try { bytes = await readFile(catalogPath); catalog = validateCatalog(JSON.parse(bytes.toString())) } catch (error) { throw new Error(`Cannot read motion catalog ${catalogPath}: ${error.message}`) }
  if (!Array.isArray(sizes) || !sizes.length || sizes.some(size => ![48, 96, 128, 256].includes(size))) throw new Error('sizes must be 48, 96, 128 or 256')
  const root = await realpath(kitPath), assets = new Map()
  for (const path of new Set(catalog.clips.flatMap(clip => [...clip.frames.lit, ...clip.frames.unlit, ...clip.masks]))) {
    let png, full
    try {
      full = await realpath(join(root, path))
      const rel = relative(root, full)
      if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(full) === root) throw new Error('outside asset kit')
      png = await readFile(full); readRGBA(png)
    } catch (error) { throw new Error(`Invalid motion PNG ${path}: ${error.message}`) }
    assets.set(path, { path, width: 512, height: 512, bytes: png.length, sha256: digest(png), png })
  }
  let sharp
  try { sharp = require(process.env.CC_SHARP_MODULE || 'sharp') } catch { throw new Error('Contact sheets need sharp; set CC_SHARP_MODULE to its installed module path') }
  sharp.concurrency(1)
  // readRGBA enforces the kit's pixel contract but does not check chunk CRCs.
  // Force a strict full decode of every in-memory asset, including masks that
  // never reach sheet composition, before touching any existing review output.
  for (const { path, png } of assets.values()) {
    try { await sharp(png, { failOn: 'warning' }).raw().toBuffer() }
    catch (error) { throw new Error(`Invalid motion PNG ${path}: ${error.message}`) }
  }
  const summary = { schemaVersion: 1, artStatus: catalog.artStatus, generatedAt: new Date().toISOString(), source: catalog.source, catalogSha256: digest(bytes), clipCount: catalog.clips.length, pairedSamples: catalog.clips.reduce((n, c) => n + c.frames.lit.length, 0), frameReferences: catalog.clips.reduce((n, c) => n + c.frames.lit.length * 2, 0), assets: [...assets.values()].map(({ png, ...metadata }) => metadata), sheets: [] }
  // Complete validation before creating output; a broken catalog cannot produce a misleading partial review.
  await mkdir(outputPath, { recursive: true })
  for (const clip of catalog.clips) for (const size of [...new Set(sizes)]) {
    const count = clip.frames.lit.length, columns = Math.min(8, count), cell = Math.max(size + 16, 104), rows = Math.ceil(count / columns), rowHeight = size + 26
    const width = Math.max(640, columns * cell), frameOffset = Math.floor((width - columns * cell) / 2), blockHeight = 32 + rows * rowHeight, height = 38 + 4 * blockHeight, composite = []
    composite.push({ input: label(`${clip.title} · ${clip.fps} fps · ${clip.loop ? 'loop' : 'one-shot'} · ${size}px · production-candidate`, width, 32, '#2a2622'), left: 0, top: 0 })
    let block = 0
    for (const background of [{ name: 'paper', color: '#faf7f2', ink: '#70665d' }, { name: 'slate QA', color: '#424850', ink: '#ffffff' }]) for (const form of catalog.forms) {
      const top = 38 + block++ * blockHeight
      composite.push({ input: await sharp({ create: { width, height: blockHeight, channels: 4, background: background.color } }).png().toBuffer(), left: 0, top })
      composite.push({ input: label(`${form.label} · ${form.description} · ${background.name}`, width, 32, background.ink), left: 0, top })
      for (let i = 0; i < count; i++) {
        const left = frameOffset + i % columns * cell, frameTop = top + 32 + Math.floor(i / columns) * rowHeight
        composite.push({ input: await sharp(assets.get(clip.frames[form.id][i]).png).resize(size, size).png().toBuffer(), left: left + Math.floor((cell - size) / 2), top: frameTop })
        composite.push({ input: label(`${String(i + 1).padStart(3, '0')}`, cell, 26, background.ink), left, top: frameTop + size })
      }
    }
    const file = `${clip.id}-${size}.png`
    await sharp({ create: { width, height, channels: 4, background: '#faf7f2' } }).composite(composite).png().toFile(join(outputPath, file))
    summary.sheets.push({ file, clip: clip.id, displaySize: size, width, height, renderedFrames: count * 4 })
  }
  await writeFile(join(outputPath, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.includes('--help')) console.log('node build-cc-motion-review.mjs [catalog.json] [kit-path] [output-directory]\nOptional: CC_SHARP_MODULE=/absolute/path/to/sharp')
  else buildMotionReview({ ...(args[0] && { catalogPath: resolve(args[0]) }), ...(args[1] && { kitPath: resolve(args[1]) }), ...(args[2] && { outputPath: resolve(args[2]) }) }).then(summary => console.log(JSON.stringify({ clipCount: summary.clipCount, pairedSamples: summary.pairedSamples, sheets: summary.sheets.length, catalogSha256: summary.catalogSha256 }))).catch(error => { console.error(error.message); process.exitCode = 1 })
}

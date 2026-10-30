// Offline shareable comparisons. Reads the candidate catalog/kit, never promotes art.
import { readFile, writeFile, mkdir, realpath, stat, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep, basename, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateCatalog } from '../art/cc-v1/motion/catalog.mjs'
import { readRGBA } from './cc-png.mjs'

const require = createRequire(import.meta.url)
const desktop = fileURLToPath(new URL('../', import.meta.url))
const paper = '#faf7f2'
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const privateContent = /CC_MASTER_V1|CC_DESIGN_SHEET_V1|(?:\/Users\/|\/home\/|file:\/\/|https?:\/\/)|[\u0000-\u001f\u007f]/i

/** WebP stores integer milliseconds: round cumulative boundaries, never each interval. */
export function webpDelays(count, fps) {
  if (!Number.isInteger(count) || count < 1 || count > 600 || !Number.isFinite(fps) || fps <= 0 || fps > 60) throw Error('Invalid motion sample timing')
  const delays = Array.from({ length: count }, (_, i) => Math.round((i + 1) * 1000 / fps) - Math.round(i * 1000 / fps))
  if (delays.some(ms => !Number.isSafeInteger(ms) || ms < 1 || ms > 0xffffff)) throw Error('Motion timing cannot be represented in WebP milliseconds')
  return delays
}

// Resolve even a not-yet-created output through its nearest real ancestor.
async function canonicalPath(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonicalPath(parent), basename(path))
  }
}

async function validateOutput(output, kit, catalog) {
  if (within(kit, output) || within(output, kit) || within(output, catalog)) throw Error('Motion sample output must not overlap the source kit or catalog')
  try {
    if (!(await stat(output)).isDirectory()) throw Error('Motion sample output must be a directory')
    if ((await readdir(output)).length) throw Error('Motion sample output must be new or empty')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

const uint24 = value => { const bytes = Buffer.alloc(3); bytes.writeUIntLE(value, 0, 3); return bytes }
function chunk(type, data) {
  const head = Buffer.alloc(8); head.write(type); head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])])
}
// Mux complete lossless frames explicitly so identical consecutive artwork is
// retained as separate samples. Encoders commonly merge duplicates otherwise.
function animatedWebp(frames, width, height, delays, loop) {
  const header = Buffer.concat([Buffer.from([2, 0, 0, 0]), uint24(width - 1), uint24(height - 1)])
  const animation = Buffer.alloc(6); animation.writeUInt16LE(loop ? 0 : 1, 4)
  const body = [chunk('VP8X', header), chunk('ANIM', animation)]
  for (const [i, frame] of frames.entries()) {
    const frameHeader = Buffer.concat([uint24(0), uint24(0), uint24(width - 1), uint24(height - 1), uint24(delays[i]), Buffer.from([2])])
    const payload = []
    for (let offset = 12; offset + 8 <= frame.length;) {
      const size = frame.readUInt32LE(offset + 4), type = frame.toString('ascii', offset, offset + 4), end = offset + 8 + size + size % 2
      if (['VP8L', 'VP8 ', 'ALPH'].includes(type)) payload.push(frame.subarray(offset, end))
      offset = end
    }
    if (!payload.length) throw Error('Cannot encode motion WebP frame')
    body.push(chunk('ANMF', Buffer.concat([frameHeader, ...payload])))
  }
  const bytes = Buffer.concat([Buffer.from('WEBP'), ...body]), riff = Buffer.alloc(8)
  riff.write('RIFF'); riff.writeUInt32LE(bytes.length, 4)
  return Buffer.concat([riff, bytes])
}

function previewHtml(clips, width, height) {
  const cards = clips.map(clip => `<section data-clip="${clip.id}"><h2>${xml(clip.title)}</h2><p>${clip.fps} fps · ${clip.loop ? 'Loop' : 'Play once'} · production-candidate</p><img width="${width}" height="${height}" alt="${xml(clip.title)}: Light CC and Dark CC paired motion sample" src="${clip.frames[clip.posterIndex]}" data-frame="${clip.posterIndex}"><div><button type="button">Play</button> <a href="${clip.id}.webp" download>Save WebP</a></div><span role="status" aria-live="polite"></span></section>`).join('\n')
  const data = JSON.stringify(clips).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><title>Tendhearth CC · motion samples</title>
<style>body{margin:0;background:${paper};color:#302b26;font:16px/1.6 system-ui,sans-serif}main{max-width:${width}px;margin:48px auto;padding:0 20px}h1{font-size:26px;font-weight:500}h2{font-size:20px;font-weight:500;margin:0}p{color:#71675d;margin:8px 0 20px}section{margin:48px 0}img{display:block;max-width:100%;height:auto}button,a{font:inherit;color:inherit}button{background:transparent;border:1px solid #b8aea2;border-radius:8px;padding:6px 22px;cursor:pointer}a{margin-left:18px}span[role=status]{display:block;min-height:26px;color:#71675d;font-size:14px}</style>
<main><h1>Tendhearth CC · motion samples</h1><p>Paired artwork studies · production-candidate. Light CC and Dark CC share each sample and display size.</p>${cards}<p>The preview follows the catalog timeline. Single gestures hold their last frame until Replay. WebP playback policies vary by viewer; its timestamps are rounded to milliseconds.</p><noscript>Enable JavaScript to play these samples. The poster images remain visible.</noscript></main>
<script>
const clips = ${data};
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
for (const clip of clips) {
  const card = document.querySelector('[data-clip="' + clip.id + '"]'), image = card.querySelector('img'), button = card.querySelector('button'), status = card.querySelector('[role=status]');
  let request = 0, start = 0, playing = false;
  const show = index => { image.src = clip.frames[index]; image.dataset.frame = String(index); };
  const stop = () => { cancelAnimationFrame(request); playing = false; button.textContent = 'Replay'; };
  const tick = now => {
    const sample = Math.floor(Math.max(0, now - start) * clip.fps / 1000);
    show(clip.loop ? sample % clip.frames.length : Math.min(sample, clip.frames.length - 1));
    if (!clip.loop && sample >= clip.frames.length) { stop(); status.textContent = 'Complete · last frame'; return; }
    request = requestAnimationFrame(tick);
  };
  button.addEventListener('click', async () => {
    if (playing) { stop(); status.textContent = 'Paused'; return; }
    button.disabled = true;
    try {
      await Promise.all(clip.frames.map(src => { const frame = new Image(); frame.src = src; return frame.decode(); }));
      show(0); start = performance.now(); playing = true; button.textContent = 'Pause'; status.textContent = '';
      request = requestAnimationFrame(tick);
    } catch { status.textContent = 'Could not decode the sample.'; }
    finally { button.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });
  reduced.addEventListener('change', () => { if (reduced.matches && playing) stop(); });
}
</script></html>\n`
}

export async function buildMotionSamples({ catalogPath = join(desktop, 'art/cc-v1/motion/catalog.json'), kitPath = join(desktop, 'src/assets/pet/cc-v1'), outputPath, displaySize = 256 } = {}) {
  for (const [name, value] of Object.entries({ catalogPath, kitPath, outputPath })) {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value) || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !(process.platform === 'win32' && /^[a-z]:[\\/]/i.test(value)))) throw Error(`Invalid ${name}: provide a local path`)
  }
  if (![128, 256, 512].includes(displaySize)) throw Error('displaySize must be 128, 256 or 512')
  const catalogReal = await realpath(catalogPath), kit = await realpath(kitPath), output = await canonicalPath(resolve(outputPath))
  await validateOutput(output, kit, catalogReal)
  const catalogBytes = await readFile(catalogReal), catalog = validateCatalog(JSON.parse(catalogBytes.toString()))
  for (const clip of catalog.clips) {
    webpDelays(clip.frames.lit.length, clip.fps)
    if (privateContent.test(clip.title)) throw Error('Motion title is not shareable')
    for (let i = 0; i < clip.frames.lit.length; i++) {
      const light = clip.frames.lit[i], dark = clip.frames.unlit[i]
      if (!/^(motion|canonical)\/lit\//.test(light) || dark !== light.replace('/lit/', '/unlit/') || basename(clip.masks[i]) !== basename(light)) throw Error(`Motion pair paths do not match at ${clip.id}/${i}`)
    }
  }
  let sharp
  try { sharp = require(process.env.CC_SHARP_MODULE || 'sharp') } catch { throw Error('Motion samples need sharp; set CC_SHARP_MODULE to its installed module path') }
  sharp.concurrency(1)
  const assets = new Map()
  for (const path of new Set(catalog.clips.flatMap(c => [...c.frames.lit, ...c.frames.unlit, ...c.masks]))) {
    try {
      const full = await realpath(join(kit, path))
      if (!within(kit, full) || privateContent.test(relative(kit, full))) throw Error('outside asset kit or private source')
      const bytes = await readFile(full); readRGBA(bytes)
      await sharp(bytes, { failOn: 'warning' }).raw().toBuffer()
      assets.set(path, bytes)
    } catch (error) { throw Error(`Invalid motion PNG ${path}: ${error.message}`) }
  }
  // All caller inputs have now been validated and decoded. No writes above.
  const width = Math.max(640, displaySize * 2 + 96), height = displaySize + 152
  const svg = clip => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g fill="#302b26" font-family="sans-serif"><text x="24" y="32" font-size="18">${xml(clip.title)}</text><text x="24" y="58" fill="#71675d" font-size="12">production-candidate · ${clip.fps} fps · ${clip.loop ? 'loop' : 'play once'}</text><text x="${width / 4}" y="94" text-anchor="middle" font-size="15">Light CC</text><text x="${width * 3 / 4}" y="94" text-anchor="middle" font-size="15">Dark CC</text></g></svg>`)
  const summary = { schemaVersion: 1, artStatus: 'production-candidate', catalogSha256: sha256(catalogBytes), sourceSha256: catalog.source.sha256, displaySize, width, height, timing: 'Catalog sample order and fps; WebP cumulative timestamps rounded to nearest millisecond (at most 0.5ms boundary error). HTML uses catalog fps.', clips: [] }
  const previews = [], posters = []
  // Generate each clip in memory. Only one clip's decoded raster frames is held.
  await mkdir(output, { recursive: true })
  for (const clip of catalog.clips) {
    const pngs = [], webps = [], overlay = svg(clip)
    for (let i = 0; i < clip.frames.lit.length; i++) {
      const pair = []
      for (const [column, form] of ['lit', 'unlit'].entries()) pair.push({ input: await sharp(assets.get(clip.frames[form][i])).resize(displaySize, displaySize, { fit: 'contain' }).png().toBuffer(), left: Math.round(width * (column ? 3 : 1) / 4 - displaySize / 2), top: 112 })
      const png = await sharp({ create: { width, height, channels: 4, background: paper } }).composite([...pair, { input: overlay, left: 0, top: 0 }]).png().toBuffer()
      pngs.push(png); webps.push(await sharp(png).webp({ lossless: true, effort: 4 }).toBuffer())
    }
    const delays = webpDelays(pngs.length, clip.fps), webp = animatedWebp(webps, width, height, delays, clip.loop)
    await writeFile(join(output, `${clip.id}.webp`), webp)
    await writeFile(join(output, `${clip.id}-poster.png`), pngs[clip.posterIndex])
    posters.push(pngs[clip.posterIndex])
    previews.push({ id: clip.id, title: clip.title, fps: clip.fps, loop: clip.loop, posterIndex: clip.posterIndex, frames: pngs.map(png => `data:image/png;base64,${png.toString('base64')}`) })
    summary.clips.push({ id: clip.id, title: clip.title, artStatus: 'production-candidate', fps: clip.fps, loop: clip.loop, frameCount: pngs.length, posterIndex: clip.posterIndex, durationMs: pngs.length * 1000 / clip.fps, webpDurationMs: delays.reduce((a, b) => a + b, 0), webpDelaysMs: delays, webp: `${clip.id}.webp`, poster: `${clip.id}-poster.png`, webpSha256: sha256(webp) })
  }
  await sharp({ create: { width, height: height * posters.length, channels: 4, background: paper } }).composite(posters.map((input, i) => ({ input, left: 0, top: height * i }))).png().toFile(join(output, 'index.png'))
  await writeFile(join(output, 'index.html'), previewHtml(previews, width, height))
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') console.log('node build-cc-motion-samples.mjs <catalog.json> <kit-directory> <new-or-empty-output-directory>\nOptional: CC_SHARP_MODULE=/absolute/path/to/sharp')
  else if (args.length !== 3 || args.some(arg => arg.startsWith('--'))) { console.error('Provide catalog JSON, kit directory and a new or empty output directory. Use --help.'); process.exitCode = 1 }
  else buildMotionSamples({ catalogPath: args[0], kitPath: args[1], outputPath: args[2] }).then(summary => console.log(JSON.stringify({ clips: summary.clips.length, width: summary.width, height: summary.height, artStatus: summary.artStatus }))).catch(error => { console.error(error.message); process.exitCode = 1 })
}

import { validateCatalog, resolveClipFrames, frameAtElapsed } from './catalog.mjs'
const $ = id => document.getElementById(id)
const ui = Object.fromEntries(['clip', 'clip-info', 'play', 'previous', 'next', 'scrubber', 'frame-info', 'status', 'pair', 'size', 'background', 'reduce-motion', 'motion-note', 'source-info'].map(id => [id, $(id)]))
const images = { lit: $('lit-frame'), unlit: $('unlit-frame') }
const systemMotion = matchMedia('(prefers-reduced-motion: reduce)')
let catalog, clip, urls, frame = 0, playing = false, ready = false, token = 0, raf = 0, start = 0
const reduced = () => systemMotion.matches || ui['reduce-motion'].checked
function controls() {
  ui.play.disabled = !ready || reduced(); ui.previous.disabled = !ready; ui.next.disabled = !ready; ui.scrubber.disabled = !ready
  ui.play.textContent = playing ? '暂停' : clip && !clip.loop && frame === clip.frames.lit.length - 1 ? '重播' : '播放'
  document.body.dataset.playing = String(playing)
  ui['motion-note'].textContent = systemMotion.matches ? '系统已开启减少动态。可逐帧检查，连续播放已暂停。' : reduced() ? '已减少动态。可逐帧检查，连续播放已暂停。' : '一次性动作播放后停在末帧；再次点击才重播。'
}
function pause() { playing = false; cancelAnimationFrame(raf); controls() }
function showFrame(index) {
  frame = index; document.body.dataset.frame = String(frame)
  for (const form of ['lit', 'unlit']) images[form].src = urls[form][frame]
  ui.scrubber.value = String(frame); ui.scrubber.setAttribute('aria-valuetext', `第 ${frame + 1} 帧，共 ${clip.frames.lit.length} 帧`)
  ui['frame-info'].textContent = `${frame + 1} / ${clip.frames.lit.length}`
  controls()
}
function fail(message) {
  ready = false; pause(); document.body.dataset.state = 'error'; ui.pair.setAttribute('aria-busy', 'false')
  for (const img of Object.values(images)) img.hidden = true
  ui.status.textContent = message
}
function tick(now) {
  if (!playing) return
  const result = frameAtElapsed(clip, now - start)
  if (result.index !== frame) showFrame(result.index)
  if (result.ended) { pause(); ui.status.textContent = '已停在末帧。点击「重播」可再次检查。'; return }
  raf = requestAnimationFrame(tick)
}
ui.play.addEventListener('click', () => {
  if (playing) { pause(); return }
  if (!ready || reduced()) return
  if (!clip.loop && frame === clip.frames.lit.length - 1) showFrame(0)
  playing = true; start = performance.now() - frame * 1000 / clip.fps; controls(); ui.status.textContent = '正在播放素材。'; raf = requestAnimationFrame(tick)
})
function step(delta) { if (!ready) return; pause(); showFrame(Math.max(0, Math.min(clip.frames.lit.length - 1, frame + delta))); ui.status.textContent = '逐帧检查。' }
ui.previous.addEventListener('click', () => step(-1)); ui.next.addEventListener('click', () => step(1))
ui.scrubber.addEventListener('input', () => { if (!ready) return; pause(); showFrame(Number(ui.scrubber.value)); ui.status.textContent = '逐帧检查。' })
ui.size.addEventListener('change', () => { for (const img of Object.values(images)) img.width = img.height = Number(ui.size.value) })
ui.background.addEventListener('change', () => { ui.pair.dataset.background = ui.background.value })
function motionChanged() { if (reduced()) pause(); controls() }
systemMotion.addEventListener('change', motionChanged); ui['reduce-motion'].addEventListener('change', motionChanged)
document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); if (ready) ui.status.textContent = '离开页面后已暂停；点击「播放」继续检查。' } })
// Bounded preload; show the pair only after every corresponding frame has decoded.
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image(), timer = setTimeout(() => { img.src = ''; reject(Error('frame timeout')) }, 15000)
    img.onload = () => { clearTimeout(timer); img.naturalWidth === 512 && img.naturalHeight === 512 ? resolve(img) : reject(Error('expected 512px frame')) }
    img.onerror = () => { clearTimeout(timer); reject(Error('frame unavailable')) }; img.src = url
  })
}
async function selectClip() {
  const revision = ++token; ready = false; pause(); clip = catalog.clips.find(c => c.id === ui.clip.value)
  document.body.dataset.state = 'loading'; ui.pair.setAttribute('aria-busy', 'true'); for (const img of Object.values(images)) img.hidden = true
  ui.status.textContent = '正在载入两种形态的动作帧…'
  ui['clip-info'].textContent = `${clip.fps} fps · ${clip.frames.lit.length} 帧 · ${clip.loop ? '循环' : '播放一次'}`
  ui.scrubber.max = String(clip.frames.lit.length - 1)
  try {
    const nextURLs = resolveClipFrames(catalog, clip, new URL('./catalog.json', import.meta.url)), queue = [...new Set([...nextURLs.lit, ...nextURLs.unlit])]
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length && revision === token) await loadImage(queue.shift()) }))
    if (revision !== token) return
    urls = nextURLs; ready = true; document.body.dataset.state = 'ready'; ui.pair.setAttribute('aria-busy', 'false'); showFrame(clip.posterIndex)
    for (const img of Object.values(images)) img.hidden = false
    ui.status.textContent = '素材已就绪。点击「播放」或逐帧检查。'
  } catch { if (revision === token) fail('动作帧无法载入，已停止预览。请选择其他动作，或核对素材文件。') }
}
ui.clip.addEventListener('change', selectClip)
for (const img of Object.values(images)) img.addEventListener('error', () => { if (ready) fail('动作帧无法载入，已停止预览。请重新载入素材。') })
async function init() {
  controls()
  try {
    const response = await fetch(new URL('./catalog.json', import.meta.url), { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw Error('catalog unavailable')
    catalog = validateCatalog(await response.json()); ui.clip.replaceChildren(...catalog.clips.map(c => { const option = document.createElement('option'); option.value = c.id; option.textContent = c.title; return option }))
    ui.clip.disabled = false
    ui['source-info'].textContent = `Blender ${catalog.source.blender} · ${catalog.source.samples} samples · ${catalog.generatedAt} · source SHA-256 ${catalog.source.sha256}`
    await selectClip()
  } catch { fail('动作目录无法载入或格式无效。请先生成 catalog.json；当前没有播放任何素材。') }
}
init()

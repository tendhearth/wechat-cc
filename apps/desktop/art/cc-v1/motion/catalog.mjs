// Shared by the browser review and offline contact-sheet builder. No runtime imports.
const fail = message => { throw new Error(`Motion catalog: ${message}`) }
const text = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 500) fail(name); return value }
export function assetPath(value) {
  if (typeof value !== 'string' || !/^(?:motion|canonical|masks)\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.png$/.test(value) || value.split('/').some(p => p === '.' || p === '..')) fail(`unsafe PNG path: ${value}`)
  return value
}
export function validateCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== 1) fail('unsupported schemaVersion')
  if (catalog.artStatus !== 'production-candidate') fail('artStatus must remain production-candidate')
  if (typeof catalog.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(catalog.generatedAt) || !Number.isFinite(Date.parse(catalog.generatedAt))) fail('generatedAt')
  if (!catalog.source || !/^[a-f0-9]{64}$/i.test(catalog.source.sha256) || !Number.isInteger(catalog.source.samples) || catalog.source.samples < 1) fail('source provenance')
  text(catalog.source.blender, 'Blender version')
  if (!['../../../src/assets/pet/cc-v1/', '../../src/assets/pet/cc-v1/'].includes(catalog.baseUrl)) fail('baseUrl must resolve to the local CC kit')
  if (!Array.isArray(catalog.forms) || catalog.forms.length !== 2 || catalog.forms[0].id !== 'lit' || catalog.forms[1].id !== 'unlit') fail('paired lit/unlit forms')
  for (const form of catalog.forms) { text(form.label, 'form label'); text(form.description, 'form description') }
  if (!Array.isArray(catalog.clips) || !catalog.clips.length || catalog.clips.length > 100) fail('clips')
  const seen = new Set()
  for (const clip of catalog.clips) {
    if (typeof clip.id !== 'string' || !/^[a-z0-9-]+$/.test(clip.id) || seen.has(clip.id)) fail('unique clip id')
    seen.add(clip.id); text(clip.title, 'clip title')
    if (clip.artStatus !== 'production-candidate') fail(`candidate status: ${clip.id}`)
    if (!Number.isFinite(clip.fps) || clip.fps <= 0 || clip.fps > 60 || typeof clip.loop !== 'boolean') fail(`fps / loop: ${clip.id}`)
    const n = clip.frames?.lit?.length
    if (!Array.isArray(clip.frames?.lit) || !Array.isArray(clip.frames?.unlit) || !n || n > 600 || clip.frames.unlit.length !== n || !Array.isArray(clip.masks) || clip.masks.length !== n) fail(`paired frames and masks: ${clip.id}`)
    for (const path of [...clip.frames.lit, ...clip.frames.unlit, ...clip.masks]) assetPath(path)
    if (!Number.isInteger(clip.posterIndex) || clip.posterIndex < 0 || clip.posterIndex >= n) fail(`posterIndex: ${clip.id}`)
  }
  return catalog
}
export function resolveClipFrames(catalog, clip, catalogURL) {
  const origin = new URL(catalogURL), base = new URL(catalog.baseUrl, origin)
  if (base.origin !== origin.origin || base.search || base.hash || !base.pathname.endsWith('/src/assets/pet/cc-v1/')) fail('baseUrl is outside the CC kit')
  return Object.fromEntries(['lit', 'unlit'].map(form => [form, clip.frames[form].map(path => new URL(assetPath(path), base).href)]))
}
export function frameAtElapsed(clip, elapsedMs) {
  const count = clip.frames.lit.length, tick = Math.floor(Math.max(0, elapsedMs) * clip.fps / 1000)
  return { index: clip.loop ? tick % count : Math.min(tick, count - 1), ended: !clip.loop && tick >= count }
}

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile, mkdir, symlink, access, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateCatalog, resolveClipFrames, frameAtElapsed } from '../art/cc-v1/motion/catalog.mjs'
import { buildMotionReview } from './build-cc-motion-review.mjs'
import { readRGBA } from './cc-png.mjs'

const kit = resolve('apps/desktop/src/assets/pet/cc-v1')
// Optional offline raster integration; pure catalog/fps checks always run in CI.
const integrationTest = test.skipIf(!process.env.CC_SHARP_MODULE)
export function fixtureCatalog() {
  return { schemaVersion: 1, artStatus: 'production-candidate', generatedAt: '2026-10-29T17:01:00Z', source: { sha256: 'a'.repeat(64), blender: '5.2.1', samples: 32 }, baseUrl: '../../../src/assets/pet/cc-v1/', forms: [{ id: 'lit', label: 'Light CC', description: '在身边' }, { id: 'unlit', label: 'Dark CC', description: '暂时没连上' }], clips: [{ id: 'fixture', title: '测试素材 · canonical', fps: 8, loop: false, artStatus: 'production-candidate', frames: { lit: ['canonical/lit/front.png', 'canonical/lit/front.png'], unlit: ['canonical/unlit/front.png', 'canonical/unlit/front.png'] }, masks: ['canonical/lit/front.png', 'canonical/lit/front.png'], posterIndex: 0 }] }
}

test('catalog resolves paired frames against catalog URL, preserving fps and status', () => {
  const catalog = validateCatalog(fixtureCatalog())
  const urls = resolveClipFrames(catalog, catalog.clips[0], 'https://local.test/apps/desktop/art/cc-v1/motion/catalog.json')
  assert.equal(urls.lit[0], 'https://local.test/apps/desktop/src/assets/pet/cc-v1/canonical/lit/front.png')
  assert.equal(catalog.clips[0].fps, 8)
})
test('rejects corrupt, misleading and unsafe catalogs before resolving assets', () => {
  for (const mutate of [c => { c.schemaVersion = 2 }, c => { c.clips[0].id = null }, c => { c.generatedAt = 123 }, c => { c.artStatus = 'reviewed' }, c => { c.clips[0].fps = 0 }, c => { c.clips[0].frames.unlit.pop() }, c => { c.clips[0].posterIndex = 20 }, c => { c.clips[0].loop = 'yes' }, c => { c.clips[0].masks = [] }, c => { c.clips[0].frames.lit[0] = '../secret.png' }, c => { c.clips[0].frames.lit[0] = 'https://evil.test/p.png' }, c => { c.baseUrl = 'https://evil.test/src/assets/pet/cc-v1/' }, c => { c.clips[0].frames.lit[0] = 'CC_MASTER_V1.png' }]) {
    const c = fixtureCatalog(); mutate(c); assert.throws(() => validateCatalog(c))
  }
  assert.throws(() => validateCatalog(null))
  const c = fixtureCatalog(); c.baseUrl = '/unrelated/'; assert.throws(() => resolveClipFrames(c, c.clips[0], 'https://local.test/catalog.json'))
})
test('fps playback loops at real duration and one shots hold final frame', () => {
  const clip = fixtureCatalog().clips[0]
  assert.deepEqual(frameAtElapsed(clip, 100), { index: 0, ended: false })
  assert.deepEqual(frameAtElapsed(clip, 125), { index: 1, ended: false })
  assert.deepEqual(frameAtElapsed(clip, 250), { index: 1, ended: true })
  assert.deepEqual(frameAtElapsed({ ...clip, loop: true }, 250), { index: 0, ended: false })
})
integrationTest('builder rejects missing catalog, invalid JSON, missing and corrupt PNG before output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-motion-test-'))
  try {
    const path = join(dir, 'catalog.json'), output = join(dir, 'out')
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: kit, outputPath: output }), /catalog/i)
    await writeFile(path, '{oops'); await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: kit, outputPath: output }), /catalog/i)
    const c = fixtureCatalog(); c.clips[0].frames.lit[0] = 'motion/missing.png'; await writeFile(path, JSON.stringify(c))
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: kit, outputPath: output }), /missing.png/)
    await assert.rejects(access(output))
    const missingMask = fixtureCatalog(); missingMask.clips[0].masks[0] = 'masks/missing-mask.png'; await writeFile(path, JSON.stringify(missingMask))
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: kit, outputPath: output }), /missing-mask.png/)
    const badKit = join(dir, 'kit'); await mkdir(join(badKit, 'motion'), { recursive: true }); await writeFile(join(badKit, 'motion/bad.png'), 'not png')
    c.clips[0].frames = { lit: ['motion/bad.png'], unlit: ['motion/bad.png'] }; c.clips[0].masks = ['motion/bad.png']; await writeFile(path, JSON.stringify(c))
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: badKit, outputPath: output }), /PNG|bad.png/)
    await symlink(join(kit, 'canonical/lit/front.png'), join(badKit, 'motion/outside.png'))
    c.clips[0].frames = { lit: ['motion/outside.png'], unlit: ['motion/outside.png'] }; c.clips[0].masks = ['motion/outside.png']; await writeFile(path, JSON.stringify(c))
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: badKit, outputPath: output }), /outside asset kit/)
    await assert.rejects(access(output))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
integrationTest('builder renders real canonical PNG fixture and writes dimensions, counts and digests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-motion-build-'))
  try {
    const path = join(dir, 'catalog.json'); await writeFile(path, JSON.stringify(fixtureCatalog()))
    const summary = await buildMotionReview({ catalogPath: path, kitPath: kit, outputPath: join(dir, 'out'), sizes: [48] })
    assert.equal(summary.pairedSamples, 2); assert.equal(summary.frameReferences, 4)
    assert.equal(summary.sheets.length, 1); assert.ok(summary.sheets[0].width >= 640, 'labels remain readable for short clips at 48px'); assert.equal(summary.sheets[0].renderedFrames, 8)
    assert.match(summary.catalogSha256, /^[a-f0-9]{64}$/)
    assert.equal(summary.assets.length, 2)
    assert.ok(summary.assets.every(a => a.width === 512 && a.height === 512 && a.sha256.length === 64))
    const bytes = await readFile(join(dir, 'out', summary.sheets[0].file)); assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    assert.equal(JSON.parse(await readFile(join(dir, 'out', 'summary.json'), 'utf8')).artStatus, 'production-candidate')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const role of ['late-frame', 'mask-only']) integrationTest(`CRC-corrupt ${role} rejects before changing existing outputs`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-motion-crc-'))
  try {
    const testKit = join(dir, 'kit'), output = join(dir, 'out'), path = join(dir, 'catalog.json')
    for (const form of ['lit', 'unlit']) {
      await mkdir(join(testKit, 'canonical', form), { recursive: true })
      await copyFile(join(kit, 'canonical', form, 'front.png'), join(testKit, 'canonical', form, 'front.png'))
    }
    const corruptPath = role === 'late-frame' ? 'motion/bad.png' : 'masks/motion/bad.png'
    await mkdir(join(testKit, ...corruptPath.split('/').slice(0, -1)), { recursive: true })
    const corrupt = Buffer.from(await readFile(join(kit, 'canonical/lit/front.png')))
    corrupt[29] ^= 1 // IHDR CRC only: dimensions, compressed pixels and alpha remain valid.
    assert.doesNotThrow(() => readRGBA(corrupt), 'exercise corruption the lightweight decoder misses')
    await writeFile(join(testKit, corruptPath), corrupt)
    const catalog = fixtureCatalog(), late = structuredClone(catalog.clips[0]); late.id = 'late'
    if (role === 'late-frame') late.frames.lit[0] = corruptPath
    else late.masks[0] = corruptPath
    catalog.clips.push(late); await writeFile(path, JSON.stringify(catalog))
    await mkdir(output)
    const previousSheet = Buffer.from('existing reviewed sheet bytes'), previousSummary = Buffer.from('{"previous":"summary"}\n')
    await writeFile(join(output, 'fixture-48.png'), previousSheet)
    await writeFile(join(output, 'summary.json'), previousSummary)
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: testKit, outputPath: output, sizes: [48] }))
    assert.ok((await readFile(join(output, 'fixture-48.png'))).equals(previousSheet), 'earlier valid clips must not replace existing sheets before all assets validate')
    assert.ok((await readFile(join(output, 'summary.json'))).equals(previousSummary), 'existing summary bytes stay unchanged')
    assert.deepEqual((await readdir(output)).sort(), ['fixture-48.png', 'summary.json'])
    const freshOutput = join(dir, 'fresh-out')
    await assert.rejects(buildMotionReview({ catalogPath: path, kitPath: testKit, outputPath: freshOutput, sizes: [48] }))
    await assert.rejects(access(freshOutput), 'corrupt asset must not create even an empty output directory')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

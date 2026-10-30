import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildMotionSamples, webpDelays } from './build-cc-motion-samples.mjs'

const require = createRequire(import.meta.url)
const rasterTest = test.skipIf(!process.env.CC_SHARP_MODULE)
const browserTest = test.skipIf(!process.env.CC_SHARP_MODULE || !process.env.CC_PLAYWRIGHT_MODULE)
const catalog = () => ({ schemaVersion: 1, artStatus: 'production-candidate', generatedAt: '2026-10-29T17:01:00Z', source: { sha256: 'a'.repeat(64), blender: '5.2.1', samples: 32 }, baseUrl: '../../../src/assets/pet/cc-v1/', forms: [{ id: 'lit', label: 'Light CC', description: 'Light form' }, { id: 'unlit', label: 'Dark CC', description: 'Dark form' }], clips: [{ id: 'gesture', title: 'A quiet gesture', fps: 12, loop: false, artStatus: 'production-candidate', frames: { lit: [0, 1, 2].map(i => `motion/lit/gesture/${i}.png`), unlit: [0, 1, 2].map(i => `motion/unlit/gesture/${i}.png`) }, masks: [0, 1, 2].map(i => `masks/gesture/${i}.png`), posterIndex: 1 }] })

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-motion-samples-'))
  const kitPath = join(dir, 'kit'), catalogPath = join(dir, 'catalog.json'), outputPath = join(dir, 'samples')
  const c = catalog(), sharp = require(process.env.CC_SHARP_MODULE)
  for (const clip of c.clips) for (const [paths, color] of [[clip.frames.lit, '#f8edd7'], [clip.frames.unlit, '#242322'], [clip.masks, '#ffffff']]) {
    for (const [i, path] of paths.entries()) {
      await mkdir(join(kitPath, path, '..'), { recursive: true })
      await sharp(Buffer.from(`<svg width="512" height="512"><rect x="${130 + i * 40}" y="140" width="100" height="200" fill="${color}"/></svg>`)).ensureAlpha().png().toFile(join(kitPath, path))
    }
  }
  await writeFile(catalogPath, JSON.stringify(c))
  try { await run({ dir, c, sharp, options: { catalogPath, kitPath, outputPath, displaySize: 128 } }) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('WebP delays preserve sample count and nearest cumulative catalog timestamps', () => {
  assert.deepEqual(webpDelays(3, 12), [83, 84, 83])
  assert.deepEqual(webpDelays(4, 8), [125, 125, 125, 125])
  for (const [n, fps] of [[0, 8], [3.5, 8], [3, 0], [3, Infinity], [601, 8], [3, 61]]) assert.throws(() => webpDelays(n, fps), /timing/)
})

for (const [name, mutate, pattern] of [
  ['wrong timing', c => { c.clips[0].fps = 0 }, /fps/],
  ['pair count mismatch', c => { c.clips[0].frames.unlit.pop() }, /paired/],
  ['mismatched pair sample', c => { c.clips[0].frames.unlit.reverse() }, /pair/],
  ['missing late frame', c => { c.clips[0].frames.unlit[2] = 'motion/unlit/gesture/missing.png' }, /missing|pair/],
  ['private title', c => { c.clips[0].title = '/Users/private/CC_MASTER_V1' }, /shareable/],
]) rasterTest(`rejects ${name} before creating output`, async () => fixture(async ({ c, options }) => {
  mutate(c); await writeFile(options.catalogPath, JSON.stringify(c))
  await assert.rejects(buildMotionSamples(options), pattern)
  await assert.rejects(access(options.outputPath))
}))

rasterTest('rejects corrupt masks before modifying an existing empty output', async () => fixture(async ({ c, options }) => {
  const path = join(options.kitPath, c.clips[0].masks[2]), bytes = await readFile(path)
  bytes[29] ^= 1; await writeFile(path, bytes)
  await mkdir(options.outputPath)
  await assert.rejects(buildMotionSamples(options), /PNG/)
  assert.deepEqual(await readdir(options.outputPath), [])
}))

rasterTest('rejects invalid caller options and missing masks before any output', async () => fixture(async ({ options, c }) => {
  for (const override of [{ outputPath: 'https://example.test/output' }, { outputPath: '' }, { outputPath: 'bad\npath' }, { outputPath: null }, { displaySize: 96 }, { catalogPath: join(options.kitPath, 'absent.json') }]) {
    await assert.rejects(buildMotionSamples({ ...options, ...override }))
    await assert.rejects(access(options.outputPath))
  }
  await rm(join(options.kitPath, c.clips[0].masks[2]))
  await assert.rejects(buildMotionSamples(options), /PNG/)
  await assert.rejects(access(options.outputPath))
}))

rasterTest('CLI rejects URL output arguments before resolving or writing them as local paths', async () => fixture(async ({ options, dir }) => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./build-cc-motion-samples.mjs', import.meta.url)), options.catalogPath, options.kitPath, 'https://example.test/output'], { cwd: dir, encoding: 'utf8' })
  assert.equal(child.status, 1, child.stderr)
  assert.deepEqual((await readdir(dir)).sort(), ['catalog.json', 'kit'])
}))

rasterTest('rejects escaping asset symlinks and overlapping or nonempty output paths without writes', async () => fixture(async ({ options, c, dir }) => {
  for (const outputPath of [options.kitPath, join(options.kitPath, 'nested'), dir, options.catalogPath]) {
    await assert.rejects(buildMotionSamples({ ...options, outputPath }), /output|overlap/)
  }
  const alias = join(dir, 'alias'); await symlink(options.kitPath, alias)
  await assert.rejects(buildMotionSamples({ ...options, outputPath: join(alias, 'nested') }), /overlap/)
  await mkdir(options.outputPath); await writeFile(join(options.outputPath, 'keep.txt'), 'keep')
  await assert.rejects(buildMotionSamples(options), /empty/)
  assert.equal(await readFile(join(options.outputPath, 'keep.txt'), 'utf8'), 'keep')
  await rm(options.outputPath, { recursive: true })
  const frame = join(options.kitPath, c.clips[0].frames.lit[0]), outside = join(dir, 'outside.png')
  await writeFile(outside, await readFile(frame)); await rm(frame); await symlink(outside, frame)
  await assert.rejects(buildMotionSamples(options), /outside/)
  await assert.rejects(access(options.outputPath))
}))

rasterTest('writes three paired samples with actual WebP timing, paper composition and portable metadata', async () => fixture(async ({ options, c, sharp, dir }) => {
  const result = await buildMotionSamples(options)
  assert.equal(result.artStatus, 'production-candidate')
  assert.equal(result.clips[0].frameCount, 3)
  assert.equal(result.clips[0].fps, 12)
  assert.equal(result.clips[0].durationMs, 250)
  assert.deepEqual(result.clips[0].webpDelaysMs, [83, 84, 83])
  const meta = await sharp(join(options.outputPath, 'gesture.webp'), { animated: true }).metadata()
  assert.equal(meta.pages, 3); assert.equal(meta.loop, 1); assert.deepEqual(meta.delay, [83, 84, 83])
  assert.equal(meta.width, result.width); assert.equal(meta.pageHeight, result.height)
  const decoded = await sharp(join(options.outputPath, 'gesture.webp'), { animated: true }).ensureAlpha().raw().toBuffer()
  for (let i = 0; i < 3; i++) {
    const p = i * result.width * result.height * 4
    assert.deepEqual([...decoded.subarray(p, p + 4)], [250, 247, 242, 255])
    for (const [x, color] of [[132 + i * 10, [248, 237, 215, 255]], [452 + i * 10, [36, 35, 34, 255]]]) {
      const offset = p + (152 * result.width + x) * 4
      assert.deepEqual([...decoded.subarray(offset, offset + 4)], color, 'both columns use the same sample index and preserve input color/alpha over paper')
    }
  }
  const poster = await sharp(join(options.outputPath, 'index.png')).metadata()
  assert.equal(poster.width, result.width); assert.equal(poster.height, result.height)
  const html = await readFile(join(options.outputPath, 'index.html'), 'utf8')
  assert.ok(html.includes('data:image/png;base64,'))
  assert.ok(html.includes('gesture.webp'))
  for (const privateText of [dir, '/Users/', 'CC_MASTER_V1', 'CC_DESIGN_SHEET_V1', c.forms[1].description]) assert.ok(!html.includes(privateText))
  assert.ok(!(await readFile(join(options.outputPath, 'summary.json'), 'utf8')).includes(dir))
}))

rasterTest('retains duplicate samples and avoids clip ids colliding with the index poster', async () => fixture(async ({ options, c, sharp }) => {
  c.clips[0].id = 'index'
  for (const form of ['lit', 'unlit']) c.clips[0].frames[form].fill(c.clips[0].frames[form][0])
  c.clips[0].masks.fill(c.clips[0].masks[0]); c.clips[0].loop = true
  const second = structuredClone(c.clips[0]); second.id = 'second'; c.clips.push(second)
  await writeFile(options.catalogPath, JSON.stringify(c))
  const result = await buildMotionSamples(options)
  assert.notEqual(result.clips[0].poster, 'index.png')
  const meta = await sharp(join(options.outputPath, result.clips[0].webp), { animated: true }).metadata()
  assert.equal(meta.pages, 3); assert.deepEqual(meta.delay, [83, 84, 83]); assert.equal(meta.loop, 0)
  assert.equal((await sharp(join(options.outputPath, 'index.png')).metadata()).height, result.height * 2)
}))

browserTest('standalone file preview plays one shot to last frame, holds, and replays; loop wraps', async () => fixture(async ({ options, c, dir }) => {
  const loop = structuredClone(c.clips[0]); loop.id = 'loop'; loop.loop = true; loop.fps = 8; c.clips.push(loop)
  await writeFile(options.catalogPath, JSON.stringify(c)); await buildMotionSamples(options)
  const { chromium } = require(process.env.CC_PLAYWRIGHT_MODULE)
  const browser = await chromium.launch({ headless: true, ...(process.env.CC_CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.CC_CHROMIUM_EXECUTABLE_PATH }) })
  try {
    const page = await browser.newPage()
    const requests = []; page.on('request', request => requests.push(request.url()))
    await page.clock.install({ time: new Date('2026-10-29T00:00:00Z') })
    await page.goto(`file://${join(options.outputPath, 'index.html')}`)
    const gesture = page.locator('[data-clip="gesture"]'), loopCard = page.locator('[data-clip="loop"]')
    await gesture.locator('button').click(); await gesture.locator('button').filter({ hasText: 'Pause' }).waitFor(); await page.clock.runFor(200)
    assert.equal(await gesture.locator('img').getAttribute('data-frame'), '2')
    await page.clock.runFor(700)
    assert.equal(await gesture.locator('img').getAttribute('data-frame'), '2')
    assert.equal(await gesture.locator('button').textContent(), 'Replay')
    await gesture.locator('button').click(); await gesture.locator('button').filter({ hasText: 'Pause' }).waitFor()
    assert.equal(await gesture.locator('img').getAttribute('data-frame'), '0')
    await loopCard.locator('button').click(); await loopCard.locator('button').filter({ hasText: 'Pause' }).waitFor(); await page.clock.runFor(390)
    assert.equal(await loopCard.locator('img').getAttribute('data-frame'), '0')
    await page.screenshot({ path: join(dir, 'preview.png'), fullPage: true })
    assert.ok(requests.every(url => url.startsWith('file:') || url.startsWith('data:')))
  } finally { await browser.close() }
}))

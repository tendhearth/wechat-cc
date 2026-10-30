// Isolated single-browser QA, never connects to a daemon. The injected catalog
// deliberately repeats existing canonical PNGs: it verifies controls, not new art.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../../..')
const entry = '/apps/desktop/art/cc-v1/motion/index.html'
const fixture = { schemaVersion: 1, artStatus: 'production-candidate', generatedAt: '2026-10-29T17:01:00Z', source: { sha256: 'a'.repeat(64), blender: '5.2.1', samples: 32 }, baseUrl: '../../../src/assets/pet/cc-v1/', forms: [{ id: 'lit', label: 'Light CC', description: '在身边' }, { id: 'unlit', label: 'Dark CC', description: '暂时没连上' }], clips: ['once', 'loop'].map(id => ({ id, title: `测试 fixture ${id}`, fps: 8, loop: id === 'loop', artStatus: 'production-candidate', frames: { lit: Array(3).fill('canonical/lit/front.png'), unlit: Array(3).fill('canonical/unlit/front.png') }, masks: Array(3).fill('canonical/lit/front.png'), posterIndex: 0 })) }
test('paired review controls, real fps, reduced motion and broken assets', { timeout: 60000 }, async () => {
  await readFile(resolve(root, `.${entry}`)) // RED gate before launching a browser when the entry is absent.
  const { chromium } = require(process.env.CC_PLAYWRIGHT_MODULE || 'playwright')
  let broken = false, corrupt = false
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (pathname.endsWith('/motion/catalog.json')) { res.setHeader('Content-Type', 'application/json'); res.end(corrupt ? '{}' : JSON.stringify(fixture)); return }
      if (broken && pathname.endsWith('/canonical/unlit/front.png')) { res.writeHead(404); res.end(); return }
      const path = resolve(root, `.${pathname}`)
      if (!path.startsWith(root + sep)) throw Error('outside fixture root')
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' }[extname(path)] || 'application/octet-stream'
      const body = await readFile(path); res.setHeader('Content-Type', type); res.end(body)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(4197, '127.0.0.1', ok) })
  server.unref()
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CC_CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.CC_CHROMIUM_EXECUTABLE_PATH }) })
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    const screenshotPath = process.env.CC_MOTION_SCREENSHOT || '/tmp/cc-motion-review-fixture.png'
    const capture = suffix => page.screenshot({ path: screenshotPath.replace(/\.png$/, `${suffix}.png`), fullPage: true })
    await page.goto(`http://127.0.0.1:4197${entry}`)
    await page.waitForFunction(() => document.body.dataset.state === 'ready')
    assert.equal(await page.locator('.form-card').count(), 2)
    assert.match(await page.locator('#frame-info').textContent(), /1 \/ 3/)
    assert.equal(await page.locator('#play').textContent(), '播放')
    await page.locator('#play').click()
    await page.waitForFunction(() => document.body.dataset.playing === 'false' && document.body.dataset.frame === '2')
    await page.waitForTimeout(450); assert.equal(await page.locator('body').getAttribute('data-frame'), '2')
    assert.equal(await page.locator('#play').textContent(), '重播')
    await page.locator('#previous').click(); assert.equal(await page.locator('body').getAttribute('data-frame'), '1')
    await page.locator('#size').selectOption('48')
    assert.equal(await page.locator('#lit-frame').evaluate(img => img.getBoundingClientRect().width), 48)
    await page.locator('#background').selectOption('slate'); assert.equal(await page.locator('#pair').getAttribute('data-background'), 'slate')
    await capture('-slate-48')
    await page.locator('#background').selectOption('paper'); await page.locator('#size').selectOption('256')
    await capture('')
    await page.locator('#clip').selectOption('loop'); await page.waitForFunction(() => document.body.dataset.state === 'ready')
    await page.locator('#play').focus(); await page.keyboard.press('Space')
    await page.waitForTimeout(450); assert.equal(await page.locator('body').getAttribute('data-playing'), 'true')
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForFunction(() => document.querySelector('#play').disabled)
    assert.equal(await page.locator('body').getAttribute('data-playing'), 'false')
    const stopped = await page.locator('body').getAttribute('data-frame'); await page.waitForTimeout(250)
    assert.equal(await page.locator('body').getAttribute('data-frame'), stopped)
    await page.locator('#next').click(); assert.equal(await page.locator('#next').isEnabled(), true)
    await page.emulateMedia({ reducedMotion: 'no-preference' }); assert.equal(await page.locator('body').getAttribute('data-playing'), 'false')
    await page.locator('#reduce-motion').check(); assert.equal(await page.locator('#play').isDisabled(), true)
    await page.locator('#reduce-motion').uncheck()
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload(); await page.waitForFunction(() => document.body.dataset.state === 'ready')
    assert.equal(await page.locator('#play').isDisabled(), true)
    assert.equal(await page.locator('body').getAttribute('data-frame'), '0')
    await page.locator('#next').click(); assert.equal(await page.locator('body').getAttribute('data-frame'), '1')
    await capture('-reduced')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    broken = true; await page.reload(); await page.waitForFunction(() => document.body.dataset.state === 'error')
    assert.match(await page.locator('#status').textContent(), /无法载入/)
    await capture('-broken')
    assert.equal(await page.locator('#play').isDisabled(), true); assert.equal(await page.locator('#lit-frame').isVisible(), false)
    broken = false; await page.locator('#clip').selectOption('loop'); await page.waitForFunction(() => document.body.dataset.state === 'ready')
    assert.equal(await page.locator('#lit-frame').isVisible(), true)
    broken = false; corrupt = true; await page.reload(); await page.waitForFunction(() => document.body.dataset.state === 'error')
    assert.match(await page.locator('#status').textContent(), /目录/)
    await page.close()
  } finally { await browser?.close(); await new Promise(ok => server.close(ok)) }
})

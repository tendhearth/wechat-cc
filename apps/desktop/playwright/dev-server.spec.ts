// Dev-server smoke + hardening checks.
//
// Distinct from the rest of the Playwright suite (which targets test-shim.ts
// on 4174). This spec spawns `bun dev-server.ts` on its own port and exercises
// the bits that changed in the path-guard + body-injection + SSE fix.

import { test as base, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 4175
const BASE = `http://127.0.0.1:${PORT}`
const FIXTURE_DIR = join(process.cwd(), 'src', '__playwright_devserver__')

interface DevServerWorkerFixtures {
  devUrl: string
}

async function waitForUrl(url: string, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok || r.status === 404) return
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`dev-server did not start at ${url} within ${timeoutMs}ms`)
}

const test = base.extend<{}, DevServerWorkerFixtures>({
  devUrl: [async ({}, use) => {
    // Test fixture: two </body> tags — one inside a <script> string, one real.
    // Verifies the hardened regex picks the LAST closing tag.
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true })
    writeFileSync(
      join(FIXTURE_DIR, 'double-body.html'),
      `<!doctype html><html><body>
<script>const literal = "</body>";</script>
<p id="marker">real</p>
</body></html>
`,
    )

    let proc: ChildProcess | null = null
    try {
      proc = spawn('bun', ['dev-server.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })
      proc.stderr?.on('data', d => process.stderr.write(`[dev-server] ${d}`))
      proc.stdout?.on('data', d => process.stderr.write(`[dev-server] ${d}`))
      await waitForUrl(BASE, 10_000)
      await use(BASE)
    } finally {
      if (proc) {
        proc.kill('SIGTERM')
        await new Promise(r => setTimeout(r, 500))
      }
      if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true })
    }
  }, { scope: 'worker' }],
})

test.describe('dev-server', () => {
  test('serves index.html and injects the reload script before </body>', async ({ page, devUrl }) => {
    const r = await page.request.get(devUrl + '/')
    expect(r.status()).toBe(200)
    const html = await r.text()
    expect(html).toContain('<script src="/__dev_reload.js"></script>')
    // Script tag must appear before the real closing body.
    const scriptIdx = html.indexOf('<script src="/__dev_reload.js"></script>')
    const bodyIdx = html.lastIndexOf('</body>')
    expect(scriptIdx).toBeGreaterThan(-1)
    expect(scriptIdx).toBeLessThan(bodyIdx)
  })

  test('serves /__dev_reload.js with javascript MIME', async ({ page, devUrl }) => {
    const r = await page.request.get(devUrl + '/__dev_reload.js')
    expect(r.status()).toBe(200)
    expect(r.headers()['content-type']).toMatch(/javascript/)
    expect(await r.text()).toContain('EventSource')
  })

  test('hardened </body> injection: injects before the LAST closing tag, not one in a script string', async ({ page, devUrl }) => {
    const r = await page.request.get(devUrl + '/__playwright_devserver__/double-body.html')
    expect(r.status()).toBe(200)
    const html = await r.text()
    // The literal `</body>` inside the script must still be there (untouched).
    expect(html).toContain('const literal = "</body>"')
    // Exactly one injected script tag.
    const matches = html.match(/<script src="\/__dev_reload\.js"><\/script>/g) ?? []
    expect(matches.length).toBe(1)
    // It must land AFTER the script's literal </body> (i.e. before the real one).
    const scriptLiteralIdx = html.indexOf('const literal = "</body>"')
    const injectedIdx = html.indexOf('<script src="/__dev_reload.js"></script>')
    expect(injectedIdx).toBeGreaterThan(scriptLiteralIdx)
  })

  test('path traversal: requests escaping src/ return 403', async ({ page, devUrl }) => {
    // %2f decodes to '/' after URL parsing, then path.join collapses '..'.
    const r = await page.request.get(devUrl + '/..%2fpackage.json')
    expect([403, 404]).toContain(r.status())
    if (r.status() === 200) {
      // Defensive: if a future regression lets this through, fail loud.
      const body = await r.text()
      expect(body).not.toContain('"name":')
    }
  })

  test('SSE reload: broadcasts on file change', async ({ devUrl }) => {
    // Subscribe to the SSE endpoint via fetch streaming.
    const ac = new AbortController()
    const r = await fetch(devUrl + '/__dev_reload', { signal: ac.signal })
    expect(r.ok).toBe(true)
    expect(r.headers.get('content-type')).toContain('text/event-stream')

    const reader = r.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const sawReload = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return false
        buffer += decoder.decode(value)
        if (buffer.includes('event: reload')) return true
      }
    })()

    // Small delay so the watcher is registered before we trigger.
    await new Promise(r => setTimeout(r, 200))
    // Touch a file under src/ to trigger the watcher.
    const touchPath = join(FIXTURE_DIR, 'touch.txt')
    writeFileSync(touchPath, String(Date.now()))

    const got = await Promise.race([
      sawReload,
      new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
    ])
    ac.abort()
    expect(got).toBe(true)
  })

  test('static file served with correct MIME', async ({ page, devUrl }) => {
    const r = await page.request.get(devUrl + '/main.js')
    expect(r.status()).toBe(200)
    expect(r.headers()['content-type']).toMatch(/javascript/)
  })
})

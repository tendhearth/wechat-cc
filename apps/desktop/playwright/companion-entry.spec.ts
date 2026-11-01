import { test, expect } from './fixtures'
import { REPORTS } from './reports'

test.beforeEach(async ({ page, shim }) => {
  await page.route('**/__dev_reload.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await shim.invoke('demo.unseed'); await shim.invoke('demo.seed', {})
  await shim.invoke('mock.doctor', { report: REPORTS.allGreen })
})

async function nativeEntry(page: import('@playwright/test').Page, options: { doctor?: boolean, pending?: boolean, config?: boolean, destination?: string | null }) {
  await page.addInitScript(options => {
    const listeners = new Map<string, (event: any) => void>()
    let releaseDoctor!: () => void, releasePending!: () => void, releaseConfig!: () => void
    const doctor = new Promise<void>(resolve => { releaseDoctor = resolve })
    const pending = new Promise<void>(resolve => { releasePending = resolve })
    const config = new Promise<void>(resolve => { releaseConfig = resolve })
    const fixture = { doctorRead: false, pendingRead: false, configRead: false,
      releaseDoctor, releasePending, releaseConfig,
      emit: (page: string) => { const fn = listeners.get('wechat-cc:navigate'); fn?.({ payload: { page } }); return Boolean(fn) },
    }
    ;(window as any).__entryFixture = fixture
    ;(window as any).__TAURI__ = { event: {
      listen: async (name: string, fn: (event: any) => void) => { listeners.set(name, fn); return () => listeners.delete(name) },
    }, window: { getCurrentWindow: () => ({ startDragging: async () => {} }) }, core: {
      invoke: async (command: string, args: any = {}) => {
        if (command === 'take_pending_navigate') {
          fixture.pendingRead = true
          if (options.pending) await pending
          return options.destination === undefined ? 'converse' : options.destination
        }
        if (command === 'wechat_cli_json' && args.args?.[0] === 'doctor') {
          fixture.doctorRead = true
          if (options.doctor) await doctor
        }
        if (command === 'wechat_cli_json' && args.args?.[0] === 'provider' && args.args?.[1] === 'show') {
          fixture.configRead = true
          if (options.config) await config
        }
        if (command === 'daemon_request') {
          const response = await fetch(args.path, { method: args.method,
            ...(args.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: args.body ?? '{}' } : {}) })
          if (!response.ok) throw Error(`Test daemon boundary returned ${response.status}`)
          return response.text()
        }
        const response = await fetch('/__invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) })
        const value = await response.json()
        if (value.error !== undefined) throw Error(String(value.error))
        return value.result
      },
    } }
  }, options)
}

async function expectConversation(page: import('@playwright/test').Page) {
  await expect(page.locator('main.dashboard')).toBeVisible()
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-now', 'chat')
  await expect(page.locator('#converse-input')).toBeFocused()
}

test('fast pending pet navigation waits for the visible dashboard before focusing chat', async ({ page, shimUrl }) => {
  await nativeEntry(page, { doctor: true })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (window as any).__entryFixture.doctorRead)).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__entryFixture.pendingRead)).toBe(true)
  await page.evaluate(() => (window as any).__entryFixture.releaseDoctor())
  await expectConversation(page)
})

test('slow pending pet navigation focuses chat after the dashboard has already opened', async ({ page, shimUrl }) => {
  await nativeEntry(page, { pending: true })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.dashboard')).toBeVisible()
  await page.evaluate(() => (window as any).__entryFixture.releasePending())
  await expectConversation(page)
})

test('a live pet navigation received while provider setup loads is retained', async ({ page, shimUrl }) => {
  await nativeEntry(page, { config: true, destination: null })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (window as any).__entryFixture.configRead)).toBe(true)
  expect(await page.evaluate(() => (window as any).__entryFixture.emit('converse'))).toBe(true)
  await page.evaluate(() => (window as any).__entryFixture.releaseConfig())
  await expectConversation(page)
})

test('a running main window uses the same focused conversation entry', async ({ page, shimUrl }) => {
  await nativeEntry(page, { destination: null })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.dashboard')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__entryFixture.emit('converse'))).toBe(true)
  await expectConversation(page)
})

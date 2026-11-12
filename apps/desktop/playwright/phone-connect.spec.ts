// 「连接手机」(plan 7a):设置抽屉的弹层。驱动 test-shim(DRY_RUN)的 /v1/phone/* 演示路由。
import { test, expect, reveal } from './fixtures'
import { REPORTS } from './reports'

import { mkdirSync } from 'node:fs'
// 截图只在设了 WECHAT_CC_PAIRING_SHOTS=<目录> 时写;没设就不碰磁盘
const SHOTS = process.env.WECHAT_CC_PAIRING_SHOTS
async function shot(page: import('@playwright/test').Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const URL1 = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
// USZ-YAY = pairCheckCode('r' + 26×a)(packages/protocol pair-check.test.ts 钉住的向量);手机确认卡上显示同一个
const ready = () => ({ ok: true, state: 'ready', url: URL1, expires_at: Date.now() + 600_000, check_code: 'USZ-YAY' })
const dev = (id: string, label?: string) => ({ id, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), ...(label ? { label } : {}) })

async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => { const m = document.documentElement.dataset.mode; return m !== undefined && m !== 'loading' }, { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
}
async function openConnect(page: import('@playwright/test').Page) {
  await reveal(page, '#open-phone-settings')
  await expect(page.locator('#open-phone-settings')).toHaveText('连接手机')
  await page.locator('#open-phone-settings').click()
  await expect(page.locator('#phone-connect-title')).toHaveText('连接手机')
}

test('出码 → 手机配上 → 「已连上 Tendhearth · iPhone」;请求带 enable_remote', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [ready()], devices: [[dev('old')], [dev('old')], [dev('old'), dev('new1', 'Tendhearth · iPhone')]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-qr')).toBeVisible()
  await expect(page.locator('#phone-connect-note')).toHaveText('用手机相机扫一下。10 分钟内有效，只能用一次。')
  await expect(page.locator('#phone-connect-check')).toHaveText('核对码 USZ-YAY')
  await shot(page, 'phone-connect-qr')
  await expect(page.locator('#phone-connect-paired')).toHaveText('已连上 Tendhearth · iPhone', { timeout: 15_000 })
  await expect(page.locator('#phone-connect-close')).toHaveText('完成')
  const calls = await shim.invoke('mock.phone-calls') as { result: { calls: unknown[] } }
  expect(calls.result.calls[0]).toEqual({ enable_remote: true })
  await page.locator('#phone-connect-close').click()
  await expect(page.locator('#phone-settings-modal')).toHaveCount(0)
})

test('未开通点连接 ⇒ enable-relay ⇒ starting ⇒ 出码;只有隐私链接', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'relay_not_configured' }, ready()], enableRelay: [{ ok: false, state: 'starting' }], devices: [[]] } })
  const requests: string[] = []
  page.on('request', req => { if (req.url().includes('/v1/phone/')) requests.push(new URL(req.url()).pathname) })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-starting')).toBeVisible()
  await expect(page.locator('#phone-connect-qr')).toBeVisible({ timeout: 10_000 })
  expect(requests.filter(p => p.endsWith('/enable-relay'))).toHaveLength(1)
  expect(requests.indexOf('/v1/phone/enable-relay')).toBeGreaterThan(requests.indexOf('/v1/phone/link'))
  const privacy = page.getByRole('link', { name: '隐私说明', exact: true })
  await expect(privacy).toHaveAttribute('href', 'https://cc.tendhearth.com/privacy/')
  await expect(privacy).toBeVisible()
  await expect(page.locator('#phone-connect-notice')).toHaveCount(0)
  await expect(page.locator('#phone-connect-body > :not(#phone-connect-qr)')).toHaveText(['核对码 USZ-YAY', '用手机相机扫一下。10 分钟内有效，只能用一次。', '没装 Tendhearth 的手机会打开网页版设置。', '复制链接', '隐私说明'])
  await page.locator('#phone-connect-close').click()
})

test('关闭待返回的未开通流程 ⇒ 不调用 enable-relay;未点击连接也不调用', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { devices: [[]] } })
  let enables = 0
  page.on('request', req => { if (req.url().endsWith('/v1/phone/enable-relay')) enables++ })
  await bootIntoDashboard(page, shimUrl)
  await expect(page.locator('#phone-settings-modal')).toHaveCount(0)
  expect(enables).toBe(0)
  let pending: import('@playwright/test').Route | undefined
  await page.route('**/v1/phone/link', route => { pending = route })
  await openConnect(page)
  await expect.poll(() => !!pending).toBe(true)
  await page.locator('#phone-connect-close').click()
  await pending!.fulfill({ json: { ok: false, state: 'relay_not_configured' } })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)))
  await expect(page.locator('#phone-settings-modal')).toHaveCount(0)
  expect(enables).toBe(0)
})

test('正在打开隧道 ⇒ 等一下 ⇒ 出码', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'starting' }, ready()], devices: [[]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-starting')).toHaveText('正在打开手机连接，CC 会重启一下。')
  await expect(page.locator('#phone-connect-qr')).toBeVisible({ timeout: 10_000 })
})

test('页面上再也没有「手机扫码改设置」', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  expect(await page.content()).not.toContain('手机扫码改设置')
})

// ── 引导页最后一步:不是装好后台服务的机器才会停在这一步 ──
const SERVICE_STEP_REPORT = { ...REPORTS.allGreen, ready: false, checks: { ...REPORTS.allGreen.checks, service: { installed: false, kind: 'launchagent' } } }

test.describe('引导页最后一步', () => {
  test.afterEach(async ({ shim }) => { await shim.invoke('mock.doctor', { report: null }) })

  test('中继就绪 ⇒ 码直接出现;「进入控制台」照样能点', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [ready()], devices: [[]] } })
    await shim.invoke('mock.doctor', { report: SERVICE_STEP_REPORT })
    await page.goto(shimUrl)
    await expect(page.locator('#screen-service')).toHaveClass(/active/, { timeout: 15_000 })
    await expect(page.locator('#onboard-phone')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#onboard-phone-title')).toHaveText('连接手机')
    await expect(page.locator('#onboard-phone-qr > *').first()).toBeVisible()
    await expect(page.locator('#onboard-phone-check')).toHaveText('核对码 USZ-YAY')
    await expect(page.locator('#onboard-phone-check')).toBeVisible()
    await expect(page.locator('#onboard-phone-later')).toHaveText('之后再连也可以：在设置里点「连接手机」。')
    await expect(page.locator('#enter-dashboard')).toBeEnabled()
    await shot(page, 'onboarding-ready')
  })

  test('正在打开隧道 ⇒ 整块亮出来说一声会重启,出码后换成码', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'starting' }, { ok: false, state: 'starting' }, { ok: false, state: 'starting' }, ready()], devices: [[]] } })
    await shim.invoke('mock.doctor', { report: SERVICE_STEP_REPORT })
    await page.goto(shimUrl)
    await expect(page.locator('#screen-service')).toHaveClass(/active/, { timeout: 15_000 })
    await expect(page.locator('#onboard-phone-status')).toHaveText('正在准备连接手机的二维码，CC 会重启一下……', { timeout: 10_000 })
    await expect(page.locator('#onboard-phone')).toBeVisible()
    await shot(page, 'onboarding-starting')
    await expect(page.locator('#onboard-phone-status')).toHaveText('用手机相机扫一下。10 分钟内有效，只能用一次。', { timeout: 15_000 })
  })

  test('中继没开通 ⇒ 整块不出现', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'relay_not_configured' }], devices: [[]] } })
    await shim.invoke('mock.doctor', { report: SERVICE_STEP_REPORT })
    let enables = 0
    page.on('request', req => { if (req.url().endsWith('/v1/phone/enable-relay')) enables++ })
    await page.goto(shimUrl)
    await expect(page.locator('#screen-service')).toHaveClass(/active/, { timeout: 15_000 })
    await expect.poll(async () => ((await shim.invoke('mock.phone-calls')) as { result: { calls: unknown[] } }).result.calls.length).toBeGreaterThan(0)
    await expect(page.locator('#onboard-phone')).toBeHidden()
    await expect(page.locator('#enter-dashboard')).toBeEnabled()
    expect(enables).toBe(0)
    await shot(page, 'onboarding-not-configured')
  })
})

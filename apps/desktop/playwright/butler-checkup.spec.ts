import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'

async function syntheticCheckup(page: import('@playwright/test').Page) {
  let state = { target: { provider: 'fake', model: 'synthetic' }, profile: null as null | object, attempt: null as null | object, periodicProbe: false, suspectedChanged: false }
  const mutations: string[] = []
  await page.route('**/v1/checkup**', async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') mutations.push(path)
    if (path.endsWith('/estimate')) return route.fulfill({ json: { requests: 8, maxRequests: 16, inputTokens: 12000, outputTokens: 1000, windowKnown: false, targetKey: 'synthetic-quote' } })
    if (path.endsWith('/run')) { expect(route.request().postDataJSON().expectedTargetKey).toBe('synthetic-quote') }
    if (path.endsWith('/run')) state = { ...state, attempt: { status: 'running', completedRequests: 0, totalRequests: 8 } }
    if (path.endsWith('/cancel')) state = { ...state, attempt: { status: 'cancelled', completedRequests: 1, totalRequests: 8 } }
    if (path.endsWith('/settings')) state = { ...state, periodicProbe: route.request().postDataJSON().periodicProbe }
    return route.fulfill({ json: state })
  })
  return { mutations, weak() { state = { ...state, profile: { memory: 'weak', tools: 'flaky', testedAt: '2026-11-12T00:00:00Z', short: true } } } }
}

test('checkup shows cost before explicit start, can cancel, and keeps periodic checks opt-in', async ({ page, shimUrl }) => {
  const fake = await syntheticCheckup(page)
  await page.goto(shimUrl)
  await page.locator('.cc-home-details > summary').click()
  const panel = page.locator('.nc-butler')
  await expect(panel).toContainText('还没体检')
  expect(fake.mutations).toEqual([])
  await panel.locator('[data-checkup="prepare"]').click()
  await expect(panel.locator('[data-checkup="estimate"]')).toContainText('12000')
  expect(fake.mutations).toEqual(['/v1/checkup/estimate'])
  await panel.locator('[data-checkup="start"]').click()
  await expect(panel).toContainText('正在体检')
  await panel.locator('[data-checkup="cancel"]').click()
  await expect(panel).toContainText('已取消')
  await expect(panel.locator('[data-checkup="periodic"]')).not.toBeChecked()
  await panel.locator('[data-checkup="periodic"]').check()
  await expect(panel.locator('[data-checkup="periodic"]')).toBeChecked()
})

test('measured weak memory has plain reassurance and a synthetic screenshot fixture', async ({ page, shimUrl }) => {
  const fake = await syntheticCheckup(page); fake.weak()
  await page.goto(shimUrl)
  await page.locator('.cc-home-details > summary').click()
  const panel = page.locator('.nc-butler')
  await expect(panel).toContainText('CC 会更常跟你确认。')
  await expect(panel).toContainText('偶尔出错')
  const out = process.env.WECHAT_CC_DESIGN_SHOTS
  if (out) { await mkdir(out, { recursive: true }); await panel.screenshot({ path: join(out, 'desktop-butler-checkup.png') }) }
})

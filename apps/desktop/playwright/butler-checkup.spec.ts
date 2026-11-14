import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkupReview, type CheckupView } from '../../../packages/protocol/src'
import { test, expect } from './fixtures'

async function shot(page: import('@playwright/test').Page, name: string) {
  const out=process.env.WECHAT_CC_DESIGN_SHOTS
  if(out){await mkdir(out,{recursive:true});await page.locator('.now-panel').screenshot({path:join(out,`desktop-checkup-${name}.png`)})}
}

// 和 dashboard.spec.ts 同一套进面板的办法:等壳子定下模式,再切到 dashboard(只 goto 会停在引导页,点不到「CC 的连接」)。
async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(() => { const m = document.documentElement.dataset.mode; return m !== undefined && m !== 'loading' }, { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
  await expect(page.locator('main.dashboard')).toBeVisible({ timeout: 5_000 })
}

async function syntheticCheckup(page: import('@playwright/test').Page) {
  let state = { target: { provider: 'fake', model: 'synthetic', address:'default',windowTokens:8192,windowKnown:false }, profile: null as null | object, attempt: null as null | object, periodicProbe: false, suspectedChanged: false }
  const mutations: string[] = []
  await page.route('**/v1/checkup**', async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') mutations.push(path)
    if (path.endsWith('/estimate')) return route.fulfill({ json: { requests: 56, maxRequests: 120, inputTokens: 12000, outputTokens: 81200, maxOutputTokens: 350000, summary: '预计用 8 万左右、最多不超过 35 万输出 token，大约 3–6 分钟。', windowKnown: false, targetKey: 'synthetic-quote' } })
    if (path.endsWith('/run')) { expect(route.request().postDataJSON().expectedTargetKey).toBe('synthetic-quote') }
    if (path.endsWith('/run')) state = { ...state, attempt: { status: 'running', completedRequests: 0, totalRequests: 28 } }
    if (path.endsWith('/cancel')) state = { ...state, attempt: { status: 'cancelled', completedRequests: 1, totalRequests: 28 } }
    if (path.endsWith('/settings')) state = { ...state, periodicProbe: route.request().postDataJSON().periodicProbe }
    return route.fulfill({ json: {...state,review:checkupReview(state as CheckupView)} })
  })
  return { mutations, weak() {
    const ratio=(v:number)=>({passed:2*v,total:2,ratio:v})
    state = { ...state, profile: {provider:'fake',addressHash:'synthetic',model:'synthetic',windowTokens:8192,windowKnown:false,reliableFillRatio:.1,stages:[{fillRatio:.1,accuracy:1}],memory:'weak',tools:'flaky',toolAccuracy:.5,firstTextMedianMs:100,completionMedianMs:200,testedAt:'2026-11-12T00:00:00Z',short:true,seed:769906,ccVersion:'fixture',interview:{version:'interview-v3',name:'小禾',reliableDay:'一天',qualities:{memory:ratio(0),tracking:ratio(1),honesty:ratio(1),discretion:ratio(.5),stance:ratio(1),privacy:ratio(1),persona:ratio(1)},business:ratio(.5),stanceActions:{total:4,acted:0,reported:4}}} }
  } }

}

test('checkup shows cost before explicit start, can cancel, and keeps periodic checks opt-in', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const fake = await syntheticCheckup(page)
  await bootIntoDashboard(page, shimUrl)
  await page.locator('.cc-home-details > summary').click()
  const panel = page.locator('.nc-butler')
  await expect(panel).toContainText('还没体检')
  expect(fake.mutations).toEqual([])
  await expect(panel.locator('[data-checkup="periodic"]')).not.toBeChecked()
  await shot(page,'unmeasured')
  await panel.locator('[data-checkup="prepare"]').click()
  await expect(panel.locator('[data-checkup="estimate"]')).toContainText('预计用 8 万左右、最多不超过 35 万输出 token')
  expect(fake.mutations).toEqual(['/v1/checkup/estimate'])
  await panel.locator('[data-checkup="start"]').scrollIntoViewIfNeeded()
  await shot(page,'estimate')
  await panel.locator('[data-checkup="start"]').click()
  await expect(panel).toContainText('正在体检')
  await shot(page,'running')
  await panel.locator('[data-checkup="cancel"]').click()
  await expect(panel).toContainText('已取消')
  await shot(page,'cancelled')
  await expect(panel.locator('[data-checkup="periodic"]')).not.toBeChecked()
  await panel.locator('[data-checkup="periodic"]').check()
  await expect(panel.locator('[data-checkup="periodic"]')).toBeChecked()
})

test('measured weak memory has plain reassurance and a synthetic screenshot fixture', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  const fake = await syntheticCheckup(page); fake.weak()
  await bootIntoDashboard(page, shimUrl)
  await page.locator('.cc-home-details > summary').click()
  const panel = page.locator('.nc-butler')
  await expect(panel).toContainText('CC 会这样照顾它：更勤换新对话')
  await expect(panel).toContainText('动作偶尔发不对')
  await expect(panel).toContainText('小禾（现在用的是 synthetic）')
  for(const quality of ['记性','跟得上','诚实','分寸','立场','口风','办事','本色','快慢'])await expect(panel).toContainText(quality)
  await expect(panel).not.toContainText('管家')
  await expect(panel.locator('.nc-row')).toHaveCount(9)
  const out = process.env.WECHAT_CC_DESIGN_SHOTS
  if (out) {
    await mkdir(out, { recursive: true })
    await panel.locator('h3').evaluate(el=>el.scrollIntoView({block:'start'}))
    await page.locator('.now-panel').screenshot({path:join(out,'desktop-butler-checkup.png')})
    await panel.locator('[data-checkup="prepare"]').scrollIntoViewIfNeeded()
    await shot(page,'interview-bottom')
  }
})

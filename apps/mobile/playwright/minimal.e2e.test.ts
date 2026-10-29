// @ts-nocheck — browser fixture runs real classic-script globals and schema-valid payloads.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pageHtml, EXPIRED_HTML } from '../../../src/features/phone/settings-panel-html.ts'
import { mobilePhoneHtml, MOBILE_BOOTSTRAP_HTML } from '../../../src/features/phone/mobile-page.ts'
import { PHONE_API_SCHEMAS } from '../../../packages/protocol/src/api.ts'
const { test, expect } = createRequire(new URL('../../desktop/package.json', import.meta.url))('@playwright/test')
const HOST = 'http://127.0.0.1:4273'
const id = 'deadbeef', run = '11111111-1111-4111-8111-111111111111'
const title = '**整理一份中文与 English 长标题的出行安排** · 确认时间和所有同行人的意见'
const matter = { id, kind: 'task', title, projectPath: '/private/旅行安排', status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1, agents: ['codex'], agentNames: { codex: 'Codex' }, origin: 'desktop' }
const baseDetail = { ok: true, matter, task: { id, title, phase: 'working', status: 'running', providerId: 'codex', path: '/private/旅行安排', error: null, updatedAt: 1 }, bindings: [], sessions: [], runId: run, events: [{ kind: 'tool_call', text: '检查出行安排', createdAt: 1, activity: { type: 'command', status: 'running', label: '核对每位同行人的时间与确认信息' } }], permissions: [], questions: [], artifacts: [], inputs: [] }
const baseHome = { ok: true, synced_at: new Date().toISOString(), today: '2026-10-28', presence: { presence: 'ok', activity: { kind: 'working', label: '在帮你整理出行安排', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } }, work: { focus: { id, title, kind: 'decision' }, partial: false }, unread: 0, seen_until: null, events: [], next_cursor: null, sources_degraded: [] }
const state = { ok: true, name: 'Nate', persona: '说话温柔，清楚说明未知的事。', prefs: { split: true, stickers: true, care: 'low' }, config: { bot_name: 'CC' }, remote: { available: true, enabled: true, devices: [{ id: 'phone1', label: '这是一台名称很长的中文与 English 手机', current: true, created_at: '2026-10-01T10:00:00Z', last_seen_at: '2026-10-28T10:00:00Z' }] }, atelier: { model_status: { state: 'failed', error: 'download_failed' } }, models: { default_provider: 'codex', checked_at: null, providers: [{ id: 'codex', name: 'Codex', registered: true, model: 'gpt-6.1-sol', status: 'unknown' }, { id: 'openai', name: 'API', registered: true, model: 'DeepSeek', status: 'broken', error: '请求未成功，请检查地址' }], openai: { base_url: 'https://llm.example/v1', model: 'DeepSeek', has_key: true, aliases: { ds: 'DeepSeek' } }, gemini: { has_key: false }, cheap: 'auto', trusted_providers: null, shared_token: [], guest_blocked: [] } }
const art = JSON.parse(readFileSync(new URL('../../../src/features/phone/mobile-presence-art.json', import.meta.url), 'utf8'))
const icon = readFileSync(new URL('../../desktop/src/wechat-cc-logo.png', import.meta.url))

async function fixture(page, opts = {}) {
  const detail = structuredClone(baseDetail), home = structuredClone(baseHome), posts = [], errors = []
  let down = false, empty = false
  page.on('pageerror', e => errors.push(e.message))
  for (const [key, data] of [['GET /m/api/matter', detail], ['GET /m/api/home', home], ['GET /set/api/state', state], ['GET /m/api/matters', { ok: true, matters: [matter] }]]) PHONE_API_SCHEMAS[key].parse(data)
  await page.route(HOST + '/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname
    if (p === '/m') return route.fulfill({ contentType: 'text/html', body: mobilePhoneHtml(opts.link ? 'tLINK' : 'dDEVICE', null) })
    if (p === '/set') return route.fulfill({ contentType: 'text/html', body: pageHtml('tLINK') })
    if (p === '/bootstrap') return route.fulfill({ contentType: 'text/html', body: MOBILE_BOOTSTRAP_HTML })
    if (p === '/expired') return route.fulfill({ contentType: 'text/html', body: EXPIRED_HTML })
    if (p === '/relay') return route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('../../../relay/pset.html', import.meta.url), 'utf8') })
    if (p === '/m/icon.png') return route.fulfill({ contentType: 'image/png', body: icon })
    if (p === '/m/api/art/presence') return route.fulfill({ json: { ok: true, mime: 'image/png', unlit: art.unlit.base64, lit: art.lit.base64 } })
    if (down && p.includes('/api/')) return route.abort('connectionfailed')
    if (req.method() === 'POST') { posts.push({ path: p, body: req.postDataJSON() }); return route.fulfill({ json: p === '/set/api/pair' ? { ok: true, device_token: 'dNEW' } : p === '/set/api/apply' ? { ok: false, error: 'lan_only' } : { ok: true } }) }
    if (p === '/m/api/home') return route.fulfill({ json: home })
    if (p === '/m/api/matters') return route.fulfill({ json: { ok: true, matters: empty ? [] : [matter] } })
    if (p === '/m/api/matter') return route.fulfill({ json: detail })
    if (p === '/set/api/state') return route.fulfill({ json: state })
    return route.fulfill({ status: 404, json: { ok: false, error: 'not_found' } })
  })
  return { posts, errors, detail, home, down: () => { down = true }, up: () => { down = false }, empty: () => { empty = true } }
}
async function fits(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true) }
async function targets(page) { expect(await page.locator('button:visible').evaluateAll(buttons => buttons.every(b => b.getBoundingClientRect().height >= 44))).toBe(true) }
async function shot(page, info, name) { await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true }) }
async function openStatus(page) { await page.locator('nav [data-p="matters"]').click(); await page.locator('[data-mid="' + id + '"]').click(); await expect(page.locator('.m-state')).toHaveText('在做') }

test('normal 390px status shell, pairing, flat list and keyboard stop', async ({ page }, info) => {
  const h = await fixture(page, { link: true })
  await page.goto(HOST + '/m'); await expect(page.locator('.home-arrived')).toBeVisible()
  await expect(page.locator('#pres-txt')).toHaveText('在帮你整理出行安排'); await fits(page); await shot(page, info, 'home-390')
  await page.locator('#pairbtn').click(); await expect(page.locator('#pairbar')).toBeHidden(); expect(h.posts.filter(p => p.path === '/set/api/pair')).toHaveLength(1)
  await page.locator('nav [data-p="matters"]').click(); await expect(page.locator('[data-mid]')).toHaveCount(1); await fits(page); await shot(page, info, 'list-390')
  await expect(page.locator('nav [data-p="matters"]')).toHaveAttribute('aria-current', 'page')
  await page.locator('[data-mid]').click(); await expect(page.locator('#m-title')).not.toContainText('**'); await fits(page); await targets(page); await shot(page, info, 'status-390')
  const stop = page.locator('[data-stop]'); await stop.focus(); await page.keyboard.press('Enter'); await expect(stop).toBeFocused(); expect(h.posts.filter(p => p.path.includes('/stop'))).toHaveLength(0)
  await page.keyboard.press('Enter'); await expect(page.locator('#m-notice')).toHaveText('已经请电脑停下这一轮。'); expect(h.posts.filter(p => p.path.includes('/stop'))).toEqual([{ path: '/m/api/matter/stop', body: { id, runId: run } }])
  expect(h.errors).toEqual([])
})

test('low height: status controls reachable, unknown/offline, waiting and empty states', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 280 }); const h = await fixture(page)
  await page.goto(HOST + '/m'); await openStatus(page); await fits(page)
  const stop = page.locator('[data-stop]'); await stop.focus(); await page.keyboard.press('Enter'); await expect(stop).toBeFocused(); await expect(stop).toBeInViewport(); await shot(page, info, 'status-low')
  await page.waitForTimeout(3100); await expect(stop).toHaveText('停止这一轮'); await expect(stop).toBeFocused()
  h.detail.permissions = [{ id: 'p1', taskId: id, tool: 'Bash', description: 'private command', createdAt: 1 }]; h.detail.task.phase = 'replied'; h.detail.events = []
  await page.evaluate(() => mRefresh()); await expect(page.locator('.m-state')).toHaveText('等你决定'); await expect(stop).toHaveCount(0); await shot(page, info, 'waiting-low')
  h.home.presence = null; await page.locator('nav [data-p="today"]').click(); await page.locator('#refresh').click(); await expect(page.locator('#pres-txt')).toHaveText('不知道'); await expect(page.locator('.home-arrived')).toHaveCount(0)
  h.down(); await page.locator('#refresh').click(); await expect(page.locator('#banner')).toContainText('家里的电脑暂时连不上'); await shot(page, info, 'offline-low')
  await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await page.locator('nav [data-p="matters"]').click(); await expect(page.locator('#m-conn')).toBeVisible(); await expect(page.locator('[data-stop]:enabled')).toHaveCount(0)
  await fits(page); expect(h.errors).toEqual([])
})

test('settings normal data, long device name, keyboard, rejected switch rollback and low viewport', async ({ page }, info) => {
  const h = await fixture(page); await page.goto(HOST + '/set'); await expect(page.locator('#f-name')).toHaveValue('Nate'); await fits(page); await targets(page); await shot(page, info, 'settings-390')
  await expect(page.getByRole('button', { name: '准备失败,点此重试' })).toBeVisible();
  await expect(page.locator('#models-table')).toContainText('还没测过'); await expect(page.locator('#models-table')).toContainText('不通'); await expect(page.locator('#devices-list')).toContainText('English')
  const retry = page.getByRole('button', { name: '准备失败,点此重试' }); await retry.focus(); await expect(retry).toBeFocused(); await page.keyboard.press('Enter');
  await expect.poll(() => h.posts.length).toBe(2); expect(h.posts.map(p => p.body)).toEqual([{ op: 'set_config', key: 'companion.atelier_mode', value: 'off' }, { op: 'set_config', key: 'companion.atelier_mode', value: 'private' }]);
  await page.locator('#f-split').focus(); await page.keyboard.press('Space'); await expect(page.locator('#f-split')).toBeChecked(); expect(h.posts.at(-1)).toEqual({ path: '/set/api/apply', body: { op: 'set_pref', key: 'split', value: false } })
  await page.setViewportSize({ width: 390, height: 280 }); await page.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(page.locator('#f-autostart')).toBeVisible(); await page.locator('#f-autostart').focus(); await expect(page.locator('#f-autostart')).toBeInViewport(); await fits(page); await shot(page, info, 'settings-low')
  await page.locator('#forget-devices').scrollIntoViewIfNeeded(); page.once('dialog', d => d.dismiss()); await page.locator('#forget-devices').click(); expect(h.posts.filter(p => p.body.op === 'forget_devices')).toHaveLength(0)
  await page.evaluate(async () => { window.__CC_SHELL__ = {}; await load() }); await expect(page.locator('#f-remote')).toBeDisabled(); await expect(page.locator('#remote-hint')).toContainText('回家')
  expect(h.errors).toEqual([])
})

test('empty list, bootstrap, expired and relay incomplete-link recovery surfaces', async ({ page }, info) => {
  const h = await fixture(page); h.empty(); await page.goto(HOST + '/m'); await page.locator('nav [data-p="matters"]').click(); await expect(page.locator('#m-list')).toContainText('还没有事'); await shot(page, info, 'empty-list')
  await page.evaluate(() => localStorage.clear()); await page.setViewportSize({ width: 390, height: 280 })
  for (const [path, text] of [['bootstrap', '还没配对过'], ['expired', '已经用过或过期'], ['relay', '链接不完整']]) {
    await page.goto(HOST + '/' + path); await expect(page.locator('body')).toContainText(text); await fits(page); await shot(page, info, path + '-low')
  }
  expect(h.errors).toEqual([])
})

test('settings load failure stays unknown and retries without offering blank defaults', async ({ page }, info) => {
  const h = await fixture(page); h.down(); await page.goto(HOST + '/set')
  await expect(page.locator('#settings-status')).toContainText('设置暂时没读到')
  await expect(page.locator('#settings-fields')).toBeHidden()
  await expect(page.locator('#settings-retry')).toBeVisible()
  await shot(page, info, 'settings-unavailable')
  h.up(); await page.locator('#settings-retry').click()
  await expect(page.locator('#f-name')).toHaveValue('Nate')
  await expect(page.locator('#settings-fields')).toBeVisible()
  await expect(page.locator('#settings-status')).toBeHidden()
  await expect(page.locator('#settings-retry')).toBeHidden()
  expect(h.posts).toEqual([]); expect(h.errors).toEqual([])
})

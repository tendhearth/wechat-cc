import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { test, expect } from './fixtures'
import { placeItem, placeRow, rosterItem, routePlaces, routeRoster } from './roster-fixture'
import type { PlaceMapItemT } from '@wechat-cc/protocol'

test.use({ viewport:{width:1280,height:820} })
const now = Date.UTC(2026,10,21)
const garden = placeItem('花园',{sessionIds:['one','two'],updatedAt:now})
const empty = placeItem('空地方',{line:null,status:null,moving:false,updatedAt:null})
const items: PlaceMapItemT[] = [
  {id:'a:terminal:one',kind:'ask',status:'waiting',line:'要继续整理吗',from:{source:'terminal',sessionId:'one',at:now}},
  {id:'e:decision',kind:'decision',status:'live',line:'先整理去年的记录',body:'先按月份归档。',from:{source:'chat',at:now}},
  {id:'e:fact',kind:'fact',status:'live',line:'<img onerror=alert(1)>',from:{source:'chat',at:now}},
  {id:'s:two',kind:'session',status:'working',line:'正在核对目录',from:{source:'terminal',sessionId:'two',at:now}},
  {id:'e:result',kind:'conclusion',status:'done',line:'找到去年缺的记录',from:{source:'work',at:now}},
]
const thread = (page:Page) => page.locator('#thing-thread')
const diagram = (page:Page) => thread(page).locator('.lab-map')
const leaf = (page:Page, text:string) => diagram(page).locator('me-tpc').filter({hasText:text})
const select = (page:Page,name:string) => placeRow(page,name).locator('.place-row').click()
const view = (page:Page,name:string) => thread(page).getByRole('button',{name,exact:true})
const menu = (page:Page) => page.locator('.topbar-more summary')
const toggle = (page:Page) => page.getByRole('switch',{name:'把一件事画成图'})
const mapPath = /\/v1\/places\/map\?/
const cspPattern = /(refused|violates|Content[\s-]?Security[\s-]?Policy|CSP)/i

async function mock(page:Page, beforeMap?: (key:string, route:Route) => Promise<void>) {
  await routePlaces(page,[garden,empty])
  await routeRoster(page,['one','two'].map((id,i)=>rosterItem(id,id,{
    id, kind:'terminal',key:'terminal:'+id,group:'back',status:'replied',
    waiting:undefined,updatedAt:now-i,terminal:{sessionId:id,code:id},
  })))
  await page.route('**/v1/cli/sessions**',route=>{
    const sessions = ['one','two'].map(id=>({session_id:id,source:'codex',displayName:'Codex',status:'idle',pending:null,stale:false,project:'花园'}))
    const id = new URL(route.request().url()).searchParams.get('session_id')
    return route.fulfill({json:{ok:true,sessions:id?sessions.filter(candidate=>candidate.session_id===id):sessions}})
  })
  await page.route('**/v1/cli/activity**',route=>{
    const id = new URL(route.request().url()).searchParams.get('session_id')
    return route.fulfill({json:{ok:true,items:[{id:'reply',kind:'said',text:`${id} 的原话`,at:now}],earlier:null}})
  })
  await page.route(mapPath,async route=>{
    const key = new URL(route.request().url()).searchParams.get('key') ?? ''
    await beforeMap?.(key,route)
    const place = key === garden.key ? garden : empty
    await route.fulfill({json:{ok:true,place:{key:place.key,name:place.name},items:key===garden.key?items:[],truncated:false,revision:place.key}})
  })
}

async function enable(page:Page) {
  await menu(page).click()
  await toggle(page).click()
  await menu(page).click()
}

test.beforeEach(async ({shim})=>{ await shim.invoke('demo.seed',{daemonAlive:true}) })

test('默认不加载，开启后可看出处、跳回线，拖动节点不改图，关闭即卸载',async ({page,shimUrl})=>{
  const api: string[] = [], vendor: string[] = [], csp: string[] = []
  page.on('request', request => {
    const url = request.url()
    if (mapPath.test(url)) api.push(url)
    if (url.includes('/vendor/mind-elixir/')) vendor.push(url)
  })
  page.on('console', msg => { if (msg.type() === 'error' && cspPattern.test(msg.text())) csp.push(msg.text()) })
  page.on('pageerror', err => { if (cspPattern.test(err.message)) csp.push(err.message) })
  await mock(page)
  await page.goto(shimUrl)
  await select(page,'花园')
  const line = thread(page).locator('.thing-terminal:visible')
  await expect(line).toContainText('one 的原话')
  await line.locator('textarea').fill('线上的草稿')
  await expect(view(page,'图')).toBeHidden()
  expect(api).toHaveLength(0)
  expect(vendor).toHaveLength(0)
  await enable(page)
  await expect(view(page,'图')).toBeVisible()
  expect(api).toHaveLength(0)
  expect(vendor).toHaveLength(0)
  await view(page,'图').press('Enter')
  await expect(diagram(page).locator('me-root')).toHaveText('花园')
  await expect(diagram(page).locator('me-tpc[data-nodeid^="meg:"]')).toHaveCount(5)
  expect(api).toHaveLength(1)
  expect(vendor.some(url=>url.endsWith('/MindElixir.js'))).toBe(true)
  expect(vendor.some(url=>url.endsWith('/MindElixir.css'))).toBe(true)
  await expect(thread(page).locator('textarea:visible')).toHaveCount(0)
  await expect(leaf(page,'<img onerror=alert(1)>')).toHaveCount(1)
  await expect(diagram(page).locator('img,[onerror]')).toHaveCount(0)

  const decision = leaf(page,'先整理去年的记录')
  await decision.click()
  await expect(diagram(page).locator('.lab-map-details')).toContainText('定了的 · 决定 · 和 CC 聊的')
  await expect(diagram(page).getByText('CC 记的：先按月份归档。')).toBeVisible()
  const before = await diagram(page).locator('me-main').allTextContents()
  const middle = (await decision.boundingBox())!
  const target = (await leaf(page,'在做的').boundingBox())!
  await page.mouse.move(middle.x+middle.width/2,middle.y+middle.height/2)
  await page.mouse.down()
  await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:12})
  await page.mouse.up()
  expect(await diagram(page).locator('me-main').allTextContents()).toEqual(before)

  await leaf(page,'Codex · 正在核对目录').click()
  await expect(diagram(page).locator('.lab-map-details')).toContainText('在做的 · 会话 · 终端会话')
  await diagram(page).getByRole('button',{name:'去那条线上看 ›'}).press('Enter')
  await expect(diagram(page)).toBeHidden()
  await expect(line).toContainText('two 的原话')
  await expect(thread(page).locator('[data-thread-session="terminal:two"]')).toHaveAttribute('aria-pressed','true')
  await thread(page).locator('[data-thread-session="terminal:one"]').click()
  await expect(line.locator('textarea')).toHaveValue('线上的草稿')
  await view(page,'图').click()
  await expect(diagram(page).locator('me-root')).toBeVisible()
  await menu(page).click()
  await toggle(page).press('Space')
  await expect(toggle(page)).toHaveAttribute('aria-checked','false')
  await expect(view(page,'图')).toBeHidden()
  await expect(diagram(page).locator('.map-container')).toHaveCount(0)
  await expect(line.locator('textarea')).toHaveValue('线上的草稿')
  expect(csp).toEqual([])
})

test('换地方后丢掉迟到的图，再进原地方重读',async ({page,shimUrl})=>{
  let release = () => {}
  let requested = false
  const pending = new Promise<void>(resolve=>{release=resolve})
  await mock(page,async key=>{
    if (key === garden.key && !requested) { requested = true; await pending }
  })
  await page.goto(shimUrl)
  await select(page,'花园')
  await enable(page)
  await view(page,'图').click()
  try {
    await expect.poll(()=>requested).toBe(true)
    await select(page,'空地方')
    await view(page,'图').click()
    await expect(diagram(page)).toContainText('CC 手上还没有这件事的条目。')
    const response = page.waitForResponse(res=>mapPath.test(res.url()) && res.url().includes(encodeURIComponent(garden.key)))
    release()
    await response
    await expect(diagram(page).locator('me-root')).toHaveCount(0)
    await expect(diagram(page)).toContainText('CC 手上还没有这件事的条目。')
    await select(page,'花园')
    await expect(diagram(page).locator('me-root')).toHaveText('花园')
  } finally { release() }
})

test('截图：图、点了一条、空的',async ({page,shimUrl})=>{
  const out = join(process.env.TMPDIR ?? tmpdir(),'shots')
  await mkdir(out,{recursive:true})
  await mock(page)
  await page.goto(shimUrl)
  await select(page,'花园')
  await enable(page)
  await view(page,'图').click()
  await expect(diagram(page).locator('me-root')).toHaveText('花园')
  await page.screenshot({path:join(out,'lab-map.png')})
  await leaf(page,'先整理去年的记录').click()
  await expect(diagram(page).getByText('CC 记的：先按月份归档。')).toBeVisible()
  await page.screenshot({path:join(out,'lab-map-selected.png')})
  await select(page,'空地方')
  await view(page,'图').click()
  await expect(diagram(page)).toContainText('CC 手上还没有这件事的条目。')
  await page.screenshot({path:join(out,'lab-map-empty.png')})
})

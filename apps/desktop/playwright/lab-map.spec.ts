import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, Route, Locator } from '@playwright/test'
import { test, expect } from './fixtures'
import { placeItem, placeRow, rosterItem, routePlaces, routeRoster } from './roster-fixture'
import type { PlaceMapItemT, PlaceMapPinRequestT, PlaceMapBranchT } from '@wechat-cc/protocol'

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
// 这周没动过的地方收在名单末尾那一行里,先点开再选
const select = async (page:Page,name:string) => {
  const row = placeRow(page,name).locator('.place-row')
  if (!(await row.isVisible())) await page.locator('.desk-quiet-toggle').click()
  await row.click()
}
const view = (page:Page,name:string) => thread(page).getByRole('button',{name,exact:true})
const menu = (page:Page) => page.locator('.topbar-more summary')
const toggle = (page:Page) => page.getByRole('switch',{name:'把一件事画成图'})
const mapPath = /\/v1\/places\/map\?/
const pinPath = '**/v1/places/map/pin'
const group = (page:Page, branch:PlaceMapBranchT) => diagram(page).locator(`me-wrapper:has(> me-parent > [data-nodeid="meg:${branch}"])`)
const actions = (page:Page) => diagram(page).locator('.lab-map-details')
const cspPattern = /(refused|violates|Content[\s-]?Security[\s-]?Policy|CSP)/i

async function mock(page:Page, beforeMap?: (key:string, route:Route) => Promise<void>,
  acceptPin?: (body:PlaceMapPinRequestT) => boolean | Promise<boolean>) {
  const pins = new Map<string, PlaceMapBranchT>()
  const writes: PlaceMapPinRequestT[] = []
  let revision = 0
  await page.route(pinPath, async route => {
    const body = route.request().postDataJSON() as PlaceMapPinRequestT
    writes.push(body)
    if (acceptPin && !await acceptPin(body)) {
      await route.fulfill({status:503, json:{error:'unavailable'}})
      return
    }
    if (body.branch === null) pins.delete(body.itemId)
    else pins.set(body.itemId, body.branch)
    revision++
    await route.fulfill({json:{ok:true}})
  })
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
    await route.fulfill({json:{ok:true,place:{key:place.key,name:place.name},items:key===garden.key?items.map(item=>({...item,pin:pins.get(item.id)})):[],truncated:false,revision:`${place.key}:${revision}`}})
  })
  return writes
}

async function enable(page:Page) {
  await menu(page).click()
  await toggle(page).click()
  await menu(page).click()
}

test.beforeEach(async ({shim})=>{ await shim.invoke('demo.seed',{daemonAlive:true}) })

test('默认不加载，开启后可看出处、跳回线，可拖放并记住摆放，关闭即卸载',async ({page,shimUrl})=>{
  const api: string[] = [], vendor: string[] = [], csp: string[] = []
  page.on('request', request => {
    const url = request.url()
    if (mapPath.test(url)) api.push(url)
    if (url.includes('/vendor/mind-elixir/')) vendor.push(url)
  })
  page.on('console', msg => { if (msg.type() === 'error' && cspPattern.test(msg.text())) csp.push(msg.text()) })
  page.on('pageerror', err => { if (cspPattern.test(err.message)) csp.push(err.message) })
  const writes = await mock(page)
  await page.goto(shimUrl)
  await select(page,'花园')
  const line = thread(page).locator('.thing-terminal:visible')
  await expect(line).toContainText('one 的原话')
  await line.locator('textarea').fill('线上的草稿')
  await expect(view(page,'图')).toBeHidden()
  expect(api).toHaveLength(0)
  expect(writes).toHaveLength(0)
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
  const reread = page.waitForResponse(res => mapPath.test(res.url()))
  await drag(page, decision, leaf(page,'在做的'))
  await expect.poll(()=>writes).toEqual([{key:garden.key,itemId:'e:decision',branch:'active'}])
  await reread
  await expect(group(page,'active')).toContainText('先整理去年的记录')
  await expect(decision.locator('.tags')).toHaveText('你放的')
  await expect(actions(page)).toContainText('你放的 · 本来在「定了的」')

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
  expect(writes).toHaveLength(1)
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

test('截图：图、点了一条、拖动、你放的、空的',async ({page,shimUrl})=>{
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
  await drag(page, leaf(page,'找到去年缺的记录'), leaf(page,'没解决的'), async () => {
    await expect(leaf(page,'没解决的').locator('.insert-preview.in')).toBeVisible()
    await page.screenshot({path:join(out,'lab-map-dragging.png')})
  })
  await expect(leaf(page,'找到去年缺的记录').locator('.tags')).toHaveText('你放的')
  await page.screenshot({path:join(out,'lab-map-pinned.png')})
  await select(page,'空地方')
  await view(page,'图').click()
  await expect(diagram(page)).toContainText('CC 手上还没有这件事的条目。')
  await page.screenshot({path:join(out,'lab-map-empty.png')})
})

// 主人 2026-11-21:「先都算实验没事，慢慢我来决定」——画室、待办、觅食、后厨归到「实验」下面,照常能点开。
test('「⋯」里：设置在前，画室、待办、觅食、后厨归在「实验」下面，照常能点开',async ({page,shimUrl})=>{
  const out = join(process.env.TMPDIR ?? tmpdir(),'shots')
  await mkdir(out,{recursive:true})
  await mock(page)
  await page.goto(shimUrl)
  await menu(page).click()
  const box = page.locator('.topbar-more > div')
  const order = await box.evaluate(el => [...el.children].filter(child => !(child instanceof HTMLElement && child.hidden) && getComputedStyle(child).display !== 'none')
    .map(child => child.id === 'desk-labs-title' ? '实验' : child.classList.contains('desk-labs') ? '开关' : (child.textContent ?? '').replace(/\s+\d*$/,'').trim()))
  expect(order.slice(order.indexOf('设置'))).toEqual(['设置','实验','画室','待办','觅食','后厨','开关'])
  await expect(toggle(page)).toBeVisible()
  await page.screenshot({path:join(out,'lab-menu-wide.png')})
  await box.getByRole('button',{name:'待办'}).click()
  await expect(page.locator('body')).toHaveAttribute('data-pane','todos')

  // 窄窗口:小标题和四样都在,图的开关不出现
  await page.setViewportSize({width:760,height:820})
  await menu(page).click()
  await expect(page.locator('#desk-labs-title')).toBeVisible()
  for (const name of ['画室','待办','觅食','后厨']) await expect(box.getByRole('button',{name})).toBeVisible()
  await expect(toggle(page)).toBeHidden()
  await page.screenshot({path:join(out,'lab-menu-narrow.png')})
})


async function drag(page:Page, from:Locator, to:Locator, preview?:()=>Promise<void>) {
  const source = (await from.boundingBox())!
  const target = (await to.boundingBox())!
  await page.mouse.move(source.x+source.width/2, source.y+source.height/2)
  await page.mouse.down()
  try {
    await page.mouse.move(target.x+target.width/2, target.y+target.height/2, {steps:12})
    await preview?.()
  } finally { await page.mouse.up() }
}

async function openMap(page:Page, url:string) {
  await page.goto(url)
  await select(page,'花园')
  await enable(page)
  await view(page,'图').click()
  await expect(diagram(page).locator('me-root')).toHaveText('花园')
}

test('回包前就摆过去，失败退回；用键盘挪到，再点放回去', async ({page,shimUrl}) => {
  let release = () => {}
  const pending = new Promise<void>(resolve=>{release=resolve})
  let first = true
  const writes = await mock(page, undefined, async () => {
    if (!first) return true
    first = false
    await pending
    return false
  })
  const result = leaf(page,'找到去年缺的记录')
  await openMap(page,shimUrl)
  try {
    await drag(page,result,leaf(page,'没解决的'))
    await expect.poll(()=>writes).toEqual([{key:garden.key, itemId:'e:result', branch:'open'}])
    await expect(group(page,'open')).toContainText('找到去年缺的记录')
    await expect(result.locator('.tags')).toHaveText('你放的')
    release()
    await expect(group(page,'done')).toContainText('找到去年缺的记录')
    await expect(result.locator('.tags')).toHaveCount(0)
    await expect(diagram(page).locator('.lab-map-bar')).toContainText('没挪成，再试一次。')

    // 从图的「回到中间」开始，全程用键盘选叶子、走到操作区并提交。
    await diagram(page).getByRole('button',{name:'回到中间'}).focus()
    for (let i=0; i<5 && !await result.evaluate(el=>el===document.activeElement); i++) await page.keyboard.press('Tab')
    await expect(result).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(actions(page)).toContainText('做过的 · 结果')
    const move = actions(page).getByRole('button',{name:'没解决的',exact:true})
    for (let i=0; i<6 && !await move.evaluate(el=>el===document.activeElement); i++) await page.keyboard.press('Tab')
    await expect(move).toBeFocused()
    const reread = page.waitForResponse(res=>mapPath.test(res.url()))
    await page.keyboard.press('Enter')
    await reread
    await expect.poll(()=>writes).toHaveLength(2)
    expect(writes[1]).toEqual({key:garden.key,itemId:'e:result',branch:'open'})
    await expect(actions(page)).toContainText('你放的 · 本来在「做过的」')
    await expect(diagram(page).locator('.lab-map-write-error')).toBeEmpty()
    const restored = page.waitForResponse(res=>mapPath.test(res.url()))
    await actions(page).getByRole('button',{name:'放回去'}).click()
    await restored
    await expect.poll(()=>writes).toHaveLength(3)
    expect(writes[2]).toEqual({key:garden.key,itemId:'e:result',branch:null})
    await expect(group(page,'done')).toContainText('找到去年缺的记录')
    await expect(result.locator('.tags')).toHaveCount(0)
  } finally { release() }
})

test('等你定、分支、双击和 Delete 都不会改图，空白可平移', async ({page,shimUrl}) => {
  const writes = await mock(page)
  await openMap(page,shimUrl)
  const graph = diagram(page).locator('me-main')
  const before = await graph.allTextContents()
  const ask = leaf(page,'要继续整理吗')
  const target = leaf(page,'在做的')
  await drag(page,ask,target)
  await expect(actions(page)).toContainText('这件要你定，去那条线上答。')
  await expect(actions(page).getByText('挪到',{exact:true})).toHaveCount(0)
  await drag(page,leaf(page,'定了的'),target)
  const decision = leaf(page,'先整理去年的记录')
  await decision.dblclick()
  await decision.press('Delete')
  await expect(diagram(page).locator('[contenteditable=true],[contenteditable=plaintext-only]')).toHaveCount(0)
  expect(await graph.allTextContents()).toEqual(before)
  expect(writes).toEqual([])

  const container = diagram(page).locator('.map-container')
  const root = diagram(page).locator('me-root')
  const old = (await root.boundingBox())!
  const box = (await container.boundingBox())!
  await page.mouse.move(box.x+35,box.y+35)
  await page.mouse.down()
  await page.mouse.move(box.x+85,box.y+70,{steps:5})
  await page.mouse.up()
  await expect.poll(async ()=>(await root.boundingBox())!.x).toBeGreaterThan(old.x+10)
})

test('摆放回包迟到时，另一个地方的图不受影响', async ({page,shimUrl}) => {
  let release = () => {}
  const pending = new Promise<void>(resolve=>{release=resolve})
  const writes = await mock(page, undefined, async ()=>{ await pending; return false })
  await openMap(page,shimUrl)
  try {
    await drag(page,leaf(page,'找到去年缺的记录'),leaf(page,'没解决的'))
    await expect.poll(()=>writes).toHaveLength(1)
    await select(page,'空地方')
    await view(page,'图').click()
    await expect(diagram(page)).toContainText('CC 手上还没有这件事的条目。')
    const response = page.waitForResponse(res=>res.url().endsWith('/v1/places/map/pin'))
    release()
    await response
    await expect(diagram(page).locator('me-root')).toHaveCount(0)
    await expect(diagram(page).locator('.lab-map-write-error')).toBeEmpty()
    await select(page,'花园')
    await expect(group(page,'done')).toContainText('找到去年缺的记录')
  } finally { release() }
})

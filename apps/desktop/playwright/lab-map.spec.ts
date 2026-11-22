import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, Route, Locator } from '@playwright/test'
import { test, expect } from './fixtures'
import { placeItem, placeSession, placeRow, rosterItem, routePlaces, routeRoster } from './roster-fixture'
import type { PlaceMapItemT, PlaceMapPinRequestT, PlaceMapBranchT, PlaceOutlineT } from '@wechat-cc/protocol'

test.use({ viewport:{width:1280,height:820} })
const now = Date.UTC(2026,10,21)
const garden = placeItem('花园',{sessionIds:['one','two'],updatedAt:now,sessions:[placeSession('one','replied',now),placeSession('two','replied',now-1)]})
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
const toggle = (page:Page) => page.getByRole('switch',{name:'把一件事画成图',includeHidden:true})
const mapPath = /\/v1\/places\/map\?/
const pinPath = '**/v1/places/map/pin'
const group = (page:Page, branch:PlaceMapBranchT) => diagram(page).locator(`me-wrapper:has(> me-parent > [data-nodeid="meg:${branch}"])`)
const actions = (page:Page) => diagram(page).locator('.lab-map-details')
const statusChip = (page:Page) => actions(page).locator('.lab-map-chip')
const cspPattern = /(refused|violates|Content[\s-]?Security[\s-]?Policy|CSP)/i

async function mock(page:Page, beforeMap?: (key:string, route:Route) => Promise<void>,
  acceptPin?: (body:PlaceMapPinRequestT) => boolean | Promise<boolean>, initialPlaceMap = true) {
  let placeMap = initialPlaceMap
  await page.route('**/v1/labs', async route => {
    placeMap = route.request().postDataJSON().placeMap
    await route.fulfill({ json: { ok: true, placeMap } })
  })
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
  await routePlaces(page,[garden,empty],{ placeMap: () => placeMap })
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
  await expect(menu(page).locator('..')).not.toHaveAttribute('open','')
  await expect(toggle(page)).toHaveAttribute('aria-checked','true')
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
  const writes = await mock(page, undefined, undefined, false)
  await page.goto(shimUrl)
  await select(page,'花园')
  const line = thread(page).locator('.thing-terminal:visible')
  await expect(line).toContainText('one 的原话')
  await line.locator('textarea').fill('线上的草稿')
  await expect(view(page,'图')).toBeHidden()
  expect(api).toHaveLength(0)
  expect(writes).toHaveLength(0)
  expect(vendor).toHaveLength(0)
  const enabled = page.waitForRequest(req => req.url().endsWith('/v1/labs'))
  await enable(page)
  expect((await enabled).method()).toBe('POST')
  expect((await enabled).postDataJSON()).toEqual({ placeMap: true })
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

  await expect(actions(page)).toBeHidden()
  await expect(diagram(page).locator('.lab-map-hint')).toHaveText('点一条看它的出处；拖到另一支上就是挪过去')
  await expect(view(page,'回到中间')).toHaveAttribute('aria-label','回到中间')
  await expect(view(page,'回到中间')).toHaveText('')
  await expect(leaf(page,'在做的')).toHaveCSS('padding','6px 10px')
  await expect(diagram(page).locator('svg.lines path').first()).toHaveCSS('stroke-width','1.75px')
  await expect(diagram(page).locator('svg.subLines path').first()).toHaveCSS('stroke-width','1.25px')
  const decision = leaf(page,'先整理去年的记录')
  await decision.click()
  await expect(diagram(page).locator('.lab-map-hint')).toBeHidden()
  const viewport = (await diagram(page).locator('.lab-map-viewport').boundingBox())!
  const card = (await actions(page).boundingBox())!
  expect(viewport.y + viewport.height).toBeLessThan(card.y)
  await expect(statusChip(page)).toHaveText('定了的')
  await expect(actions(page)).toContainText('决定，和 CC 聊的，')
  await expect(diagram(page).getByText('CC 记的：先按月份归档。')).toBeVisible()
  const reread = page.waitForResponse(res => mapPath.test(res.url()))
  await drag(page, decision, leaf(page,'在做的'))
  await expect.poll(()=>writes).toEqual([{key:garden.key,itemId:'e:decision',branch:'active'}])
  await reread
  await expect(group(page,'active')).toContainText('先整理去年的记录')
  await expect(decision.locator('.tags')).toHaveText('你放的')
  await expect(statusChip(page)).toHaveText('在做的')
  await expect(actions(page)).toContainText('；你放到这儿的，本来在「定了的」')

  await leaf(page,'Codex · 正在核对目录').click()
  await expect(statusChip(page)).toHaveText('在做的')
  await expect(actions(page)).toContainText('会话，终端会话，')
  await diagram(page).getByRole('button',{name:'去线上看'}).press('Enter')
  await expect(diagram(page)).toBeHidden()
  await expect(line).toContainText('two 的原话')
  await expect(thread(page).locator('[data-thread-session="terminal:two"]')).toHaveAttribute('aria-pressed','true')
  await thread(page).locator('[data-thread-session="terminal:one"]').click()
  await expect(line.locator('textarea')).toHaveValue('线上的草稿')
  await view(page,'图').click()
  await expect(diagram(page).locator('me-root')).toBeVisible()
  await menu(page).click()
  const disabled = page.waitForRequest(req => req.url().endsWith('/v1/labs'))
  await toggle(page).press('Space')
  expect((await disabled).postDataJSON()).toEqual({ placeMap: false })
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
    await expect(statusChip(page)).toHaveText('做过的')
    await expect(actions(page)).toContainText('结果，交办的活，')
    const move = actions(page).getByRole('button',{name:'没解决的',exact:true})
    for (let i=0; i<6 && !await move.evaluate(el=>el===document.activeElement); i++) await page.keyboard.press('Tab')
    await expect(move).toBeFocused()
    const reread = page.waitForResponse(res=>mapPath.test(res.url()))
    await page.keyboard.press('Enter')
    await reread
    await expect.poll(()=>writes).toHaveLength(2)
    expect(writes[1]).toEqual({key:garden.key,itemId:'e:result',branch:'open'})
    await expect(statusChip(page)).toHaveText('没解决的')
    await expect(actions(page)).toContainText('；你放到这儿的，本来在「做过的」')
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

test('地方读回的开关决定图入口，写失败保持原值并在开关行提示', async ({page,shimUrl}) => {
  const writes = await mock(page)
  await page.route('**/v1/labs', route => route.fulfill({ status:503, json:{error:'unavailable'} }))
  await page.goto(shimUrl)
  await select(page,'花园')
  await expect(view(page,'图')).toBeVisible()
  await menu(page).click()
  await expect(toggle(page)).toHaveAttribute('aria-checked','true')
  await expect(page.locator('#desk-lab-map-note')).toHaveText('还在试。关掉就没有，不影响别的。开着时，你在图上摆过的，CC 说话和终端里的 agent 开场时会知道。')
  await toggle(page).click()
  await expect(menu(page).locator('..')).not.toHaveAttribute('open','')
  await menu(page).click()
  await expect(page.locator('#desk-lab-map-note')).toBeVisible()
  await expect(page.locator('#desk-lab-map-note')).toHaveText('没改成，再试一次。')
  await expect(toggle(page)).toHaveAttribute('aria-checked','true')
  await expect(view(page,'图')).toBeVisible()
  expect(writes).toHaveLength(0)
})

for (const inRoster of [true, false]) {
  test(`按方面能打开三十项以外的出处（名单里有：${inRoster}）`, async ({page,shimUrl}) => {
    await mock(page)
    const sessions = Array.from({length:30}, (_, i) => placeSession(`recent-${i}`, 'replied', now - i))
    await routePlaces(page,[{...garden,sessions,sessionIds:[...sessions.map(s=>s.sessionId),'two']}],{placeMap:()=>true})
    if (!inRoster) await routeRoster(page,[])
    const outline: PlaceOutlineT = {state:'ready',canRun:true,aspects:[
      {name:'整理目录',items:[{id:'o:0',line:'先按月份整理',status:'decided',sources:[{kind:'session',sessionId:'two',agent:'Codex',at:now}]}]},
    ]}
    await page.route(/\/v1\/places\/map\?.*&outline=1$/, route => route.fulfill({json:{
      ok:true,place:{key:garden.key,name:garden.name},items,truncated:false,revision:'outside-tabs',outline,
    }}))
    await page.goto(shimUrl)
    await select(page,'花园')
    const visibleTabs = thread(page).locator('.thing-sessions > [data-thread-session]')
    await expect(visibleTabs.first()).toBeVisible()
    const count = await visibleTabs.count()
    expect(count).toBeGreaterThan(1)
    await expect(thread(page).locator('[data-thread-session="terminal:two"]')).toHaveCount(0)
    await view(page,'图').click()
    await view(page,'按方面').click()
    await leaf(page,'先按月份整理').click()
    await view(page,'去线上看').click()
    await expect(visibleTabs).toHaveCount(count)
    await expect(visibleTabs.last()).toHaveAttribute('data-thread-session','terminal:two')
    await expect(visibleTabs.last()).toHaveAttribute('aria-pressed','true')
    await expect(thread(page).locator('.thing-terminal:visible')).toContainText('two 的原话')
  })
}

test('按方面需要点一下，梳理后看多处出处，回到准确的会话', async ({page,shimUrl}) => {
  const out = join(process.env.TMPDIR ?? tmpdir(),'shots')
  await mkdir(out,{recursive:true})
  const writes = await mock(page, undefined, undefined, false)
  const requests: string[] = []
  let starts = 0
  let outline: PlaceOutlineT = {state:'none',canRun:true}
  const aspects: NonNullable<PlaceOutlineT['aspects']> = [
    {name:'整理目录', items:[{id:'o:0',line:'先按月份整理',status:'decided',sources:[
      {kind:'session',sessionId:'two',agent:'Codex',at:now}, {kind:'entry'}, {kind:'session',sessionId:'gone',agent:'Claude Code',at:now},
    ]}]},
    {name:'补缺', items:[{id:'o:1',line:'补去年缺的记录',status:'active',sources:[{kind:'entry'}]}]},
    {name:'保留', items:[{id:'o:2',line:'原文件还留着',status:'noted',sources:[{kind:'entry'}]}]},
  ]
  page.on('request', request => { if (mapPath.test(request.url())) requests.push(request.url()) })
  await page.route(/\/v1\/places\/map\?.*&outline=1$/, route => route.fulfill({json:{
    ok:true,place:{key:garden.key,name:garden.name},items,truncated:false,revision:'same-status',outline,
  }}))
  await page.route('**/v1/places/map/outline', async route => {
    starts++
    expect(route.request().postDataJSON()).toEqual({key:garden.key})
    outline = {state:'running',canRun:false}
    await route.fulfill({json:{ok:true,state:'running'}})
  })

  await page.goto(shimUrl)
  await select(page,'花园')
  await expect(view(page,'图')).toBeHidden()
  expect(requests).toHaveLength(0)
  await enable(page)
  await view(page,'图').click()
  await expect(diagram(page).locator('me-root')).toHaveText('花园')
  expect(requests.some(url=>url.includes('outline=1'))).toBe(false)
  await view(page,'按方面').click()
  const begin = view(page,'让 CC 梳理一下')
  await expect(diagram(page)).toContainText('CC 还没梳理过这件事。')
  await expect(diagram(page).locator('me-root')).toHaveCount(0)
  expect(starts).toBe(0)
  await page.screenshot({path:join(out,'lab-outline-none.png')})
  const runningRead = page.waitForResponse(res=>res.url().includes('outline=1'))
  await begin.click()
  await runningRead
  await expect(diagram(page)).toContainText('CC 在梳理…')
  expect(starts).toBe(1)
  outline = {state:'ready',at:now,canRun:false,aspects}
  await expect(diagram(page).locator('me-root')).toHaveText('花园',{timeout:5500})
  await expect(diagram(page).locator('me-tpc[data-nodeid^="meg:aspect-"]')).toHaveCount(3)
  await expect(leaf(page,'先按月份整理')).toHaveAttribute('data-outline-status','decided')
  await page.screenshot({path:join(out,'lab-outline-ready.png')})
  await leaf(page,'先按月份整理').click()
  await expect(statusChip(page)).toHaveText('定了的')
  await expect(actions(page)).toContainText('CC 梳理的，出自 Codex 的会话，')
  await expect(actions(page)).toContainText('出自 CC 记下的一条')
  await expect(actions(page)).toContainText('那次会话已经翻不到了')
  await page.screenshot({path:join(out,'lab-outline-selected.png')})

  const branchesBefore = await diagram(page).locator('me-main').allTextContents()
  await drag(page,leaf(page,'先按月份整理'),leaf(page,'补缺'))
  await expect(diagram(page).locator('[data-map-pin]')).toHaveCount(0)
  expect(await diagram(page).locator('me-main').allTextContents()).toEqual(branchesBefore)
  expect(writes).toEqual([])
  // Read-only drag pans the viewport. Center again before exercising the source link.
  await view(page,'回到中间').click()
  await leaf(page,'先按月份整理').click()
  await view(page,'去线上看').click()
  await expect(thread(page).locator('[data-thread-session="terminal:two"]')).toHaveAttribute('aria-pressed','true')
  await expect(thread(page).locator('.thing-terminal:visible')).toContainText('two 的原话')

  outline = { ...outline, stale:true, canRun:true }
  await view(page,'图').click()
  await expect(view(page,'按方面')).toHaveAttribute('aria-pressed','true')
  await expect(view(page,'重新梳理')).toBeVisible()
  const show = async (next: PlaceOutlineT) => {
    await view(page,'按状态').click()
    await expect(diagram(page).locator('me-tpc[data-nodeid^="meg:"]')).toHaveCount(5)
    outline = next
    await view(page,'按方面').click()
  }
  await show({...outline,canRun:false})
  await expect(diagram(page)).toContainText('今天梳理过了。')
  await expect(view(page,'重新梳理')).toHaveCount(0)
  await show({state:'failed',canRun:false,error:'bad_output'})
  await expect(diagram(page)).toContainText('这次没梳理出来。')
  await expect(diagram(page)).toContainText('今天试过几次都没成，明天再试。')
  await show({state:'failed',canRun:true,error:'no_private_model'})
  await expect(diagram(page)).toContainText('现在没有可用的私密模型。')
  await show({state:'failed',canRun:true,error:'unavailable'})
  await expect(view(page,'再试一次')).toBeVisible()
  await show({state:'empty',canRun:false})
  await expect(diagram(page)).toContainText('材料太少，CC 没分出几块。')

  await menu(page).click()
  await toggle(page).click()
  await expect(view(page,'图')).toBeHidden()
  const count = requests.length
  await page.reload()
  await select(page,'花园')
  await expect(view(page,'图')).toBeHidden()
  expect(requests).toHaveLength(count)
  expect(starts).toBe(1)
})

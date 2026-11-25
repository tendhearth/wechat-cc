import {askingPlace,routePlaces,routeRoster,rosterItem} from './roster-fixture'
import { join } from 'node:path'
import { test, expect, clickNav, WORKBENCH_ROUTES } from './fixtures'

const site = { id:'site-store-id', name:'作品集', path:'/demo/site', providerId:'claude' }
const notes = { id:'notes-store-id', name:'访谈笔记', path:'/demo/notes', providerId:'codex' }
const quiet = { id:'quiet-store-id', name:'报告', path:'/demo/quiet', providerId:'codex' }
const empty = { id:'empty-store-id', name:'新项目', path:'/demo/empty', providerId:'claude' }
const projects = [site, notes, quiet, empty]
const catalogIds = ['p-11111111111111111111','p-22222222222222222222','p-33333333333333333333','p-44444444444444444444']
const features = {executionSettings:false, modelCatalog:false}
const providers = [
  {id:'claude', displayName:'Claude Code', available:true, capabilities:{features}},
  {id:'codex', displayName:'Codex', available:true, capabilities:{features}},
]
const now = Date.now()
const task = (id:string, title:string, project:typeof site, status:string, extra = {}) => ({
  id, title, path:project.path, providerId:project.providerId, status, createdAt:now-3600000, updatedAt:now,
  error:null, archivedAt:null, canArchive:status==='completed', ...extra,
})
const tasks = [
  task('deadbeef','完善作品集在手机上的排版',site,'running',{pendingPermissionCount:1}),
  task('cafefeed','整理访谈主题与引用',notes,'running'),
  task('f00dbeef','补充作品集说明文案',site,'completed',{phase:'replied'}),
  task('aabbccdd','检查上周的报告',quiet,'completed',{phase:'replied'}),
]

async function setup(page:any, shimUrl:string, shim:any) {
  await routeRoster(page,[rosterItem('deadbeef','完善作品集在手机上的排版'),rosterItem('cafefeed','整理访谈主题与引用')])
  await shim.invoke('demo.seed',{chat_id:'test_chat',daemonAlive:true})
  await page.route(WORKBENCH_ROUTES, async (route:any) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json:any = {}
    if(path==='/v1/workbench') json = {tasks,projects,providers,defaultProvider:'claude',historyProviders:['claude','codex'],canWechat:false,page:{limit:100,total:4,hasMore:false,nextCursor:null}}
    else if(path==='/v1/workbench/task') {
      const current = tasks.find(t=>t.id===url.searchParams.get('id'))!
      json = {task:current,events:[
        {id:'1',taskId:current.id,kind:'user',text:'检查页面在手机上的排版，让文字和图片更容易阅读。',createdAt:now-60000},
        {id:'2',taskId:current.id,kind:'text',text:current.id==='deadbeef'?'已检查页面。我想运行本地测试，确认布局调整没有影响其他页面。':'这一轮的内容已经整理好了，可以继续补充要求。',createdAt:now-30000},
      ],artifacts:[],permissions:current.id==='deadbeef'?[{id:'permission-1',taskId:current.id,tool:'Bash',description:'运行本地测试：bun run test',createdAt:now-20000}]:[]}
    } else if(path==='/v1/workbench/attention') json={tasks:[]}
    else if(path==='/v1/matter/changes') json={reviews:[]}
    else if(path==='/v1/workbench/entry-options') json={status:'ready',defaultProviderId:'claude',providers,projects:projects.map((p,i)=>({...p,id:catalogIds[i]}))}
    await route.fulfill({json})
  })
  await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>document.documentElement.dataset.mode && document.documentElement.dataset.mode!=='loading')
  await page.evaluate(()=>{document.documentElement.dataset.mode='dashboard'})
  await clickNav(page,'workbench')
  await expect(page.locator('.workbench-pane [data-task-id="deadbeef"]')).toBeVisible()
  await expect(page.locator('#wb-filter-project')).toBeVisible()
}

test('conversation search prioritizes decisions, filters projects and focuses the original permission action',async({page,shimUrl,shim})=>{
  await page.setViewportSize({width:1440,height:900})
  await setup(page,shimUrl,shim)
  await expect(page.locator('.wb-attention-list [data-task-id="deadbeef"]')).toHaveCount(1)
  await expect(page.locator('.workbench-pane [data-task-id="deadbeef"]')).toHaveCount(1)
  await expect(page.locator('[data-action="add-project"]')).toBeHidden()
  await page.locator('#wb-list-more summary').click()
  await expect(page.locator('[data-action="add-project"]')).toBeVisible()
  await expect(page.getByRole('button',{name:'导入已有会话',exact:true})).toBeVisible()
  await page.locator('#wb-list-more summary').click()
  await page.locator('#wb-filter-project').selectOption('/demo/quiet')
  await expect(page.locator('.wb-task[data-task-id="aabbccdd"]')).toBeVisible()
  await expect(page.locator('.wb-task[data-task-id="f00dbeef"]')).toHaveCount(0)
  await page.locator('#wb-filter-project').selectOption('')
  await page.locator('#wb-search').fill('报告')
  await expect(page.locator('#wb-search')).toHaveValue('报告')
  await page.locator('#wb-search').press('Escape')
  await expect(page.locator('#wb-search')).toHaveValue('')
  await page.locator('.workbench-pane [data-task-id="f00dbeef"]').click()
  await expect(page.locator('.wb-task-head h2')).toHaveText('补充作品集说明文案')
  await expect(page.locator('.wb-sidebar')).toBeHidden()
  await clickNav(page,'workbench')
  await page.locator('.workbench-pane [data-task-id="deadbeef"]').click()
  await page.locator('[data-action="show-decisions"]').click()
  await expect(page.locator('[data-action="deny-permission"]')).toBeFocused()
  const screenshotDir = process.env.WECHAT_CC_DESIGN_SHOTS
  if(screenshotDir) { await page.waitForTimeout(700); await page.screenshot({path:join(screenshotDir,'workbench-wide.png')}) }
})

test('project delegation uses the shared dialog, inherits the project executor, and keeps a cancelled draft',async({page,shimUrl,shim})=>{
  await setup(page,shimUrl,shim)
  await page.getByRole('button',{name:'在 访谈笔记 交办',exact:true}).click()
  const dialog = page.getByRole('dialog',{name:'交给 CC 做',exact:true})
  await expect(dialog.locator('.task-entry-destination')).toHaveText('项目：访谈笔记')
  await expect(dialog.locator('[name="project"]')).toHaveValue(catalogIds[1])
  await expect(dialog.locator('[name="provider"]')).toHaveValue('codex')
  await dialog.locator('[name="text"]').fill('把摘要再缩短一点')
  await dialog.getByRole('button',{name:'取消',exact:true}).click()
  await page.getByRole('button',{name:'在 作品集 交办',exact:true}).click()
  await expect(dialog.locator('[name="text"]')).toHaveValue('把摘要再缩短一点')
  await expect(dialog.locator('.task-entry-destination')).toHaveText('项目：作品集')
  await expect(dialog.locator('[name="provider"]')).toHaveValue('claude')
  await dialog.getByRole('button',{name:'取消',exact:true}).click()
})

test('workbench stays readable at a narrow desktop width with no horizontal overflow',async({page,shimUrl,shim})=>{
  await page.setViewportSize({width:900,height:1100})
  await setup(page,shimUrl,shim)
  await expect(page.locator('#wb-search')).toBeVisible()
  await page.locator('.workbench-pane [data-task-id="deadbeef"]').click()
  await expect(page.locator('.wb-permissions')).toBeVisible()
  const overflow = await page.locator('.workbench-shell').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth+1)
  expect(overflow).toBe(false)
  const screenshotDir = process.env.WECHAT_CC_DESIGN_SHOTS
  if(screenshotDir) { await page.waitForTimeout(700); await page.screenshot({path:join(screenshotDir,'workbench-narrow.png')}) }
})

test('conversation layers preserve the global navigation and restore the conversation at every width',async({page,shimUrl,shim})=>{
  await page.setViewportSize({width:1440,height:900})
  await setup(page,shimUrl,shim)
  await expect(page.locator('#dash-global-rail')).toBeVisible()
  await expect(page.locator('#topbar-search')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('button.dash-nav-link[data-pane="overview"]')).not.toHaveClass(/active/)
  await expect(page.locator('.cc-now-pane')).toBeHidden()
  await expect(page.locator('#workbench-nav-toggle')).toHaveCount(0)
  await expect(page.locator('#dash-global-rail')).toBeVisible()
  await expect(page.locator('.wb-chats')).toHaveCount(0)
  await page.setViewportSize({width:1000,height:900})
  await expect(page.locator('#workbench-nav-toggle')).toHaveCount(0)
  await expect(page.locator('#dash-global-rail')).toBeVisible()
  await expect(page.locator('#workbench-home')).toBeHidden()
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('inert','')
  await expect(page.locator('#dash-global-rail')).not.toHaveAttribute('aria-hidden','true')
  await expect(page.locator('button.dash-nav-link[data-pane="overview"]')).toBeVisible()
  await page.setViewportSize({width:760,height:844})
  await expect(page.locator('#workbench-home')).toBeHidden()
  await expect(page.locator('#dash-global-rail')).toBeHidden()
  const narrowSearch = page.locator('#conversation-matter-layer[data-workbench-view="search"]')
  await expect(narrowSearch.locator('#wb-filter-project')).toHaveCSS('appearance', 'none')
  await expect(narrowSearch.locator('#wb-filter-status')).toHaveCSS('appearance', 'none')
  await expect(narrowSearch).toHaveAttribute('role', 'region')
  await page.keyboard.press('Escape')
  await expect(page.locator('article.dash-pane[data-pane="overview"]')).toBeVisible()
  await expect(page.locator('.cc-now-pane')).not.toHaveAttribute('inert')
})

test('waiting stays visible on the topbar CC while navigating to other panes',async({page,shimUrl,shim})=>{
  await page.setViewportSize({ width: 900, height: 820 })
  await routePlaces(page,[askingPlace('portfolio','deadbeef','Bash: bun run test'),askingPlace('interviews','cafefeed','要保留原话吗？')])
  await shim.invoke('demo.seed',{chat_id:'test_chat',daemonAlive:true})
  await page.route('**/v1/workbench/attention',route=>route.fulfill({json:{tasks:[
    {id:'deadbeef',title:'完善作品集在手机上的排版',providerId:'claude',pendingPermissionCount:1,pendingQuestionCount:0,attentionKey:JSON.stringify(['permission-1']),first:{kind:'permission',text:'Bash: bun run test'}},
    {id:'cafefeed',title:'整理访谈主题与引用',providerId:'codex',pendingPermissionCount:0,pendingQuestionCount:1,attentionKey:JSON.stringify(['question-1']),first:{kind:'question',text:'要保留原话吗？'}},
  ]}}))
  await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>document.documentElement.dataset.mode && document.documentElement.dataset.mode!=='loading')
  await page.evaluate(()=>{document.documentElement.dataset.mode='dashboard'})
  await expect(page.locator('#places-root .place[data-waiting="true"]')).toHaveCount(2)
  const dot = page.locator('#topbar-cc .topbar-waiting-dot')
  await expect(dot).toBeVisible()
  await expect(page.locator('#topbar-cc')).toHaveAttribute('aria-label','跟 CC 说(有 2 件在等你)')
  await expect(page.locator('#workbench-attention')).toHaveCount(0)
  await clickNav(page,'recollections')
  await expect(page.locator('#topbar-cc')).toHaveAttribute('data-waiting','2')
  await expect(page.locator('#topbar-cc')).toHaveAttribute('aria-label','跟 CC 说(有 2 件在等你)')
  await expect(dot).toBeVisible()
  const [avatar, badge] = await Promise.all([
    page.locator('#topbar-cc .topbar-figure').boundingBox(), dot.boundingBox(),
  ])
  expect(badge!.x).toBeGreaterThan(avatar!.x + avatar!.width / 2)
  expect(badge!.x + badge!.width).toBeLessThanOrEqual(avatar!.x + avatar!.width)
  expect(badge!.y).toBeLessThan(avatar!.y + avatar!.height / 2)
  await clickNav(page,'overview')
  await expect(dot).toBeVisible()
})

test('宽窗搜索占整张纸，快捷键聚焦并返回原页，组字时不触发', async ({ page, shimUrl, shim }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, shimUrl, shim)
  await clickNav(page, 'memory')
  const mac = await page.locator('html').getAttribute('data-platform') === 'macos'
  const shortcut = mac ? 'Meta+k' : 'Control+k'
  const search = page.getByRole('region', { name: '搜索', exact: true })
  const memory = page.locator('.dash-pane[data-pane="memory"]')
  await expect(page.locator('#desk-search-shortcut')).toHaveText(mac ? '⌘K' : 'Ctrl K')
  await page.locator('#memory-facts-search').dispatchEvent('keydown', {
    key: 'k', metaKey: mac, ctrlKey: !mac, isComposing: true, bubbles: true,
  })
  await expect(memory).toBeVisible()
  await expect(search).toBeHidden()

  await page.keyboard.press(shortcut)
  await expect(search).toBeVisible()
  await expect(search.getByRole('heading', { name: '搜索', exact: true })).toBeVisible()
  await expect(search.locator('#wb-search')).toBeFocused()
  await expect(search.locator('.wb-search')).toHaveCSS('height', '40px')
  await expect(page.locator('.dash-main')).toHaveCSS('background-color', 'rgb(253, 251, 247)')
  for (const layer of [search, search.locator('.workbench-shell'), search.locator('.wb-sidebar')]) {
    await expect(layer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }
  await expect(search.locator('#wb-search')).toHaveCSS('outline-style', 'none')
  await expect(search.locator('.wb-search')).toHaveCSS('border-top-color', 'rgb(79, 107, 79)')
  await expect(search.locator('.wb-search')).not.toHaveCSS('box-shadow', 'none')
  await expect(search.locator('#workbench-home')).toBeHidden()
  await expect(page.locator('.cc-now-pane')).toBeHidden()
  const [paper, pane, form, project, status] = await Promise.all([
    page.locator('.dash-main'), search, search.locator('.wb-search'),
    search.locator('#wb-filter-project'), search.locator('#wb-filter-status'),
  ].map(locator => locator.boundingBox()))
  expect(pane).toEqual(paper)
  expect(form!.width).toBeCloseTo(712, 0)
  expect(form!.y + form!.height).toBeLessThan(project!.y)
  expect(project!.y).toBe(status!.y)

  await page.keyboard.press(shortcut)
  await expect(memory).toBeVisible()
  await expect(search).toBeHidden()
  await page.keyboard.press(shortcut)
  await expect(search.locator('#wb-search')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(memory).toBeVisible()
})

import { join } from 'node:path'
import { test, expect, clickNav } from './fixtures'

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
  await shim.invoke('demo.seed',{chat_id:'test_chat',daemonAlive:true})
  await page.route('**/v1/workbench**', async (route:any) => {
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
    else if(path==='/v1/workbench/review') json={reviews:[]}
    else if(path==='/v1/workbench/entry-options') json={status:'ready',defaultProviderId:'claude',providers,projects:projects.map((p,i)=>({...p,id:catalogIds[i]}))}
    await route.fulfill({json})
  })
  await page.goto(shimUrl)
  await page.waitForFunction(()=>document.documentElement.dataset.mode && document.documentElement.dataset.mode!=='loading')
  await page.evaluate(()=>{document.documentElement.dataset.mode='dashboard'})
  await clickNav(page,'workbench')
  await expect(page.locator('[data-task-id="deadbeef"]')).toBeVisible()
  await expect(page.locator('.wb-task-head h2')).toHaveText('完善作品集在手机上的排版')
}

test('workbench prioritizes decisions, keeps project folds across navigation, and focuses the permission action',async({page,shimUrl,shim})=>{
  await page.setViewportSize({width:1440,height:900})
  await setup(page,shimUrl,shim)
  await expect(page.locator('.wb-attention-list [data-task-id="deadbeef"]')).toHaveCount(1)
  await expect(page.locator('[data-task-id="deadbeef"]')).toHaveCount(1)
  await expect(page.locator('[data-action="add-project"]')).toBeHidden()
  await page.locator('#wb-list-more summary').click()
  await expect(page.locator('[data-action="add-project"]')).toBeVisible()
  await expect(page.getByRole('button',{name:'导入已有会话',exact:true})).toBeVisible()
  await page.locator('#wb-list-more summary').click()
  const report = page.locator('.wb-project').filter({has:page.locator('summary h3', {hasText:'报告'})}).locator('details')
  await expect(report).not.toHaveAttribute('open')
  await page.locator('#wb-search').fill('报告')
  await page.locator('#wb-search').press('Enter')
  await expect(report).toHaveAttribute('open','')
  await page.locator('[data-action="clear-search"]').click()
  await expect(report).not.toHaveAttribute('open')
  await report.locator('summary').click()
  await page.locator('[data-task-id="f00dbeef"]').click()
  await expect(page.locator('.wb-task-head h2')).toHaveText('补充作品集说明文案')
  await expect(report).toHaveAttribute('open','')
  await page.locator('[data-task-id="deadbeef"]').click()
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
  await page.setViewportSize({width:760,height:1100})
  await setup(page,shimUrl,shim)
  await expect(page.locator('.wb-delegate')).toBeVisible()
  await expect(page.locator('.wb-permissions')).toBeVisible()
  const overflow = await page.locator('.workbench-shell').evaluate((el:HTMLElement)=>el.scrollWidth>el.clientWidth+1)
  expect(overflow).toBe(false)
  const screenshotDir = process.env.WECHAT_CC_DESIGN_SHOTS
  if(screenshotDir) { await page.waitForTimeout(700); await page.screenshot({path:join(screenshotDir,'workbench-narrow.png')}) }
})

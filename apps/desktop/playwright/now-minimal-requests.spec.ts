import {join} from 'node:path'
import {test,expect,clickNav,WORKBENCH_ROUTES} from './fixtures'
import {rosterItem,showRoster} from './roster-fixture'
const task={id:'deadbeef',title:'作品集',path:'/demo/portfolio',providerId:'claude',status:'running',createdAt:1,updatedAt:2,error:null,archivedAt:null,pendingPermissionCount:1,pendingQuestionCount:0}
for(const width of [1440,900])test(`roster keeps request purpose, keyboard destination and stale reads at ${width}`,async({page,shim,shimUrl})=>{
 await page.setViewportSize({width,height:900})
 await shim.invoke('demo.seed',{daemonAlive:true})
 let unreadable=false
 const items=[rosterItem(task.id,task.title,{waiting:{kind:'permission',requestId:'p1',summary:'Bash: bun run test',count:1}}),rosterItem('terminal-1','演示项目',{key:'terminal:terminal-1',kind:'terminal',terminal:{sessionId:'terminal-1',code:'demo'}})]
 await page.route('**/v1/roster',route=>unreadable?route.fulfill({status:503,json:{error:'unavailable'}}):route.fulfill({json:{items,version:'two'}}))
 await page.route(WORKBENCH_ROUTES,route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/v1/workbench/task')return route.fulfill({json:{task,events:[{id:1,taskId:task.id,kind:'text',text:'想运行测试，确认排版。',createdAt:2}],artifacts:[],questions:[],permissions:[{id:'p1',taskId:task.id,tool:'Bash',description:'bun run test',createdAt:2}]}})
  if(path==='/v1/workbench/attention')return route.fulfill({json:{tasks:[{...task,attentionKey:'["p1"]',first:{kind:'permission',text:'Bash: bun run test'}}]}})
  if(path==='/v1/workbench')return route.fulfill({json:{tasks:[task],projects:[],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false}})
  return route.fulfill({json:{reviews:[]}})
 })
 await page.route('**/v1/matter?id=*',route=>route.fulfill({json:{matter:{...task,kind:'task'}}}))
 await page.route('**/v1/cli/sessions*',route=>route.fulfill({json:{sessions:[{session_id:'terminal-1',source:'codex',status:'waiting',live_window:true,last_summary:'git status',pending:{actionable:true,tool:'Bash',summary:'git status',hash:'k3x9z'}}]}}))
 await page.route('**/v1/cli/activity*',route=>route.fulfill({json:{items:[{text:'终端原话'}]}}))
 await page.goto(shimUrl);await showRoster(page)
 await expect(page.locator('#now-waiting')).toHaveCount(0)
 await expect(page.locator('#roster-list [data-group="waiting"] h2')).toHaveText('等你 2')
 const row=page.locator('[data-roster-key="matter:deadbeef"]')
 await expect(row).toContainText('Bash: bun run test')
 await row.press('Enter')
 await expect(page.locator('#conversation-matter-layer')).toBeVisible()
 const heading = width >= 1080 ? '.roster-direct-heading h2' : '.wb-task-head h2'
 await expect(page.locator(`#conversation-matter-layer ${heading}`)).toHaveText('作品集')
 await expect(page.locator('.wb-permissions')).toContainText('bun run test')
 await expect(page.locator('.workbench-pane')).toContainText('想运行测试，确认排版。')
 if(width>=1080)await page.locator('#roster-dock').getByRole('button',{name:'‹ 在做',exact:true}).click()
 else await page.locator('#workbench-home').click()
 unreadable=true;await showRoster(page)
 await expect(page.locator('#roster-list')).toContainText('家里的电脑暂时连不上',{timeout:12000})
 await expect(page.locator('#roster-list')).toContainText('你看到的是')
 await expect(row).toContainText('Bash: bun run test')
 await page.locator('[data-roster-key="terminal:terminal-1"]').click()
 const detail=width>=1080?page.locator('#roster-dock'):page.locator('dialog.wb-history-dialog')
 await expect(detail).toContainText('git status')
 await expect(detail).toContainText('终端原话')
 await expect(detail.getByRole('button',{name:'允许',exact:true})).toBeVisible()
 const out=process.env.WECHAT_CC_DESIGN_SHOTS
 if(out)await page.screenshot({path:join(out,`roster-partial-${width}.png`)})
 if(width>=1080)await detail.getByRole('button',{name:'‹ 在做',exact:true}).click()
 else await page.keyboard.press('Escape')
 await clickNav(page,'overview')
})

import {join} from 'node:path'
import {test,expect,clickNav,WORKBENCH_ROUTES} from './fixtures'
import {placeAnswerSurface,placeItem,placeRow,terminalPlace} from './roster-fixture'
const task={id:'deadbeef',title:'作品集',path:'/demo/portfolio',providerId:'claude',status:'running',createdAt:1,updatedAt:2,error:null,archivedAt:null,pendingPermissionCount:1,pendingQuestionCount:0}
for(const width of [1440,900])test(`places keep request purpose, answer in place, keyboard destination and stale reads at ${width}`,async({page,shim,shimUrl})=>{
 await page.setViewportSize({width,height:900})
 await shim.invoke('demo.seed',{daemonAlive:true})
 let unreadable=false
 const places=[
  placeItem('portfolio',{status:'waiting',moving:false,line:'Bash: bun run test',matterIds:[task.id],waiting:{itemKey:`matter:${task.id}`,kind:'permission',matterId:task.id,requestId:'0f0f0f0f-0000-4000-8000-000000000001',summary:'Bash: bun run test',count:1}}),
  terminalPlace('demo','terminal-1','git status'),
 ]
 const decisions:unknown[]=[]
 await page.route('**/v1/places',route=>unreadable?route.fulfill({status:503,json:{error:'unavailable'}}):route.fulfill({json:{places,version:'two'}}))
 await page.route(WORKBENCH_ROUTES,route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/v1/workbench/task')return route.fulfill({json:{task,events:[{id:1,taskId:task.id,kind:'text',text:'想运行测试，确认排版。',createdAt:2}],artifacts:[],questions:[],permissions:[{id:'p1',taskId:task.id,tool:'Bash',description:'bun run test',createdAt:2}]}})
  if(path==='/v1/workbench/attention')return route.fulfill({json:{tasks:[{...task,attentionKey:'["p1"]',first:{kind:'permission',text:'Bash: bun run test'}}]}})
  if(path==='/v1/workbench')return route.fulfill({json:{tasks:[task],projects:[],providers:[{id:'claude',displayName:'Claude'}],defaultProvider:'claude',canWechat:false}})
  return route.fulfill({json:{reviews:[]}})
 })
 await page.route('**/v1/matter?id=*',route=>route.fulfill({json:{matter:{...task,kind:'task'}}}))
 // 在 WORKBENCH_ROUTES 之后登记:Playwright 里后登记的先接,那条宽的正则也匹配 /v1/matter/permission。
 await page.route('**/v1/matter/permission',route=>{decisions.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}})})
 await page.route('**/v1/cli/sessions*',route=>route.fulfill({json:{sessions:[{session_id:'terminal-1',source:'codex',status:'waiting',live_window:true,last_summary:'git status',pending:{actionable:true,tool:'Bash',summary:'git status',hash:'k3x9z'}}]}}))
 await page.route('**/v1/cli/activity*',route=>route.fulfill({json:{items:[{id:'msg',kind:'said',text:'终端原话',at:null}],earlier:null}}))
 await page.goto(shimUrl)
 await expect(page.locator('main.dashboard')).toBeVisible()
 await expect(page.locator('#now-waiting')).toHaveCount(0)
 await expect(page.locator('#places-root .place[data-waiting="true"]')).toHaveCount(2)
 const row=placeRow(page,'portfolio')
 await expect(row).toContainText('Bash: bun run test')
 // 等批准的从当前窗口的应答入口发给那一件的那一条。
 await placeAnswerSurface(page,'portfolio').getByRole('button',{name:'允许',exact:true}).click()
 await expect.poll(()=>decisions).toEqual([{id:task.id,requestId:'0f0f0f0f-0000-4000-8000-000000000001',decision:'allow'}])
 // 终端停着问:键盘能到「去回答」,打开的是那个会话。
 const answer=placeAnswerSurface(page,'demo').locator('[data-place-open]')
 await expect(answer).toBeVisible()
 await answer.focus();await answer.press('Enter')
 const detail=page.locator('#thing-thread .thing-terminal:visible')
 await expect(detail).toContainText('git status')
 await expect(detail).toContainText('终端原话')
 await expect(detail.getByRole('button',{name:'允许',exact:true})).toBeVisible()
 const out=process.env.WECHAT_CC_DESIGN_SHOTS
 if(out)await page.screenshot({path:join(out,`roster-partial-${width}.png`)})
 await clickNav(page,'overview')
 await expect(detail).toHaveCount(0)
 // 连不上:保留上一次的行,说一句。
 unreadable=true
 await expect(page.locator('#places-root')).toContainText('家里的电脑暂时连不上',{timeout:12000})
 await expect(placeRow(page,'portfolio')).toContainText('Bash: bun run test')
})

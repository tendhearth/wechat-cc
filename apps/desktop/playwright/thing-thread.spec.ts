import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { placeItem, placeRow, rosterItem, routePlaces, routeRoster, terminalPlace } from './roster-fixture'

test.use({viewport:{width:1280,height:820}})
const now = Date.now()
const step = (id:string,kind:'you'|'said'|'step',text:string,extra:Record<string,unknown>={}) => ({id,kind,text,at:now,...extra})
const roster = (id:string,group='back',updatedAt=now) => rosterItem(id,id,{
  id,key:'terminal:'+id,kind:'terminal',group,status:group==='waiting'?'waiting':group==='working'?'working':'replied',
  terminal:{sessionId:id,code:id},waiting:undefined,updatedAt,
})
const session = (id:string,extra:Record<string,unknown>={}) => ({
  session_id:id,source:'codex',displayName:'Codex',status:'idle',pending:null,stale:false,project:id==='solo'?'花园终端':'工作区',...extra,
})
const thread = (page:Page) => page.locator('#thing-thread')
const terminal = (page:Page) => thread(page).locator('.thing-terminal:visible')
const select = (page:Page,name:string) => placeRow(page,name).locator('.place-row').click()
const home = (page:Page) => page.locator('#topbar-cc')
const solo = placeItem('花园',{sessionIds:['solo'],updatedAt:now})
const three = terminalPlace('备份','ask','读备份目录？',{
  updatedAt:now,sessionIds:['ask','new','run'],
  waiting:{kind:'terminal',itemKey:'terminal:ask',sessionId:'ask',requestId:'a1234',summary:'读备份目录？',
    count:1,ccOpinion:'可以读备份目录。',questionReason:'需要访问另一个目录。'},
})
const approval = {actionable:true,tool:'Read',summary:'读备份目录？',hash:'a1234'}
const entries = [
  step('you','you','把这周的记录整理一下'),
  step('reply','said','这是短摘要',{full:'这是 **完整原话**，包含记录。'}),
  step('one','step','读 records.md',{detail:'这里是工具输出',verb:'read',target:'records.md'}),
  step('two','step','核对目录',{error:true}),
]

async function mockTerminal(page:Page,{withThree=false,waiting=true,long=false,older=false}={}) {
  const model = {activities:long ? [...Array.from({length:30},(_,index)=>step('fill'+index,'said',`读到第 ${index} 条记录`)),...entries] : [...entries],
    reads:0,approved:false}
  await routePlaces(page,()=>[solo,...(withThree?[model.approved||!waiting?{...three,waiting:null}:three]:[])])
  await routeRoster(page,[roster('solo'),...(withThree?[roster('new','back',now+3000),roster('run','working',now+2000),roster('ask',waiting?'waiting':'back',now+1000)]:[])])
  await page.route('**/v1/cli/sessions**',route=>{
    const all = [session('solo'),session('new'),session('run',{status:'running',live_window:false}),
      session('ask',{status:model.approved?'running':waiting?'waiting':'idle',pending:model.approved||!waiting?null:approval})]
    const wanted = new URL(route.request().url()).searchParams.get('session_id')
    return route.fulfill({json:{ok:true,sessions:wanted?all.filter(item=>item.session_id===wanted):all}})
  })
  await page.route('**/v1/cli/activity**',route=>{
    const query = new URL(route.request().url()).searchParams
    expect(query.get('full')).toBe('1')
    expect(query.get('limit')).toBe('40')
    const id = query.get('session_id')
    if (query.has('before')) {
      expect(query.get('before')).toBe('older')
      return route.fulfill({json:{ok:true,items:[step('older','step','昨天找到的记录',{at:now-86400000})],earlier:null}})
    }
    model.reads++
    return route.fulfill({json:{ok:true,items:id==='solo'?model.activities:[step('reply','said',`${id} 的原话`)],
      earlier:id==='solo'&&older?'older':null}})
  })
  return model
}

test.beforeEach(async ({shim})=>{ await shim.invoke('demo.seed',{daemonAlive:true}) })

test('一次会话直接读原话；重复点击不取消，回 CC 草稿还在；收栏后阅读栏居中',async({page,shimUrl})=>{
  await mockTerminal(page)
  await page.goto(shimUrl)
  await page.locator('#converse-input').fill('CC 的未发送草稿')
  await select(page,'花园')
  await expect(thread(page)).toBeVisible()
  await expect(terminal(page)).toContainText('把这周的记录整理一下')
  await expect(terminal(page).locator('strong')).toHaveText('完整原话')
  const line = terminal(page)
  await expect(line.getByText('做了 2 步')).toBeVisible()
  await expect(line.locator('.desk-speaker:visible')).toHaveCount(0)
  await expect(line.locator('.converse-msg-user .converse-bubble')).toHaveCSS('border-radius', '18px 18px 6px 18px')
  await expect(line.locator('.converse-msg-cc .converse-bubble')).toHaveCSS('line-height', '26.25px')
  await expect(line.locator('.thing-compose')).toHaveCSS('border-radius', '20px')
  await expect(line.getByRole('button', {name:'发送', exact:true})).toHaveCSS('background-color', 'rgb(243, 238, 230)')
  await expect(thread(page).locator('.thing-sessions')).toBeHidden()
  await expect(thread(page).locator('.thing-agent')).toHaveText('Codex')
  await expect(thread(page).locator('.thing-state')).toHaveText('停着')
  await expect(page.getByRole('button',{name:'回到全部',exact:true})).toHaveCount(0)
  await expect(terminal(page).locator('.converse-recipient')).toHaveText('Codex ›')
  await expect(terminal(page).locator('textarea')).toHaveAttribute('placeholder','接着对 Codex 说…')
  await select(page,'花园')
  await expect(thread(page)).toBeVisible()
  await page.locator('#desk-rail-toggle').click()
  await expect.poll(async()=>{
    const box = (await terminal(page).locator('.thing-scroll').boundingBox())!
    return Math.abs(box.x+box.width/2-640)
  }).toBeLessThanOrEqual(2)
  await page.locator('#desk-rail-toggle').click()
  await expect(placeRow(page,'花园')).toHaveCSS('background-color','rgb(253, 251, 247)')
  await expect(placeRow(page,'花园')).not.toHaveCSS('box-shadow','none')
  await home(page).click()
  await expect(home(page)).toHaveCSS('background-color','rgba(42, 38, 34, 0.04)')
  await page.locator('#converse-input').hover()
  await expect(home(page)).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect(page.locator('#converse-input')).toHaveValue('CC 的未发送草稿')
})

test('三次会话优先等你定，换会话以及回到原处都可后退；运行中没有窗口时禁用',async({page,shimUrl})=>{
  await mockTerminal(page,{withThree:true})
  await page.goto(shimUrl)
  await select(page,'花园')
  await select(page,'备份')
  const tabs = thread(page).locator('[data-thread-session]')
  await expect(tabs).toHaveCount(3)
  await expect(tabs.last()).toHaveAttribute('aria-pressed','true')
  await expect(tabs.last()).toHaveCSS('border-bottom-color','rgb(42, 38, 34)')
  await expect(tabs.last()).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect(tabs.last().locator('.th-agents')).toHaveCSS('--th-agent-size','14px')
  const heading = thread(page).locator('.thing-heading')
  await expect(heading).toHaveCSS('height','52px')
  await expect(heading.locator('.thing-agent')).toHaveText('Codex')
  await expect(heading.locator('.thing-status')).not.toContainText('·')
  const state = heading.locator('.thing-state')
  await expect(state).toHaveText('等你定')
  await expect(state).toHaveAttribute('data-tone','waiting')
  await expect(terminal(page)).toContainText('ask 的原话')
  const card = terminal(page).locator('.desk-waiting-card')
  await expect(card).toHaveCSS('border-radius', '14px')
  await expect(card.locator('.desk-waiting-opinion')).toHaveCSS('font-family', /TH Pen Hand/)
  await expect(card.locator('.desk-waiting-reason')).toHaveCSS('font-size', '13px')
  await tabs.nth(1).click()
  await expect(terminal(page)).toContainText('run 的原话')
  await expect(state).toHaveText('正在做')
  await expect(state).toHaveAttribute('data-tone','working')
  const input=terminal(page).locator('textarea')
  await expect(input).toBeDisabled()
  await expect(input).toHaveAttribute('placeholder','Codex 正在做，等这一轮停了再说')
  const back=page.locator('#desk-back')
  await back.click()
  await expect(terminal(page)).toContainText('ask 的原话')
  await back.click()
  await expect(thread(page).getByRole('heading',{name:'花园'})).toBeVisible()
})

test('没有等你定时默认最近，重进地方恢复上次选择',async({page,shimUrl})=>{
  await mockTerminal(page,{withThree:true,waiting:false})
  await page.goto(shimUrl)
  await select(page,'备份')
  const tabs=thread(page).locator('[data-thread-session]')
  await expect(tabs.first()).toHaveAttribute('aria-pressed','true')
  await expect(terminal(page)).toContainText('new 的原话')
  await tabs.last().click()
  await select(page,'花园')
  await select(page,'备份')
  await expect(tabs.last()).toHaveAttribute('aria-pressed','true')
  await expect(terminal(page)).toContainText('ask 的原话')
})

test('展开两层后重读保持节点，往上读时新回复提示且位置不动',async({page,shimUrl})=>{
  const model=await mockTerminal(page,{long:true})
  await page.goto(shimUrl)
  await select(page,'花园')
  const scroll=terminal(page).locator('.thing-scroll')
  const group=scroll.locator('.thing-steps > details')
  const detail=group.locator('li details')
  await group.locator(':scope > summary').click()
  await expect(group.locator('ol')).toHaveCSS('border-radius', '10px')
  await expect(detail.locator('summary code')).toHaveText('records.md')
  await expect(detail.locator('summary code')).toHaveCSS('font-size', '12px')
  await detail.locator('summary').click()
  await detail.locator('summary').focus()
  await expect(detail.locator('pre')).toBeVisible()
  await detail.evaluate(node=>node.setAttribute('data-test-same-node','yes'))
  const readCount=model.reads
  model.activities=[...model.activities,step('three','step','整理好了目录')]
  await expect.poll(()=>model.reads,{timeout:9000}).toBeGreaterThanOrEqual(readCount+2)
  await expect(group).toHaveAttribute('open','')
  await expect(group.locator('li')).toHaveCount(3)
  await expect(detail).toHaveAttribute('data-test-same-node','yes')
  await expect(detail).toHaveAttribute('open','')
  await expect(detail.locator('summary')).toBeFocused()
  await scroll.evaluate(node=>{node.scrollTop=110})
  const top=await scroll.evaluate(node=>node.scrollTop)
  model.activities=[...model.activities,step('fresh','said','新回来的原话')]
  await expect(terminal(page).getByRole('button',{name:'有新回复 · 回到最新'})).toBeVisible({timeout:6000})
  expect(await scroll.evaluate(node=>node.scrollTop)).toBe(top)
})

test('拍板卡在输入区前并显示同一请求的意见，允许后消失',async({page,shimUrl})=>{
  const model=await mockTerminal(page,{withThree:true})
  const decisions: unknown[]=[]
  await page.route('**/v1/cli/decide',route=>{
    decisions.push(route.request().postDataJSON())
    model.approved=true
    return route.fulfill({json:{ok:true}})
  })
  await page.goto(shimUrl)
  await select(page,'备份')
  const panel=terminal(page)
  const card=panel.locator('.desk-waiting-card')
  await expect(card).toContainText('读备份目录？')
  await expect(card).toContainText('可以读备份目录。')
  await expect(card).toContainText('需要访问另一个目录。')
  await expect(page.locator('#desk-waiting .desk-waiting-card')).toHaveCount(0)
  const input=panel.locator('textarea')
  await expect(input).toBeDisabled()
  await expect(input).toHaveAttribute('placeholder','先定上面这件，它才往下走')
  expect((await card.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y)
  await card.getByRole('button',{name:'允许',exact:true}).click()
  expect(decisions).toEqual([{session_id:'ask',hash:'a1234',decision:'allow'}])
  await expect(card).toBeHidden()
})

test('发送先显示在路上，读回后只有原话；失败恢复草稿',async({page,shimUrl})=>{
  const model=await mockTerminal(page)
  const sent:unknown[]=[]
  let reject=false
  await page.route('**/v1/cli/session-say',route=>{
    sent.push(route.request().postDataJSON())
    return route.fulfill(reject?{status:409,json:{ok:false,error:'cli_session_busy'}}:{json:{ok:true,accepted:true}})
  })
  await page.goto(shimUrl)
  await select(page,'花园')
  const panel=terminal(page),input=panel.locator('textarea')
  const text='把目录也列一下'
  await input.fill(text)
  await panel.getByRole('button',{name:'发送'}).click()
  await expect(input).toHaveValue('')
  await expect(panel.locator('[data-sending]')).toHaveText(text)
  expect(sent).toEqual([{session_id:'solo',text}])
  model.activities=[...model.activities,step('received','you',text,{at:Date.now()})]
  await expect(panel.locator('[data-converse-message="received"]')).toHaveText(text,{timeout:6000})
  await expect(panel.locator('[data-sending]')).toHaveCount(0)
  reject=true
  await input.fill('送不进去的原话')
  await input.press('Enter')
  await expect(input).toHaveValue('送不进去的原话')
  await expect(panel.getByRole('status')).toHaveText('没送成，请重试')
})

test('更早的步前插并锚住首条，翻到头按钮消失',async({page,shimUrl})=>{
  await mockTerminal(page,{older:true,long:true})
  await page.goto(shimUrl)
  await select(page,'花园')
  const scroll=terminal(page).locator('.thing-scroll')
  const anchor=scroll.locator('[data-converse-message="fill0"]')
  await expect(anchor).toBeAttached()
  await scroll.evaluate(node=>{node.scrollTop=0})
  const y=(await anchor.boundingBox())!.y
  const earlier=scroll.getByRole('button',{name:'更早的',exact:true})
  await earlier.click()
  await expect(earlier).toBeHidden()
  const first=scroll.locator('[data-converse-message]').first()
  await expect(first).toHaveAttribute('data-converse-message','older')
  expect(Math.abs((await anchor.boundingBox())!.y-y)).toBeLessThanOrEqual(2)
  await first.locator('summary').click()
  await expect(first).toContainText('昨天找到的记录')
})

test('交办任务复用主区域的工作台详情实例，留在阅读栏内',async({page,shimUrl})=>{
  const task={id:'deadbeef',title:'备份检查',path:'/offline/project',providerId:'codex',status:'running',createdAt:1,updatedAt:2}
  await routePlaces(page,[placeItem('备份',{matterIds:[task.id]})])
  await routeRoster(page,[rosterItem(task.id,task.title,{group:'working',status:'working'})])
  await page.route('**/v1/matter?id=*',r=>r.fulfill({json:{matter:{...task,kind:'task'}}}))
  await page.route(/\/v1\/workbench(?:\?.*)?$/,r=>r.fulfill({json:{tasks:[task],projects:[],providers:[{id:'codex',displayName:'Codex'}]}}))
  await page.route('**/v1/workbench/task?*',r=>r.fulfill({json:{task,runId:'run',events:[{id:1,taskId:task.id,kind:'text',text:'交办任务的原话',createdAt:2}],permissions:[],questions:[],artifacts:[]}}))
  await page.goto(shimUrl)
  await select(page,'备份')
  const detail=thread(page).locator('.thing-detail'),workbench=detail.locator('#conversation-matter-layer')
  await expect(workbench).toContainText('交办任务的原话')
  await expect(workbench.locator('.wb-task-head h2')).toBeHidden()
  expect((await workbench.boundingBox())!.width).toBeLessThanOrEqual((await detail.boundingBox())!.width)
  await expect(page.locator('#conversation-matter-layer')).toHaveCount(1)
})

test('对话里的真实终端引用打开它的地方和会话',async({page,shimUrl})=>{
  await mockTerminal(page,{withThree:true})
  // 引用卡上的「看过程、接着说或停止」只在 daemon 报了共享对话能力时才有。
  await page.route('**/v1/protocol/capabilities',route=>route.fulfill({json:{routes:'v1',topics:'v1'}}))
  await page.route('**/v1/matter/owner-chat/work',route=>route.fulfill({json:{references:[],results:[]}}))
  await page.route('**/v1/matter/owner-chat/events**',route=>route.fulfill({json:{running:null,events:[],cursor:0}}))
  await page.route('**/v1/matter/owner-chat/window**',route=>route.fulfill({json:{messages:[]}}))
  await page.goto(shimUrl)
  await page.locator('.conversation-add summary').click()
  await page.locator('.conversation-add').getByRole('button',{name:'电脑上的会话',exact:true}).click()
  const picker=page.getByRole('dialog',{name:'电脑上的会话',exact:true})
  await picker.getByRole('button',{name:/^花园终端/}).click()
  const reference=page.locator('#converse-scroll [data-terminal-reference="solo"]')
  await reference.locator('summary').click()
  await reference.getByRole('button',{name:'看过程、接着说或停止'}).click()
  await expect(thread(page).getByRole('heading',{name:'花园'})).toBeVisible()
  await expect(terminal(page)).toContainText('把这周的记录整理一下')
})

test('800px 保留筛选条和补引用卡',async({page,shimUrl})=>{
  await page.setViewportSize({width:800,height:820})
  await mockTerminal(page)
  await page.goto(shimUrl)
  await select(page,'花园')
  await expect(thread(page)).toBeHidden()
  await expect(page.locator('#converse-place-clear')).toHaveText('只看 花园 · 回到全部')
  await expect(page.locator('#converse-scroll [data-terminal-reference="solo"]')).toBeVisible()
})

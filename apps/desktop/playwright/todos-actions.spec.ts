import {test,expect,clickNav} from './fixtures'
import type {Page,Route} from '@playwright/test'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'

const fact={id:101,contact:'friend',kind:'obligation',predicate:'约定',value:'周末把花园的照片发给阿柚，顺便问问她新种的植物长得怎么样。',time_ref:'2026-10-04',confidence:'high',updated_at:Math.floor(Date.now()/1000)}
const second={...fact,id:102,value:'下次见面时带上借来的书。'}
async function boot(page:Page,shimUrl:string,shim:any){
 await shim.invoke('demo.seed',{chat_id:'test_chat'})
 const state={active:[fact],settled:[] as typeof fact[],mode:'loaded',preferred:'owner',admins:['other-admin','owner'],memoryCalls:0,mutations:[] as {id:number,status:string}[]}
 await page.route('**/v1/knowledge/facts/find_facts',r=>r.fulfill({status:state.mode==='error'?503:200,json:state.mode==='error'?{error:'unavailable'}:{results:r.request().postDataJSON().status==='active'?state.active:state.settled}}))
 await page.route('**/v1/knowledge/graph/top_contacts',r=>r.fulfill({json:{contacts:[{username:'friend',display:'阿柚'}]}}))
 await page.route('**/v1/companion/status',r=>r.fulfill({json:{default_chat_id:state.preferred}}))
 await page.route('**/__invoke',r=>{
  const body=r.request().postDataJSON()
  if(body.command==='wechat_cli_json'&&body.args?.args?.[0]==='access')return r.fulfill({json:{result:{ok:true,admins:state.admins}}})
  if(body.command==='wechat_cli_json'&&body.args?.args?.[0]==='memory')state.memoryCalls++
  return r.continue()
 })
 await page.route('**/v1/knowledge/facts/set_fact_status',r=>{
  const body=r.request().postDataJSON();state.mutations.push(body)
  if(body.status==='resolved'){state.active=state.active.filter(f=>f.id!==body.id);state.settled=[fact]}
  if(body.status==='active'){state.active=[fact];state.settled=[]}
  return r.fulfill({json:{ok:true}})
 })
 await page.goto(shimUrl);await page.waitForFunction(()=>document.documentElement.dataset.mode==='dashboard')
 return state
}
async function openReminder(page:Page,id=101){
 const item=page.locator(`.todo-item[data-fact-id="${id}"]`)
 await item.locator('.todo-more>summary').click();await item.locator('[data-todo-action="remind"]').click()
 await expect(page.locator('#todo-remind-pop')).toBeVisible()
 return page.locator('#todo-remind-pop')
}
async function saveShot(page:Page,name:string){
 const out=process.env.WECHAT_CC_LIFE_SHOTS
 if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,name)})}
}

for(const width of [1440,760])test(`${width}px待办先读内容再完成，次要操作展开后不溢出`,async({page,shimUrl,shim})=>{
 await page.setViewportSize({width,height:1000});await boot(page,shimUrl,shim);await clickNav(page,'todos')
 const item=page.locator('.todo-item').first()
 await expect(item.locator('[data-todo-action="resolve"]')).toBeVisible()
 await expect(item.locator('[data-todo-action="remind"]')).not.toBeVisible()
 await expect(item.locator('[data-todo-action="reject"]')).not.toBeVisible()
 await expect(page.locator('.todos-head h1')).toHaveCSS('font-size','22px')
 await expect(item.locator('.todo-value')).toHaveCSS('font-size','18px')
 await expect(item.locator('.todo-meta')).toHaveCSS('font-size','14px')
 await saveShot(page,`todos-${width}.png`)
 const picker=await openReminder(page)
 await expect(picker.locator('input')).toHaveCSS('font-size','16px')
 expect(await item.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
 expect(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth)).toBe(true)
 await saveShot(page,`todos-reminder-${width}.png`)
 await page.keyboard.press('Escape');await expect(picker).toHaveCount(0)
})

test('提醒失败保留自选时间并能重试，发送给配置的主人',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);const requests:any[]=[]
 await page.route('**/v1/reminders/schedule',r=>{requests.push(r.request().postDataJSON());return r.fulfill({json:{ok:requests.length>1,error:'too_many_pending'}})})
 await clickNav(page,'todos');const picker=await openReminder(page)
 await picker.locator('input').fill('2099-10-04T09:30');await picker.locator('#todo-remind-custom-go').click()
 await expect(picker.locator('[role=status]')).toContainText('待发送的提醒已满')
 await expect(picker.locator('input')).toHaveValue('2099-10-04T09:30');await expect(picker.locator('#todo-remind-custom-go')).toBeEnabled()
 await picker.locator('#todo-remind-custom-go').click();await expect(picker.locator('[role=status]')).toContainText('到点会发微信提醒你')
 await expect(picker.locator('#todo-remind-custom-go')).toBeDisabled()
 expect(requests).toHaveLength(2);expect(requests[0].chat_id).toBe('owner');expect(requests[1].text).toBe(`⏰ 待办：${fact.value}`);expect(state.memoryCalls).toBe(0)
})

test('未确认的接收人不会创建提醒，可以在原表单恢复',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);state.admins=[];state.preferred='a-contact';let calls=0
 await page.route('**/v1/reminders/schedule',r=>{calls++;return r.fulfill({json:{ok:true}})})
 await clickNav(page,'todos');const picker=await openReminder(page);await picker.locator('[data-remind-at]').first().click()
 await expect(picker).toContainText('还没有确认接收提醒的微信');expect(calls).toBe(0)
 state.admins=['real-admin'];await picker.locator('[data-remind-at]').first().click();await expect(picker).toContainText('到点会发微信提醒你');expect(calls).toBe(1)
})

test('离开待办后迟到的主人读取不会创建提醒或干扰重新打开的表单',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let owner:Route|undefined,calls=0
 await page.route('**/v1/companion/status',r=>{owner=r})
 await page.route('**/v1/reminders/schedule',r=>{calls++;return r.fulfill({json:{ok:true}})})
 await clickNav(page,'todos');await (await openReminder(page)).locator('[data-remind-at]').first().click()
 await expect.poll(()=>!!owner).toBe(true);await clickNav(page,'recollections');await expect(page.locator('#todo-remind-pop')).toHaveCount(0)
 await clickNav(page,'todos');const fresh=await openReminder(page);await fresh.locator('input').fill('2099-10-05T12:00')
 await owner!.fulfill({json:{default_chat_id:'owner'}})
 await expect(fresh.locator('input')).toHaveValue('2099-10-05T12:00');await expect(fresh.locator('#todo-remind-custom-go')).toBeEnabled()
 expect(calls).toBe(0)
})

test('已发送的迟到结果不覆盖另一个待办的新提醒表单',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);state.active=[fact,second];let pending:Route|undefined,calls=0
 await page.route('**/v1/reminders/schedule',r=>{calls++;pending=r})
 await clickNav(page,'todos');await (await openReminder(page)).locator('[data-remind-at]').first().click();await expect.poll(()=>calls).toBe(1)
 await clickNav(page,'recollections');await clickNav(page,'todos')
 const fresh=await openReminder(page,102);await fresh.locator('input').fill('2099-10-05T12:00')
 await pending!.fulfill({json:{ok:true}})
 await expect(fresh.locator('input')).toHaveValue('2099-10-05T12:00');await expect(fresh.locator('[role=status]')).toBeEmpty();await expect(fresh.locator('#todo-remind-custom-go')).toBeEnabled()
 expect(calls).toBe(1)
})

test('完成时禁止重复修改，最近了结能恢复回待办',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);let pending:Route|undefined,calls=0
 await page.route('**/v1/knowledge/facts/set_fact_status',r=>{calls++;pending=r})
 await clickNav(page,'todos');const item=page.locator('.todo-item').first()
 await item.locator('[data-todo-action="resolve"]').click();await expect.poll(()=>calls).toBe(1)
 await expect(item.locator('[data-todo-action="resolve"]')).toBeDisabled();await expect(item.locator('[data-todo-action="reject"]')).toBeDisabled()
 state.active=[];state.settled=[fact];await pending!.fulfill({json:{ok:true}})
 await expect(page.locator('.todos-empty')).toBeVisible();await expect(page.locator('.todo-settled>summary')).toContainText('最近了结')
 await page.locator('.todo-settled>summary').click();await page.locator('[data-todo-action="revive"]').click();await expect.poll(()=>calls).toBe(2)
 expect(pending!.request().postDataJSON()).toEqual({id:101,status:'active'})
 state.active=[fact];state.settled=[];await pending!.fulfill({json:{ok:true}})
 await expect(page.locator('[data-todo-action="resolve"]')).toBeVisible();await expect(page.locator('.todo-settled')).toHaveCount(0)
})

test('读取失败可以恢复，空态和错误态在窄窗口都能读',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000});const state=await boot(page,shimUrl,shim);state.mode='error'
 await clickNav(page,'todos');await expect(page.locator('#todos-list')).toContainText('暂时没能读取待办');await expect(page.locator('.cc-page-status p')).toHaveCSS('font-size','16px');await saveShot(page,'todos-error-760.png')
 state.mode='loaded';state.active=[];await page.locator('.cc-page-status button').click();await expect(page.locator('.todos-empty')).toContainText('还没有待办');await saveShot(page,'todos-empty-760.png')
 state.active=[fact];await page.locator('#todos-refresh').click();await expect(page.locator('.todo-value')).toContainText(fact.value)
})

test('完成结果迟到时，重新进入的待办仍按真实状态更新',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);let pending:Route|undefined
 await page.route('**/v1/knowledge/facts/set_fact_status',r=>{pending=r})
 await clickNav(page,'todos');await page.locator('[data-todo-action="resolve"]').click();await expect.poll(()=>!!pending).toBe(true)
 await clickNav(page,'recollections');await clickNav(page,'todos');await expect(page.locator('[data-todo-action="resolve"]')).toBeDisabled()
 state.active=[];state.settled=[fact];await pending!.fulfill({json:{ok:true}})
 await expect(page.locator('.todos-empty')).toBeVisible();await expect(page.locator('.todo-settled')).toContainText(fact.value)
})

test('迟到的完成结果保留另一条提醒草稿，结束提醒后更新列表',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);state.active=[fact,second];let pending:Route|undefined
 await page.route('**/v1/knowledge/facts/set_fact_status',r=>{pending=r})
 await clickNav(page,'todos');await page.locator('.todo-item[data-fact-id="101"] [data-todo-action="resolve"]').click();await expect.poll(()=>!!pending).toBe(true)
 await clickNav(page,'recollections');await clickNav(page,'todos');const fresh=await openReminder(page,102);await fresh.locator('input').fill('2099-10-05T12:00')
 state.active=[second];state.settled=[fact];await pending!.fulfill({json:{ok:true}})
 await expect(fresh.locator('input')).toHaveValue('2099-10-05T12:00');await expect(page.locator('.todo-item[data-fact-id="101"] [data-todo-action="resolve"]')).toBeDisabled()
 await page.keyboard.press('Escape');await expect(page.locator('.todo-group .todo-item[data-fact-id="101"]')).toHaveCount(0);await expect(page.locator('.todo-group .todo-item[data-fact-id="102"]')).toContainText(second.value)
})

test('刷新替换了等待主人解析的表单后，迟到解析不会创建提醒',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let read:Route|undefined,owner:Route|undefined,calls=0
 await clickNav(page,'todos');await expect(page.locator('.todo-value')).toBeVisible()
 await page.route('**/v1/knowledge/facts/find_facts',r=>r.request().postDataJSON().status==='active'?(read=r,undefined):r.fulfill({json:{results:[]}}))
 await page.route('**/v1/companion/status',r=>{owner=r})
 await page.route('**/v1/reminders/schedule',r=>{calls++;return r.fulfill({json:{ok:true}})})
 await page.locator('#todos-refresh').click();await expect.poll(()=>!!read).toBe(true)
 await (await openReminder(page)).locator('[data-remind-at]').first().click();await expect.poll(()=>!!owner).toBe(true)
 await read!.fulfill({json:{results:[fact]}});await expect(page.locator('#todo-remind-pop')).toHaveCount(0)
 await owner!.fulfill({json:{default_chat_id:'owner'}});await page.waitForTimeout(150)
 expect(calls).toBe(0)
})

test('同一页完成另一条待办时也保留当前提醒草稿',async({page,shimUrl,shim})=>{
 const state=await boot(page,shimUrl,shim);state.active=[fact,second];let pending:Route|undefined
 await page.route('**/v1/knowledge/facts/set_fact_status',r=>{pending=r})
 await clickNav(page,'todos');await page.locator('.todo-item[data-fact-id="101"] [data-todo-action="resolve"]').click();await expect.poll(()=>!!pending).toBe(true)
 const fresh=await openReminder(page,102);await fresh.locator('input').fill('2099-10-05T12:00')
 state.active=[second];state.settled=[fact];await pending!.fulfill({json:{ok:true}});await page.waitForTimeout(400)
 await expect(fresh.locator('input')).toHaveValue('2099-10-05T12:00');await expect(page.locator('.todo-item[data-fact-id="101"] [data-todo-action="resolve"]')).toBeDisabled()
 await page.keyboard.press('Escape');await expect(page.locator('.todo-group .todo-item[data-fact-id="101"]')).toHaveCount(0)
})

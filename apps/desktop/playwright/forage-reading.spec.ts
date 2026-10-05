import {test,expect,clickNav,clickRevealed} from './fixtures'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import type {Page,Route} from '@playwright/test'

const note='第一段，周末可以一起做一点小东西。\n第二段，这是 CC 带回来的推荐理由。\n第三段，完整的内容在打开后都能读到。'
const catches=[{id:'catch-1',kind:'hunt',ts:'2026-10-03T09:00:00Z',title:'把周末留给一件小作品',note,url:'https://example.com/project',status:'new'},{id:'visit-1',kind:'visit',ts:'2026-10-03T08:00:00Z',title:'去阿柚家聊了聊',note:'我们聊了种花和秋天。回来时 CC 留下了这一段见闻。',status:'new'}]
const people=[{id:'neighbor:ayou',kind:'neighbor',label:'阿柚',channel:null,familiarity:{visits:2,lastAt:'2026-10-02T09:00:00Z',note:'关于窗台上种什么花，我们聊了很久。这一整段文字应该能够正常换行读完。'},origin:'公共伙伴',autoVisit:true}]
const wishes=[{id:'saved',text:'周末有没有人想一起做个小作品？',status:'draft',created_at:'2026-10-03',expires_at:null,sent_to:0,replies:0},{id:'open',text:'找一位也喜欢种花的朋友',status:'open',created_at:'2026-10-02',expires_at:null,sent_to:2,replies:1,postcards:[]}]
const channels=[{id:'mail-1',peer_label:'阿柚',title:'窗台上的花',last_preview:'今天的阳光很好，你那边呢？',unread:1}]
const letters=[{id:'letter-1',direction:'in',plaintext:'今天的阳光很好，你那边呢？\n我给窗台上的花浇了水。',created_at:'2026-10-03T08:00:00Z'}]

async function boot(page:Page,shimUrl:string,shim:any){
 await shim.invoke('demo.seed',{chat_id:'test_chat'})
 await page.route('**/v1/journal',r=>r.fulfill({json:{items:catches}}))
 await page.route('**/v1/social/relationships',r=>r.fulfill({json:{relationships:people}}))
 await page.route('**/v1/social/wishes',r=>r.fulfill({json:{wishes}}))
 await page.route('**/v1/social/intro/offers',r=>r.fulfill({json:{offers:[]}}))
 await page.route('**/v1/a2a/list',r=>r.fulfill({json:{agents:[{id:'ayou',name:'阿柚的 CC',transport:'mailbox',relays:[],paused:false}]}}))
 await page.route('**/v1/a2a/info',r=>r.fulfill({json:{enabled:true}}))
 await page.route('**/v1/social/inbound',r=>r.fulfill({json:{enabled:true}}))
 await page.route('**/v1/penpal/channels',r=>r.fulfill({json:{channels}}))
 await page.route('**/v1/penpal/letters?**',r=>r.fulfill({json:{letters}}))
 await page.route('**/v1/penpal/letters/read',r=>r.fulfill({json:{ok:true}}))
 await page.goto(shimUrl)
 await page.waitForFunction(()=>document.documentElement.dataset.mode==='dashboard')
 await clickNav(page,'a2a-agents')
 await expect(page.locator('#fd-catch .hb-read')).toHaveCount(2)
}
async function snapshot(page:Page,name:string){
 const out=process.env.WECHAT_CC_FORAGE_SHOTS
 if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,name+'.png'),fullPage:true})}
}

for(const width of [1440,760])test(`觅食 ${width}px：列表只打开阅读，正文和联系人能读完，动作与配对层级清楚`,async({page,shimUrl,shim})=>{
 await page.setViewportSize({width,height:1000});await boot(page,shimUrl,shim)
 await expect(page.locator('#fd-catch [data-hb-action="status"]')).toHaveCount(0)
 await expect(page.locator('#fd-catch .hb-note').first()).toHaveCSS('font-size','16px')
 await expect(page.locator('#fd-people .pp-note')).toHaveCSS('font-size','16px')
 await expect(page.locator('#fd-people .pp-note')).toHaveCSS('white-space','pre-wrap')
 await expect(page.locator('.fd-sec-head h2').first()).toHaveCSS('font-size','18px')
 expect(await page.locator('.fd-wrap').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
 await snapshot(page,`forage-${width}`)
 const opener=page.locator('#fd-catch .hb-read').first();await opener.click()
 const reader=page.locator('dialog.cc-record-reader')
 await expect(reader).toContainText('第三段，完整的内容在打开后都能读到。')
 await expect(reader.locator('.hb-detail>p').last()).toHaveCSS('font-size','16px')
 await expect(reader.locator('a')).toHaveAttribute('href','https://example.com/project')
 await expect(reader.locator('[data-hb-action="status"]').first()).toBeHidden()
 await reader.locator('summary').click();await expect(reader.locator('[data-hb-status="using"]')).toBeVisible()
 expect(await reader.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
 await snapshot(page,`catch-reader-${width}`)
 await page.keyboard.press('Escape');await expect(opener).toBeFocused()
 await page.locator('#fd-connect-btn').click()
 await expect(page.locator('#fd-pair-start')).toBeFocused()
 await expect(page.locator('#a2a-add-btn')).toBeHidden()
 await clickRevealed(page,'#a2a-add-btn');await expect(page.locator('#a2a-add-modal')).toBeVisible()
 await page.keyboard.press('Escape')
})

test('收获更新等待中重复点击只有一次，失败能重试并保留完整阅读',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let pending:Route|undefined,calls=0,state='new'
 await page.route('**/v1/journal',r=>r.fulfill({json:{items:[{...catches[0],status:state}]}}))
 await page.route('**/v1/journal/status',r=>{calls++;pending=r})
 await page.locator('#fd-catch .hb-read').first().click();const reader=page.locator('dialog.cc-record-reader')
 await reader.locator('summary').click();const using=reader.locator('[data-hb-status="using"]')
 await using.dblclick();await expect.poll(()=>calls).toBe(1);await expect(using).toBeDisabled()
 await pending!.abort();await expect(using).toBeEnabled();await expect(using).toHaveAttribute('aria-pressed','false')
 await expect(reader).toContainText('第三段');await using.click();await expect.poll(()=>calls).toBe(2)
 state='using';await pending!.fulfill({json:{ok:true}});await expect(using).toHaveAttribute('aria-pressed','true')
})

test('状态已保存但重读失败时，详情显示确认的新状态并提供可操作的重试',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim)
 await page.route('**/v1/journal/status',r=>r.fulfill({json:{ok:true}}))
 await page.route('**/v1/journal',r=>r.fulfill({status:503,json:{error:'temporary_unavailable'}}))
 await page.locator('#fd-catch .hb-read').first().click();const reader=page.locator('dialog.cc-record-reader')
 await reader.locator('summary').click();await reader.locator('[data-hb-status="using"]').click()
 await expect(reader.locator('[data-hb-status="using"]')).toHaveAttribute('aria-pressed','true')
 await expect(reader.locator('[data-hb-action="retry"]')).toBeVisible()
 await page.route('**/v1/journal',r=>r.fulfill({json:{items:[{...catches[0],status:'using'}]}}))
 await reader.locator('[data-hb-action="retry"]').click();await expect(reader.locator('.hb-detail-feedback')).toHaveCount(0)
})

test('删除最后一条保留记录后，键盘焦点落到仍可见的折叠标题',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let removed=false
 await page.route('**/v1/journal',r=>r.fulfill({json:{items:[...(removed?[]:[catches[0]]),{...catches[1],id:'dropped',status:'dropped'}]}}))
 await page.route('**/v1/journal/remove',r=>{removed=true;return r.fulfill({json:{ok:true}})})
 await clickNav(page,'overview');await clickNav(page,'a2a-agents')
 await page.locator('#fd-catch .hb-read').first().click();const reader=page.locator('dialog.cc-record-reader')
 await reader.locator('summary').click();await reader.locator('[data-hb-action="remove"]').click()
 await expect(reader).toHaveCount(0);await expect(page.locator('.hb-dropped>summary')).toBeFocused()
})

test('读取失败给局部重试，恢复后不冒充零朋友或社交关闭',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000})
 await boot(page,shimUrl,shim)
 await page.route('**/v1/journal',r=>r.fulfill({status:503,json:{error:'temporary_unavailable'}}))
 await page.route('**/v1/social/relationships',r=>r.fulfill({status:503,json:{error:'temporary_unavailable'}}))
 await page.route('**/v1/social/wishes',r=>r.fulfill({status:503,json:{error:'temporary_unavailable'}}))
 await page.route('**/v1/penpal/channels',r=>r.fulfill({status:503,json:{error:'temporary_unavailable'}}))
 await page.route('**/v1/a2a/list',r=>r.fulfill({status:503,json:{error:'temporary_unavailable'}}))
 await clickNav(page,'overview');await clickNav(page,'a2a-agents')
 await expect(page.locator('#fd-catch [data-hb-action="retry"]')).toBeVisible()
 await expect(page.locator('#fd-people [data-pp-action="retry"]')).toBeVisible()
 await expect(page.locator('#fd-wish-list [data-wsh-action="retry"]')).toBeVisible()
 await expect(page.locator('#fd-peers-count')).not.toContainText('0 位')
 await page.locator('#fd-tools-summary').click()
 await expect(page.locator('#fd-mailbox [data-action="mailbox-retry"]')).toBeVisible()
 await expect(page.locator('#fd-mailbox [data-action="social-enable"]')).toHaveCount(0)
 await snapshot(page,'forage-error-760')
 await page.route('**/v1/journal',r=>r.fulfill({json:{items:catches}}))
 await page.locator('#fd-catch [data-hb-action="retry"]').click()
 await expect(page.locator('#fd-catch .hb-read')).toHaveCount(2)
})

test('已有心愿继续确认不自动派出，等待时保护卡片与新文字',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000});await boot(page,shimUrl,shim)
 let pending:Route|undefined,calls=0,rows=wishes.slice()
 await page.route('**/v1/social/wishes',r=>r.fulfill({json:{wishes:rows}}))
 await page.route('**/v1/social/wish/send',r=>{calls++;pending=r})
 await page.locator('[data-wsh-action="resume"][data-wsh-id="saved"]').click()
 await expect(page.locator('.wsh-draft-text')).toHaveText(wishes[0].text);expect(calls).toBe(0)
 await page.locator('#fd-wish-draft').scrollIntoViewIfNeeded()
 await snapshot(page,'wish-confirm-760')
 await page.locator('[data-wsh-action="send"]').dblclick();await expect.poll(()=>calls).toBe(1)
 await expect(page.locator('[data-wsh-action="send"]')).toBeDisabled()
 await page.locator('#fd-wish-text').fill('下一件想打听的事')
 rows=[{...wishes[0],status:'open',sent_to:2},wishes[1]];await pending!.fulfill({json:{ok:true,sent_to:2}})
 await expect(page.locator('#fd-wish-draft')).toBeHidden()
 await expect(page.locator('#fd-wish-text')).toHaveValue('下一件想打听的事')
})

test('心愿创建跨页保持等待，未知派出结果可以原地重读并收起已处理卡',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let pending:Route|undefined,creates=0,rows=wishes.slice()
 await page.route('**/v1/social/wishes',r=>r.fulfill({json:{wishes:rows}}))
 await page.route('**/v1/social/wish',r=>{creates++;pending=r})
 await page.locator('#fd-wish-text').fill('准备创建的句子');await page.locator('#fd-wish-submit').click()
 await expect.poll(()=>creates).toBe(1);await clickNav(page,'overview');await clickNav(page,'a2a-agents')
 await expect(page.locator('#fd-wish-submit')).toBeDisabled()
 rows=[...wishes,{...wishes[0],id:'created',text:'可公开的句子'}];await pending!.fulfill({json:{ok:true,id:'created',preview:'可公开的句子'}})
 await expect(page.locator('#fd-wish-submit')).toBeEnabled();await expect(page.locator('#fd-wish-draft')).toBeHidden();expect(creates).toBe(1)
 await page.locator('[data-wsh-action="resume"][data-wsh-id="saved"]').click()
 await page.route('**/v1/social/wish/send',r=>{rows=rows.map(row=>row.id==='saved'?{...row,status:'open',sent_to:2}:row);return r.abort()})
 await page.locator('#fd-wish-draft [data-wsh-action="send"]').click()
 await expect(page.locator('#fd-wish-draft [data-wsh-action="retry"]')).toBeVisible()
 await page.locator('#fd-wish-text').fill('尚未提交的新文字')
 await page.locator('#fd-wish-draft [data-wsh-action="retry"]').click()
 await expect(page.locator('#fd-wish-draft')).toBeHidden();await expect(page.locator('#fd-wish-text')).toHaveValue('尚未提交的新文字')
 await expect(page.locator('[data-wsh-action="resume"][data-wsh-id="saved"]')).toHaveCount(0)
})

test('首次寄信等待中改写下一封，成功只清提交的文字，配对刷新保留草稿',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000});await boot(page,shimUrl,shim)
 await page.locator('#fd-tools-summary').click();await page.locator('[data-action="mail-toggle"]').click()
 const thread=page.locator('.fd-mail-thread:visible'),input=thread.locator('.fd-mail-input')
 await expect(input).toBeVisible();await expect(thread).toContainText('我给窗台上的花浇了水。')
 await thread.scrollIntoViewIfNeeded()
 await snapshot(page,'mail-reader-760')
 let pending:Route|undefined,calls=0,current=letters.slice()
 await page.route('**/v1/penpal/letters?**',r=>r.fulfill({json:{letters:current}}))
 await page.route('**/v1/penpal/letters',r=>{calls++;pending=r})
 await input.fill('这封已经准备好');await thread.locator('[data-action="mail-send"]').dblclick()
 await expect.poll(()=>calls).toBe(1);await input.fill('下一封还没有寄')
 current=[{id:'sent',direction:'out',plaintext:'这封已经准备好',created_at:new Date().toISOString()},...letters]
 await pending!.fulfill({json:{ok:true,letter_id:'sent'}})
 await expect(input).toHaveValue('下一封还没有寄');await expect(thread).toContainText('这封已经准备好')
 await page.route('**/v1/pair/accept',r=>r.fulfill({json:{ok:true,peer:{id:'new',name:'新朋友'}}}))
 await page.locator('#fd-connect-btn').click();await page.locator('#fd-pair-code').fill('123456')
 await page.locator('#fd-pair-accept').click()
 await expect(input).toHaveValue('下一封还没有寄')
})

test('信箱可以用键盘打开，回信输入有明确名称',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);await page.locator('#fd-tools-summary').click()
 const head=page.locator('.fd-mail-head');await head.focus();await page.keyboard.press('Enter')
 await expect(page.locator('.fd-mail-input')).toBeVisible()
 await expect(page.locator('.fd-mail-input')).toHaveAccessibleName('回信')
 await expect(head).toHaveAttribute('aria-expanded','true')
 await head.focus();await page.keyboard.press('Enter');await expect(head).toHaveAttribute('aria-expanded','false')
})

test('寄信等待中关闭，成功后重新打开不恢复已经寄出的正文',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);await page.locator('#fd-tools-summary').click();const head=page.locator('[data-action="mail-toggle"]')
 await head.click();let pending:Route|undefined
 await page.route('**/v1/penpal/letters',r=>{pending=r})
 await page.locator('.fd-mail-input').fill('只寄一次的内容');await page.locator('[data-action="mail-send"]').click()
 await expect.poll(()=>!!pending).toBe(true);await head.click();await pending!.fulfill({json:{ok:true,letter_id:'sent'}})
 await head.click();await expect(page.locator('.fd-mail-input')).toHaveValue('')
})

test('已知投递失败再次寄出重投同一封，普通读取失败可在信箱原地重试',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let reads=0,newSends=0,retries=0
 await page.route('**/v1/penpal/letters?**',r=>++reads===1?r.fulfill({status:503,json:{error:'temporary_unavailable'}}):r.fulfill({json:{letters}}))
 await page.route('**/v1/penpal/letters',r=>{newSends++;return r.fulfill({json:{ok:false,error:'send_failed',letter_id:'same-letter'}})})
 await page.route('**/v1/penpal/letters/resend',r=>{retries++;expect(r.request().postDataJSON()).toEqual({letter_id:'same-letter'});return r.fulfill({json:{ok:true}})})
 await page.locator('#fd-tools-summary').click();await page.locator('[data-action="mail-toggle"]').click()
 await page.locator('[data-action="mail-retry"]').click();await expect(page.locator('.fd-mail-input')).toBeVisible()
 await page.locator('.fd-mail-input').fill('留给阿柚的信');await page.locator('[data-action="mail-send"]').click()
 await expect(page.locator('.fd-mail-note')).toContainText('重试同一封')
 await page.locator('[data-action="mail-send"]').click();await expect(page.locator('.fd-mail-input')).toHaveValue('')
 expect(newSends).toBe(1);expect(retries).toBe(1)
})

test('配对生成单飞，离页后迟到码不落到新页面；六位码始终是主入口',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000});await boot(page,shimUrl,shim)
 let pending:Route|undefined,calls=0
 await page.route('**/v1/pair/start',r=>{calls++;pending=r})
 await page.locator('#fd-connect-btn').click();await page.locator('#fd-pair-start').dblclick()
 await expect.poll(()=>calls).toBe(1);await expect(page.locator('#fd-pair-start')).toBeDisabled()
 await clickNav(page,'overview');await pending!.fulfill({json:{ok:true,code:'654321',expiresAt:Date.now()+600000}})
 await clickNav(page,'a2a-agents');await page.locator('#fd-connect-btn').click()
 await expect(page.locator('#fd-pair-panel')).toBeHidden();await expect(page.locator('#fd-pair-start')).toBeEnabled()
 await page.locator('#fd-pair-start').click();await expect.poll(()=>calls).toBe(2)
 await pending!.fulfill({json:{ok:true,code:'654321',expiresAt:Date.now()+600000}})
 await expect(page.locator('.fd-pair-code')).toHaveText('654321')
 await expect(page.locator('#fd-pair-panel')).not.toContainText('wechat-cc')
 await page.locator('#fd-pair-panel').scrollIntoViewIfNeeded()
 await snapshot(page,'pair-code-760')
})

test('入站开关支持键盘，原生一次激活只更新一次',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let calls=0
 await page.route('**/v1/social/inbound',r=>{if(r.request().method()==='POST')calls++;return r.fulfill({json:{enabled:r.request().method()==='POST'?false:true}})})
 await page.locator('#fd-connect-btn').click();await page.locator('#fd-inbound-toggle').focus();await page.keyboard.press('Space')
 await expect(page.locator('#fd-inbound-toggle')).toHaveAttribute('aria-checked','false');expect(calls).toBe(1)
})

test('暂停等待中离页，迟到成功不重新读取隐藏的觅食页',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let pending:Route|undefined,reads=0
 await page.route('**/v1/a2a/list',r=>{reads++;return r.fulfill({json:{agents:[{id:'ayou',name:'阿柚的 CC',transport:'mailbox',relays:[],paused:false}]}})})
 await page.route('**/v1/a2a/pause',r=>{pending=r})
 const pause=page.locator('#a2a-agents-list [data-action="pause"]')
 await clickRevealed(page,'#a2a-agents-list [data-action="pause"]');await expect.poll(()=>!!pending).toBe(true)
 await clickNav(page,'overview');const before=reads
 const response=page.waitForResponse(r=>r.url().endsWith('/v1/a2a/pause'))
 await pending!.fulfill({json:{ok:true}});await (await response).finished()
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 expect(reads).toBe(before)
 await expect(page.locator('.dash-pane[data-pane="overview"]')).toBeVisible()
 await clickNav(page,'a2a-agents');await clickRevealed(page,'#fd-net-summary');await expect(pause).toBeEnabled()
})

test('手动预览用 Esc 关闭再重开，旧朋友的迟到资料不能替换新朋友',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let old:Route|undefined,previews=0
 await page.route('**/v1/a2a/preview',r=>{previews++;if(previews===1)old=r;else return r.fulfill({json:{name:'新朋友',description:'这是新朋友的 CC',capabilities:[]}})})
 await clickRevealed(page,'#a2a-add-btn');await page.locator('#a2a-add-form input[name="url"]').fill('https://old.example.com')
 await page.locator('#a2a-add-form button[type="submit"]').click();await expect.poll(()=>!!old).toBe(true)
 await page.keyboard.press('Escape');await clickRevealed(page,'#a2a-add-btn')
 await expect(page.locator('#a2a-add-form button[type="submit"]')).toBeEnabled()
 await page.locator('#a2a-add-form input[name="url"]').fill('https://new.example.com');await page.locator('#a2a-add-form button[type="submit"]').click()
 await expect(page.locator('#a2a-preview-name')).toHaveText('新朋友')
 const oldResponse=page.waitForResponse(response=>response.url().endsWith('/v1/a2a/preview')&&response.request().postDataJSON()?.url==='https://old.example.com')
 await old!.fulfill({json:{name:'旧朋友',description:'这份资料已过时',capabilities:[]}})
 await (await oldResponse).finished()
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 await expect(page.locator('#a2a-preview-name')).toHaveText('新朋友')
 await page.locator('#a2a-add-modal-close').click()
})

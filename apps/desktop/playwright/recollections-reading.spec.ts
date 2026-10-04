import {test,expect,clickNav} from './fixtures'
import {readFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'

const image='data:image/png;base64,'+readFileSync('src/assets/pet/cc-v1/canonical/lit/front.png').toString('base64')
const work={id:'painting-1',createdAt:'2026-10-03T12:00:00Z',caption:'秋天的一束光',image_data:image,width:512,height:512,rendererId:'fixture',impulse:{medium:'水彩'},background:{title:'秋天的一束光',origin:'阳光落在窗沿，CC 想把这一刻留下来。',approach:'用柔和的边缘和一点暖色记录安静的早晨。',kind:'test'},shareState:'private'}
const postcard={id:'postcard-1',ts:'2026-10-03T09:00:00Z',title:'去阿柚家坐了一会儿',note:'第一段，朋友家的窗户开着。\n第二段，茶已经泡好。\n第三段，我们聊了很久，回来时天色已经暗了。',favorite:0,image_svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="#e4ddd2"/><circle cx="155" cy="95" r="50" fill="#4f6b4f"/></svg>'}

async function boot(page:import('@playwright/test').Page,shimUrl:string,shim:any){
 await shim.invoke('demo.seed',{chat_id:'test_chat'})
 await page.route('**/v1/journal/postcards?**',r=>r.fulfill({json:{items:[postcard],total:1}}))
 await page.route('**/v1/atelier/works?**',r=>r.fulfill({json:{works:[work]}}))
 await page.route('**/v1/atelier/model-status',r=>r.fulfill({json:{mode:'private',status:{state:'ready'}}}))
 await page.goto(shimUrl)
 await page.waitForFunction(()=>document.documentElement.dataset.mode==='dashboard')
}

test('明信片正文打开完整阅读，收藏留在详情，关闭回到原来的入口',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);await clickNav(page,'recollections')
 const card=page.locator('.pc-card').first()
 await expect(card.locator('[data-pc-action="favorite"]')).toHaveCount(0)
 await card.locator('.pc-read').click()
 const reader=page.locator('dialog.cc-record-reader')
 await expect(reader).toBeVisible()
 await expect(reader).toContainText('第三段，我们聊了很久')
 await expect(reader.locator('[data-pc-action="favorite"]')).toBeVisible()
 await page.keyboard.press('Escape');await expect(reader).toHaveCount(0)
 await expect(card.locator('.pc-read')).toBeFocused()
})

test('回忆和画室点画都打开同一个完整作品详情，后台检查保留分享草稿',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);await clickNav(page,'recollections')
 await page.locator('[data-life-category="paintings"]').click()
 await page.locator('[data-atelier-open]').first().click()
 let reader=page.locator('dialog.cc-record-reader')
 await expect(reader).toContainText('用柔和的边缘和一点暖色')
 await expect(reader.locator('img')).toBeVisible()
 await page.keyboard.press('Escape')
 await clickNav(page,'atelier');await page.locator('#atelier-gallery [data-atelier-open]').first().click()
 reader=page.locator('dialog.cc-record-reader')
 await reader.locator('[data-atelier-share-open]').click()
 await reader.locator('[data-atelier-share-title]').fill('留给周末的光')
 // Real doctor poll interval: this previously rebuilt the visible gallery every 5s.
 await page.waitForTimeout(5500)
 await expect(reader.locator('[data-atelier-share-title]')).toHaveValue('留给周末的光')
 await expect(reader.locator('[data-atelier-share-title]')).toBeFocused()
 await page.keyboard.press('Escape')
 await expect(page.locator('#atelier-gallery [data-atelier-open]').first()).toBeFocused()
})

test('回忆分类只筛选内容，跳页另放；760px阅读没有横向溢出且正文16px',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000});await boot(page,shimUrl,shim)
 await clickNav(page,'recollections')
 await expect(page.locator('.cc-memory-tabs [data-life-pane]')).toHaveCount(0)
 await page.locator('.pc-read').first().click()
 const reader=page.locator('dialog.cc-record-reader')
 await expect(reader).toBeVisible()
 expect(await reader.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
 await expect(reader.locator('.pc-detail-note')).toHaveCSS('font-size','16px')
 const out=process.env.WECHAT_CC_LIFE_SHOTS
 if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,'postcard-narrow.png')})}
})

test('分享等待中关闭再打开不会重复发送，完成反馈落到当前作品',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim)
 let pending:import('@playwright/test').Route|undefined,calls=0
 await page.route('**/v1/atelier/share',r=>{calls++;pending=r})
 await clickNav(page,'atelier');await page.locator('#atelier-gallery [data-atelier-open]').click()
 let reader=page.locator('dialog.cc-record-reader')
 await reader.locator('[data-atelier-share-open]').click()
 await reader.locator('[data-atelier-share-send]').click()
 await expect.poll(()=>calls).toBe(1)
 await page.keyboard.press('Escape');await page.locator('#atelier-gallery [data-atelier-open]').click()
 reader=page.locator('dialog.cc-record-reader')
 await expect(reader.locator('[data-atelier-share-open]')).toBeDisabled()
 await pending!.fulfill({json:{ok:true}})
 await expect(reader.locator('[data-atelier-share-open]')).toHaveText('已分享')
 await expect(reader).toContainText('作品和手记已发到你的微信。')
 expect(calls).toBe(1)
})

test('迟到的收藏结果保留阅读位置，关闭后再打开的收藏按钮显示等待',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let pending:import('@playwright/test').Route|undefined
 await page.route('**/v1/journal/favorite',r=>{pending=r})
 await clickNav(page,'recollections');await page.locator('.pc-read').click()
 await page.locator('dialog [data-pc-action="favorite"]').click()
 await expect.poll(()=>!!pending).toBe(true)
 await page.keyboard.press('Escape');await page.locator('.pc-read').click()
 await expect(page.locator('dialog [data-pc-action="favorite"]')).toBeDisabled()
 await page.keyboard.press('Escape');await pending!.fulfill({json:{ok:true}})
 await expect(page.locator('.pc-favorite-indicator')).toHaveText('已收藏')
 await expect(page.locator('.pc-read')).toBeFocused()
})

test('完整作品能离线保存，包含图片和手记；正文及操作在1440px清楚可读',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:1440,height:1000});await boot(page,shimUrl,shim)
 await clickNav(page,'atelier');await page.locator('#atelier-gallery [data-atelier-open]').click()
 const reader=page.locator('dialog.cc-record-reader')
 await reader.locator('[data-atelier-share-open]').click()
 await reader.locator('[data-atelier-share-cancel]').click()
 await expect(reader.locator('[data-atelier-share-open]')).toBeFocused()
 await expect(reader.locator('.atelier-story>p').first()).toHaveCSS('font-size','16px')
 // Exercise the browser download branch without sending a native save to the real Downloads folder.
 await page.evaluate(()=>{(window as any).__TAURI__.core.invoke=undefined})
 const download=page.waitForEvent('download')
 await reader.locator('[data-atelier-save]').click()
 const file=await download
 const contents=readFileSync((await file.path())!,'utf8')
 expect(contents).toContain(image);expect(contents).toContain(work.background.origin);expect(contents).toContain(work.background.approach)
 await expect(reader.locator('[data-atelier-save-status]')).toContainText('已保存')
 const out=process.env.WECHAT_CC_LIFE_SHOTS
 if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,'painting-wide.png')});await file.saveAs(join(out,'CC-作品与手记.html'))}
})

test('收藏失败能在原详情重试，不会显示已收藏',async({page,shimUrl,shim})=>{
 await boot(page,shimUrl,shim);let attempts=0
 await page.route('**/v1/journal/favorite',r=>r.fulfill({json:{ok:++attempts>1}}))
 await clickNav(page,'recollections');await page.locator('.pc-read').click()
 const button=page.locator('dialog [data-pc-action="favorite"]')
 await button.click();await expect(button).toBeEnabled();await expect(button).toHaveAttribute('aria-pressed','false')
 await button.click();await expect(button).toHaveAttribute('aria-pressed','true');expect(attempts).toBe(2)
})

test('画室空态提供实际设置入口，读取失败可以恢复，站外图片不加载',async({page,shimUrl,shim})=>{
 await page.setViewportSize({width:760,height:1000});await boot(page,shimUrl,shim)
 let mode:'empty'|'broken'|'loaded'='empty',external=0
 await page.route('**/v1/atelier/works?**',r=>r.fulfill({json:mode==='empty'?{works:[]}:mode==='broken'?{works:{bad:true}}:{works:[{...work,image_data:'https://tracking.invalid/pixel'}]}}))
 await page.route('**/v1/atelier/model-status',r=>r.fulfill({json:{mode:'off',status:{state:'ready'}}}))
 await page.route('https://tracking.invalid/**',r=>{external++;return r.abort()})
 await clickNav(page,'atelier');await expect(page.locator('#atelier-gallery')).toContainText('画室尚未开启')
 await page.locator('[data-atelier-status-action="home"]').click();await expect(page.locator('#settings-drawer')).toHaveClass(/is-open/)
 await page.locator('#settings-close').click()
 mode='broken';await page.locator('#atelier-refresh').click();await expect(page.locator('#atelier-gallery')).toContainText('暂时无法确认')
 mode='loaded';await page.locator('[data-atelier-status-action="retry"]').click();await page.locator('#atelier-gallery [data-atelier-open]').click()
 await expect(page.locator('dialog.cc-record-reader')).toContainText('图片暂时无法显示')
 expect(external).toBe(0)
})

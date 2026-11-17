import { expect, type Page } from '@playwright/test'
export const rosterItem=(id:string,title:string,extra:Record<string,unknown>={})=>({key:`matter:${id}`,kind:'matter',id,title,group:'waiting',status:'waiting',agents:[{id:'codex',name:'Codex',current:true}],quiet:false,updatedAt:2,unseen:false,waiting:{kind:'permission',requestId:'p1',summary:'需要读取备份文件夹',count:1},...extra})
export async function routeRoster(page:Page,items:ReturnType<typeof rosterItem>[]) {
 await page.route('**/v1/roster',route=>route.fulfill({json:{items,version:JSON.stringify(items)}}))
}
/** 窄窗口把名单滑层打开;宽窗口名单常驻,什么都不做。
 * 先等应用退出「加载中」(那时 .dashboard 是 display:none,isVisible 全是 false,会误判成宽窗口而不点)。 */
export async function showRoster(page:Page) {
 await expect(page.locator('main.dashboard')).toBeVisible()
 const toggle=page.locator('#topbar-roster')
 if(!await toggle.isVisible())return
 if(await page.locator('#roster-aside').isHidden())await toggle.click()
 await expect(toggle).toHaveAttribute('aria-expanded','true')
 await expect(page.locator('#roster-aside')).toBeVisible()
}

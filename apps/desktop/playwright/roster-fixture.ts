import type { Page } from '@playwright/test'
export const rosterItem=(id:string,title:string,extra:Record<string,unknown>={})=>({key:`matter:${id}`,kind:'matter',id,title,group:'waiting',status:'waiting',agents:[{id:'codex',name:'Codex',current:true}],quiet:false,updatedAt:2,unseen:false,waiting:{kind:'permission',requestId:'p1',summary:'需要读取备份文件夹',count:1},...extra})
export async function routeRoster(page:Page,items:ReturnType<typeof rosterItem>[]) {
 await page.route('**/v1/roster',route=>route.fulfill({json:{items,version:JSON.stringify(items)}}))
}
export async function showRoster(page:Page) {
 if(await page.locator('#topbar-roster').isVisible()&&await page.locator('#roster-aside').isHidden())await page.locator('#topbar-roster').click()
}

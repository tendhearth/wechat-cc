import { createHash } from 'node:crypto'
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

// ── 「地方」(正面上半,2026-11-18):名单的列表已由它代替,打开一件事从这里的「去回答」进 ──
const hex16=(s:string)=>[...new TextEncoder().encode(s)].map(b=>b.toString(16).padStart(2,'0')).join('').padEnd(16,'0').slice(0,16)
export const placeItem=(name:string,extra:Record<string,unknown>={})=>({key:`p:${hex16(name)}`,name,line:`${name} 的事`,status:'working',waiting:null,moving:true,unseen:false,updatedAt:2,matterIds:[],messageIds:[],sessionIds:[],...extra})
/** 等你回答的一件事(「去回答」打开它)。 */
export const askingPlace=(name:string,matterId:string,summary='要你回答一个问题',extra:Record<string,unknown>={})=>placeItem(name,{status:'waiting',moving:false,line:summary,matterIds:[matterId],waiting:{itemKey:`matter:${matterId}`,kind:'question',matterId,requestId:'q1',summary,count:1},...extra})
/** 终端会话自己停着问(「去回答」打开那个会话)。 */
export const terminalPlace=(name:string,sessionId:string,summary:string,extra:Record<string,unknown>={})=>placeItem(name,{status:'waiting',moving:false,line:summary,sessionIds:[sessionId],waiting:{itemKey:`terminal:${sessionId}`,kind:'terminal',sessionId,summary,count:1},...extra})
type PlacesSource=ReturnType<typeof placeItem>[]|(()=>ReturnType<typeof placeItem>[]|{status:number})
export async function routePlaces(page:Page,places:PlacesSource, { writable = false, placeMap = () => false } = {}) {
 const hiddenKeys = new Set<string>()
 if (writable) await page.route('**/v1/places/hide', route => {
  const body = route.request().postDataJSON()
  if (route.request().method() !== 'POST' || !body || Object.keys(body).length !== 2
    || typeof body.key !== 'string' || !/^p:[a-f0-9]{16}$/.test(body.key) || typeof body.hidden !== 'boolean') {
   return route.fulfill({ status: 400, json: { error: 'invalid' } })
  }
  const value = typeof places === 'function' ? places() : places
  if (!Array.isArray(value)) return route.fulfill({ status: 503, json: { error: 'unavailable' } })
  if (!value.some(p => p.key === body.key)) return route.fulfill({ status: 404, json: { error: 'not_found' } })
  if (body.hidden) hiddenKeys.add(body.key)
  else hiddenKeys.delete(body.key)
  return route.fulfill({ json: { ok: true } })
 })
 await page.route('**/v1/places',route=>{
  const value=typeof places==='function'?places():places
  if(!Array.isArray(value))return route.fulfill({status:value.status,json:{error:'unavailable'}})
  const hidden = value.filter(p => hiddenKeys.has(p.key) && !p.waiting).map(({ key, name }) => ({ key, name }))
  const payload = {
   ...(writable ? { places: value.filter(p => !hiddenKeys.has(p.key) || p.waiting), hidden } : { places: value }),
   ...(placeMap() ? { labs: { placeMap: true } } : {}),
  }
  const version=createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,16)
  const headers={etag:version}
  if(route.request().headers()['if-none-match']===version)return route.fulfill({status:304,headers})
  return route.fulfill({json:{...payload,version},headers})
 })
}
export const placeRow=(page:Page,name:string)=>page.locator('#places-root .place').filter({has:page.locator('.place-name',{hasText:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`)})})
/** 应答入口随窗口宽度在地方行或置顶卡片。 */
export function placeAnswerSurface(page: Page, name: string) {
 const key = placeItem(name).key
 return page.locator(`[data-place-key="${key}"]:is(.place, .desk-waiting-card)`).filter({ has: page.locator('.place-ask') })
}

export async function answerPlace(page:Page,name:string) {
 await expect(page.locator('main.dashboard')).toBeVisible()
 const button=placeAnswerSurface(page,name).locator('[data-place-open]')
 await expect(button).toBeVisible()
 await button.click()
}

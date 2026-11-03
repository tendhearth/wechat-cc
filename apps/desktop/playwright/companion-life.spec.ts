import {test,expect} from './fixtures'
import type {Page} from '@playwright/test'

async function entry(page:Page,shimUrl:string){
  await page.route('**/__dev_reload.js',r=>r.fulfill({contentType:'application/javascript',body:''}))
  await page.addInitScript(()=>{
    Math.random=()=>0
    ;(window as any).__lifeCommands=[]
    ;(window as any).__TAURI__={core:{invoke:async(command:string,args:any)=>{
      ;(window as any).__lifeCommands.push({command,args})
      if(command==='companion_motion_context')return {token:1,minOffset:-48,maxOffset:48}
      if(['step_companion_motion','stop_companion_motion'].includes(command))return null
      const response=await fetch('/__invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})
      const value=await response.json();if(value.error)throw Error(value.error);return value.result
    }}}
  })
  await page.goto(new URL('companion-window.html?lab',shimUrl).href)
  await expect(page.locator('#pet-stage')).toHaveAttribute('aria-label','CC，已连接')
  await page.mouse.move(-10,-10)
}
async function calm(page:Page){
  await page.route('**/v1/companion/presence',r=>r.fulfill({json:{presence:'ok',activity:{kind:'idle',label:'',since:null},news:{unread:0,latest_kind:null,latest_title:null}}}))
  await page.route('**/v1/companion/pet',r=>r.fulfill({json:{owner_last_contact_at:null,last_done_at:null,turn:{phase:'idle',since:null},pending_permissions:[],activities:[]}}))
}

for(const authored of [true,false])test(`idle CC visibly peeks, stops for nearby controls and wakes from a calm doze (${authored?'authored':'fallback'})`,async({page,shimUrl,shim})=>{
  if(!authored)await page.route('**/assets/pet/cc-v1/manifest.json',async route=>{
    const response=await route.fetch(),kit=await response.json()
    for(const form of ['lit','unlit'])for(const name of Object.keys(kit.forms[form].states))if(name.startsWith('life-'))delete kit.forms[form].states[name]
    delete kit.performance
    await route.fulfill({response,json:kit})
  })
  await shim.invoke('demo.seed',{});await calm(page);await page.clock.install();await entry(page,shimUrl)
  const stage=page.locator('#pet-stage'),body=page.locator('#pet-body')
  await expect(stage).toHaveAttribute('data-pet-action','still')
  await page.clock.runFor(20_100);await expect(stage).toHaveAttribute('data-pet-action','peek')
  if(authored){
    await expect(body).toHaveAttribute('data-pet-performance','true')
    await expect(body).toHaveCSS('transform','none')
    await expect(body).toHaveCSS('animation-name','none')
    const img=page.locator('#pet-sprite')
    await expect(img).toHaveAttribute('src',/\/performance\/lit\/peek\//)
    await expect(img).toHaveJSProperty('complete',true)
    await expect(img).toHaveJSProperty('naturalWidth',512)
    const before=await img.screenshot(),first=await img.getAttribute('src')
    await page.clock.runFor(250)
    await expect(img).not.toHaveAttribute('src',first!)
    await expect(img).toHaveJSProperty('complete',true)
    expect(before.equals(await img.screenshot())).toBe(false)
  }else{
    await expect(body).toHaveAttribute('data-pet-performance','false')
    await expect(body).not.toHaveCSS('transform','none')
  }
  await page.screenshot({path:'.superpowers/cc-life-peek.png'})
  await page.locator('.pet-controls').dispatchEvent('pointerenter')
  await expect(stage).toHaveAttribute('data-pet-action','still')
  await page.locator('.pet-shell').dispatchEvent('pointerleave')
  await page.clock.runFor(180_000);await expect(stage).toHaveAttribute('data-pet-action','doze')
  expect(await page.evaluate(()=>(window as any).__pet.machine.snapshot().form)).toBe('lit')
  await page.screenshot({path:'.superpowers/cc-life-doze.png'})
  await page.locator('.pet-shell').dispatchEvent('pointerenter')
  await expect(stage).toHaveAttribute('data-pet-action','wake')
  await page.clock.runFor(801);await expect(stage).toHaveAttribute('data-pet-action','still')
})

test('the original CC visibly prepares work, puts it away, and immediately yields celebration to permission',async({page,shimUrl,shim})=>{
  await shim.invoke('demo.seed',{});await calm(page);await page.clock.install();await entry(page,shimUrl)
  const stage=page.locator('#pet-stage')
  await page.evaluate(()=>(window as any).__pet.setState('working'))
  await expect(stage).toHaveAttribute('data-pet-action','work-enter')
  await page.clock.runFor(175)
  await expect(page.locator('#pet-body')).not.toHaveCSS('transform','none')
  await page.screenshot({path:'.superpowers/cc-life-work-enter.png'})
  await page.clock.runFor(175);await expect(stage).toHaveAttribute('data-pet-action','work')
  await page.evaluate(()=>(window as any).__pet.setState('done'))
  await expect(stage).toHaveAttribute('data-pet-action','work-exit')
  await page.clock.runFor(301);await expect(stage).toHaveAttribute('data-pet-action','celebrate')
  await page.evaluate(()=>(window as any).__pet.setState('permission'))
  await expect(stage).toHaveAttribute('data-pet-action','still')
  await expect(page.locator('[data-prop="exclamation"]')).toBeVisible()
  await page.emulateMedia({reducedMotion:'reduce'})
  await expect(page.locator('#pet-body')).toHaveCSS('transform','none')
  expect(await page.evaluate(()=>(window as any).__pet.machine.snapshot().behavior)).toBe('permission')
})

test('completion of another task never closes the computer or celebrates over the active task',async({page,shimUrl,shim})=>{
  await shim.invoke('demo.seed',{})
  let done:string|null=null
  await page.route('**/v1/companion/presence',r=>r.fulfill({json:{presence:'ok',activity:{kind:'idle',label:'',since:null},news:{unread:0,latest_kind:null,latest_title:null}}}))
  await page.route('**/v1/companion/pet',r=>r.fulfill({json:{owner_last_contact_at:null,last_done_at:done,turn:{phase:'idle',since:null},pending_permissions:[],activities:[{taskId:'deadbeef',title:'还在执行的任务',phase:'working',detail:null,updatedAt:1}]}}))
  // Unlike the calm fixture, this page has a concrete task label.
  await page.route('**/__dev_reload.js',r=>r.fulfill({contentType:'application/javascript',body:''}))
  await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(command:string,args:any)=>{const r=await fetch('/__invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});return (await r.json()).result}}}})
  await page.goto(new URL('companion-window.html?lab',shimUrl).href)
  await expect(page.locator('#pet-task-primary')).toContainText('还在执行的任务')
  await expect(page.locator('#pet-stage')).toHaveAttribute('data-pet-action','work')
  await page.evaluate(()=>{(window as any).__lifeObserved=[];new MutationObserver(()=>{(window as any).__lifeObserved.push(document.getElementById('pet-stage')!.getAttribute('data-pet-action'))}).observe(document.getElementById('pet-stage')!,{attributes:true,attributeFilter:['data-pet-action']})})
  done='2026-11-02T12:00:00Z'
  await page.waitForResponse('**/v1/companion/pet')
  await expect(page.locator('#pet-stage')).toHaveAttribute('data-pet-action','work')
  expect(await page.evaluate(()=>(window as any).__lifeObserved)).not.toContain('celebrate')
  expect(await page.evaluate(()=>(window as any).__lifeObserved)).not.toContain('work-exit')
})

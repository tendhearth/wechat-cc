import {test,expect} from './fixtures'
import type {Page,Request} from '@playwright/test'

// Screenshots use real time, while the idle director uses page timers. Keep
// that clock paused between steps, and let real HTTP polling settle before
// advancing again; one 3-minute jump can outrun its asynchronous responses.
async function idleClock(page:Page){
  const pending=new Set<Request>(),failed:string[]=[]
  const isPoll=(request:Request)=>['/v1/companion/presence','/v1/companion/pet'].includes(new URL(request.url()).pathname)
  page.on('request',request=>{if(isPoll(request))pending.add(request)})
  page.on('requestfinished',request=>pending.delete(request))
  page.on('requestfailed',request=>{if(isPoll(request)){pending.delete(request);failed.push(`${request.url()}: ${request.failure()?.errorText}`)}})
  const anchor=Date.parse('2026-11-03T00:00:00Z')
  await page.clock.install({time:new Date(anchor-60_000)})
  await page.clock.pauseAt(anchor)
  await page.addInitScript(()=>{
    const trace:any[]=[];(window as any).__idleTrace=trace
    const note=(event:string,detail:unknown)=>{trace.push({at:Date.now(),event,detail,hidden:document.hidden,snapshot:(window as any).__pet?.machine.snapshot()});if(trace.length>300)trace.shift()}
    document.addEventListener('DOMContentLoaded',()=>{
      const stage=document.getElementById('pet-stage')
      if(stage)new MutationObserver(records=>{for(const record of records)note(record.attributeName!,{before:record.oldValue,after:stage.getAttribute(record.attributeName!)})}).observe(stage,{attributes:true,attributeOldValue:true,attributeFilter:['data-pet-action','aria-label']})
      for(const event of ['pointerenter','pointerleave','focusin','focusout','visibilitychange'])document.addEventListener(event,e=>note(event,(e.target as Element)?.className),true)
      window.addEventListener('blur',()=>note('window-blur',null))
    })
  })
  return async(ms:number)=>{
    for(let left=ms;left>0;){
      const step=Math.min(1000,left)
      await page.clock.runFor(step)
      await expect.poll(()=>pending.size,{message:'Idle polling must settle before the next clock step'}).toBe(0)
      expect(failed,'Idle fixture polling must remain connected').toEqual([])
      await page.evaluate(async()=>{await Promise.resolve();await Promise.resolve()})
      left-=step
    }
  }
}

test.afterEach(async({page},info)=>{
  if(info.status!==info.expectedStatus){
    const trace=await page.evaluate(()=>(window as any).__idleTrace??[]).catch(()=>[])
    await info.attach('idle-timeline',{body:JSON.stringify(trace,null,2),contentType:'application/json'})
  }
})

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
  await shim.invoke('demo.seed',{});await calm(page);const advance=await idleClock(page);await entry(page,shimUrl)
  const stage=page.locator('#pet-stage'),body=page.locator('#pet-body')
  await expect(stage).toHaveAttribute('data-pet-action','still')
  await advance(20_100);await expect(stage).toHaveAttribute('data-pet-action','peek')
  if(authored){
    await expect(body).toHaveAttribute('data-pet-performance','true')
    await expect(body).toHaveCSS('transform','none')
    await expect(body).toHaveCSS('animation-name','none')
    const img=page.locator('#pet-sprite')
    await expect(img).toHaveAttribute('src',/\/performance\/lit\/peek\//)
    await expect(img).toHaveJSProperty('complete',true)
    await expect(img).toHaveJSProperty('naturalWidth',512)
    const before=await img.screenshot(),first=await img.getAttribute('src')
    await advance(250)
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
  await advance(180_000);await expect(stage).toHaveAttribute('data-pet-action','doze')
  expect(await page.evaluate(()=>(window as any).__pet.machine.snapshot().form)).toBe('lit')
  await page.screenshot({path:'.superpowers/cc-life-doze.png'})
  await page.locator('.pet-shell').dispatchEvent('pointerenter')
  await expect(stage).toHaveAttribute('data-pet-action','wake')
  await advance(801);await expect(stage).toHaveAttribute('data-pet-action','still')
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

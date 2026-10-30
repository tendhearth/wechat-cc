// Dedicated Mini integration: offline artifacts + headless DOM, never OS input.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { propRect, SCENES } from './build-cc-composition-studies.mjs'
const require=createRequire(import.meta.url),{chromium}=require(process.env.CC_PLAYWRIGHT_MODULE||'playwright')
const desktop=fileURLToPath(new URL('../',import.meta.url)),base=join(desktop,'art/cc-v1/studies')
assert.equal(process.platform,'darwin');assert.equal(process.env.HOME,'/Users/home')
const browser=await chromium.launch({headless:true,executablePath:process.env.CC_CHROMIUM_EXECUTABLE_PATH,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']})
const results={offline:true,headless:true,osInput:false,geometry:[],viewers:[]},errors=[],external=[]
try{
  const context=await browser.newContext({viewport:{width:1024,height:900}})
  await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('file:')||url.startsWith('data:'))return route.continue();external.push(url);return route.abort()})
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
  for(const [folder,count] of [['turnarounds-r2-review',1],['compositions-r2',5]]){
    await page.goto(pathToFileURL(join(base,folder,'index.html')).href)
    assert.equal(await page.locator('section').count(),count)
    await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0))
    const first=page.locator('section').first(),button=first.locator('button'),image=first.locator('img')
    await page.emulateMedia({reducedMotion:'reduce'});const initial=await image.getAttribute('data-frame');await button.click();await page.waitForTimeout(200);assert.notEqual(await first.getAttribute('data-playing'),'true');assert.equal(await image.getAttribute('data-frame'),initial);await page.emulateMedia({reducedMotion:'no-preference'})
    await button.click();await page.waitForFunction(()=>document.querySelector('section').dataset.playing==='true')
    await page.waitForFunction(()=>document.querySelector('section img').dataset.frame!=='0')
    await button.click();const frame=await image.getAttribute('data-frame');await page.waitForTimeout(200);assert.equal(await image.getAttribute('data-frame'),frame)
    await button.click();await page.waitForFunction(()=>document.querySelector('section').dataset.playing==='true');await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('section').dataset.playing==='false');await page.emulateMedia({reducedMotion:'no-preference'})
    await button.click();await page.waitForFunction(()=>document.querySelector('section').dataset.playing==='true');await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))});assert.equal(await first.getAttribute('data-playing'),'false');await page.evaluate(()=>delete document.hidden)
    if(folder.startsWith('turnarounds')){
      assert.equal(await first.locator('option').count(),20)
      await first.locator('select').selectOption('19');assert.equal(await image.getAttribute('data-frame'),'19')
      await page.waitForTimeout(200);assert.equal(await image.getAttribute('data-frame'),'19')
    }else{
      const summary=JSON.parse(await readFile(join(base,folder,'summary.json')))
      for(const scene of summary.scenes){const card=page.locator(`[data-clip="${scene.id}"]`);await card.locator('button').click();await page.waitForFunction(id=>document.querySelector(`[data-clip="${id}"]`).dataset.playing==='true',scene.id);if(!scene.loop){await page.waitForFunction(id=>document.querySelector(`[data-clip="${id}"]`).dataset.playing==='false',scene.id);assert.equal(Number(await card.locator('img').getAttribute('data-frame')),scene.frameCount-1)}else await card.locator('button').click()}
    }
    results.viewers.push({folder,cards:count,decoded:true,playPauseReplay:true,reducedMotionPause:true,syntheticVisibilityPause:true})
  }
  // Real renderer and actual CSS: compare its DOM boxes with compositor math.
  const css=await readFile(join(desktop,'src/companion-window.css'),'utf8')
  await page.setContent(`<style>${css}</style><div id="stage" style="position:relative;--pet-side:128px;--pet-origin-x:64px;--pet-origin-y:117.5px"></div>`)
  await page.addScriptTag({type:'module',content:(await readFile(join(desktop,'src/pet/renderer/prop-layer.js'),'utf8')).replace("import { isProp } from '../domain/types.js'",'const isProp = name => Object.hasOwn(PROP_SLOTS,name)')+'\nwindow.ccRenderProps=renderProps;'})
  await page.waitForFunction(()=>typeof window.ccRenderProps==='function')
  for(const size of [48,96,128,256]){
    const boxes=await page.evaluate(({size,props})=>{
      const stage=document.querySelector('#stage');stage.style.width=stage.style.height=size+'px';stage.style.setProperty('--pet-side',size+'px');stage.style.setProperty('--pet-origin-x',size/2+'px');stage.style.setProperty('--pet-origin-y',size*470/512+'px')
      window.ccRenderProps(stage,props,0,{props:Object.fromEntries(props.map(n=>[n,'data:image/png;base64,']))},tag=>document.createElement(tag))
      const origin=stage.getBoundingClientRect();return [...stage.children].map(el=>{const r=el.getBoundingClientRect();return {name:el.dataset.prop,left:r.left-origin.left,top:r.top-origin.top,width:r.width,height:r.height,badges:el.querySelectorAll('.pet-badge').length}})
    },{size,props:[...new Set(SCENES.flatMap(s=>s.props))]})
    for(const actual of boxes){const expected=propRect(actual.name,size);for(const key of ['left','top','width','height'])assert.ok(Math.abs(actual[key]-expected[key])<.04,`${actual.name}/${size}/${key}`);assert.equal(actual.badges,0)}
    results.geometry.push({size,propCount:boxes.length,maxErrorPx:Math.max(...boxes.flatMap(a=>Object.keys(propRect(a.name,size)).map(k=>Math.abs(a[k]-propRect(a.name,size)[k]))))})
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);results.pageErrors=errors;results.externalRequests=external;results.ok=true
  await writeFile(process.argv[2],JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results))
}finally{await browser.close()}

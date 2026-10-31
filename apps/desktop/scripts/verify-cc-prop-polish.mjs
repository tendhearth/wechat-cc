// Real source modules and CSS in a headless Mini browser; no OS input APIs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMiniIdentity } from './macmini-ui-protocol.mjs'
import { within } from './validate-cc-turnaround-studies.mjs'
import { propRect } from './build-cc-composition-studies.mjs'

assertMiniIdentity({computerName:execFileSync('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8'}).trim(),homeDir:homedir(),platformName:process.platform})
const desktop=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url)
const {chromium}=require(process.env.CC_PLAYWRIGHT_MODULE),origin='http://127.0.0.1:4273'
const qaModule=`import {createPet} from '/src/pet/pet.js';import {loadManifest} from '/src/pet/assets/manifest-loader.js';import {createPropRenderer} from '/src/pet/renderer/prop-layer.js';
const loaded=await loadManifest('/src/assets/pet/cc-v1/manifest.json'),stage=document.querySelector('#stage'),props=document.querySelector('#props'),direct=document.querySelector('#direct');
const schedule=(f,ms)=>setTimeout(f,ms),cancel=id=>clearTimeout(id),makeEl=tag=>document.createElement(tag);
const renderer=createPropRenderer({container:direct,manifest:loaded.manifest,makeEl,schedule,cancel});
const pet=await createPet({stage,img:document.querySelector('#sprite'),props},{manifestUrl:'/src/assets/pet/cc-v1/manifest.json',random:()=>0});
window.qa={pet,renderer,stage,props,direct};`
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin)
    if(url.pathname==='/qa.html'){
      const now=url.searchParams.get('surface')==='now'
      res.setHeader('content-type','text/html');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")
      return res.end(`<!doctype html><link rel="stylesheet" href="/src/${now?'cc-now':'companion-window'}.css"><div class="${now?'now-figure':''}"><div id="stage" class="${now?'now-pet-stage':'pet-stage'}" style="position:relative;width:256px;height:256px;--pet-side:256px;--pet-origin-x:128px;--pet-origin-y:235px"><img id="sprite"><div id="props" style="position:absolute;inset:0"></div><div id="direct" style="position:absolute;inset:0"></div></div></div><script type="module" src="/qa.mjs"></script>`)
    }
    if(url.pathname==='/qa.mjs'){res.setHeader('content-type','text/javascript');return res.end(qaModule)}
    const path=await realpath(resolve(desktop,'.'+decodeURIComponent(url.pathname)))
    if(!within(desktop,path))throw Error('outside source root')
    res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.woff2':'font/woff2'})[extname(path)]??'application/octet-stream')
    res.end(await readFile(path))
  }catch{res.statusCode=404;res.end('Not found')}
})
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(4273,'127.0.0.1',ok)})
let browser
const report={osInput:false,offline:true,surfaces:[],externalRequests:[],pageErrors:[]}
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CC_CHROMIUM_EXECUTABLE_PATH,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']})
  const context=await browser.newContext({viewport:{width:900,height:900},reducedMotion:'no-preference'})
  await context.route('**/*',route=>{if(route.request().url().startsWith(origin+'/')||route.request().url().startsWith('data:'))return route.continue();report.externalRequests.push(route.request().url());return route.abort()})
  const page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message))
  for(const surface of ['companion','now']){
    await page.goto(origin+'/qa.html?surface='+surface);await page.waitForFunction(()=>Boolean(window.qa))
    await page.evaluate(()=>window.qa.renderer.render(['laptop'],0))
    await page.waitForTimeout(55)
    const entrance=await page.locator('#direct [data-prop=laptop]').evaluate(node=>Number(getComputedStyle(node).opacity))
    assert(entrance>0&&entrance<1,`${surface}: actual CSS entrance did not animate: ${entrance}`)
    await page.waitForTimeout(180)
    await page.evaluate(()=>window.qa.renderer.render([],0));await page.waitForTimeout(50)
    const leaving=await page.locator('#direct [data-prop=laptop]').evaluate(node=>Number(getComputedStyle(node).opacity))
    assert(leaving>0&&leaving<1,`${surface}: actual CSS exit did not animate`)
    await page.evaluate(()=>window.qa.renderer.render(['laptop'],0));await page.waitForTimeout(190)
    assert.equal(await page.locator('#direct [data-prop=laptop]').count(),1)
    assert.equal(await page.locator('#direct [data-prop=laptop]').getAttribute('data-prop-leaving'),'false')
    await page.evaluate(()=>window.qa.renderer.render(['envelope'],3));await page.waitForTimeout(200)
    assert.equal(await page.evaluate(()=>{window.savedEnvelope=window.qa.direct.querySelector('[data-prop=envelope]');window.savedImage=window.savedEnvelope.querySelector('img');window.qa.renderer.render(['envelope'],4);return window.savedEnvelope===window.qa.direct.querySelector('[data-prop=envelope]')&&window.savedImage===window.savedEnvelope.querySelector('img')&&window.savedEnvelope.querySelector('.pet-badge').textContent==='4'}),true)
    await page.evaluate(()=>{window.qa.renderer.render([],0);window.qa.renderer.setMotionSuppressed(true)})
    assert.equal(await page.locator('#direct .pet-prop').count(),0)
    const geometry=[]
    for(const size of [48,96,128,256]){
      const actual=await page.evaluate(size=>{const {stage,renderer,direct}=window.qa;stage.style.width=stage.style.height=size+'px';stage.style.setProperty('--pet-side',size+'px');stage.style.setProperty('--pet-origin-x',size/2+'px');stage.style.setProperty('--pet-origin-y',size*470/512+'px');renderer.render(['laptop'],0);const a=stage.getBoundingClientRect(),b=direct.querySelector('[data-prop=laptop]').getBoundingClientRect();return {left:b.left-a.left,top:b.top-a.top,width:b.width,height:b.height}},size)
      for(const key of Object.keys(actual))assert(Math.abs(actual[key]-propRect('laptop',size)[key])<.04,`${surface}/${size}/${key}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(propRect('laptop',size))}`)
      geometry.push(size)
    }
    await page.evaluate(()=>{window.qa.renderer.destroy();window.qa.pet.setForm('lit')})
    await page.waitForFunction(()=>window.qa.pet.machine.snapshot().form==='lit'&&!window.qa.pet.machine.snapshot().transition)
    await page.evaluate(()=>window.qa.pet.setState('thinking'))
    assert.deepEqual(await page.locator('#props [data-prop-leaving=false]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-prop'))),['thought-bubble','mug'])
    await page.evaluate(()=>window.qa.pet.applyIntent({form:'lit',behavior:'permission',props:['envelope'],badge:5,hint:null,oneShots:[]}))
    await page.waitForTimeout(200)
    assert.deepEqual(await page.locator('#props [data-prop-leaving=false]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-prop'))),['envelope','exclamation'])
    assert.equal(await page.locator('#props .pet-badge').textContent(),'5')
    await page.evaluate(()=>{window.qa.pet.setProps([],0);window.qa.pet.setState('idle');window.qa.pet.setState('receive');window.qa.pet.setState('working')})
    assert.equal(await page.evaluate(()=>window.qa.pet.machine.snapshot().behavior),'receive')
    assert.equal(await page.locator('#props [data-prop=laptop][data-prop-leaving=false]').count(),0)
    await page.waitForFunction(()=>window.qa.pet.machine.snapshot().behavior==='working')
    assert.equal(await page.locator('#props [data-prop=laptop][data-prop-leaving=false]').count(),1)
    for(const control of ['setPaused','setReducedMotion']){
      const restored=await page.evaluate(control=>{const {pet}=window.qa;pet.setProps(['micro-light','envelope'],2);pet[control](true);pet.setProps(['micro-light','envelope'],7);pet[control](false);return {props:pet.machine.snapshot().props,badge:pet.machine.snapshot().badge,light:document.querySelectorAll('#props [data-prop=micro-light]').length}},control)
      assert.deepEqual(restored,{props:['envelope'],badge:7,light:0},`${surface}: old light survived ${control}`)
    }
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.evaluate(()=>{window.qa.pet.setReducedMotion(true);window.qa.pet.setProps([],0);window.qa.pet.setState('thinking')})
    assert.equal(await page.locator('#props [data-prop-leaving=true]').count(),0)
    assert.equal(await page.locator('#props [data-prop=mug]').evaluate(node=>getComputedStyle(node).transitionDuration),'0s')
    await page.evaluate(()=>{window.qa.pet.setQuiet(true);window.qa.pet.setPaused(true);window.qa.pet.destroy()})
    assert.equal(await page.locator('#props .pet-prop').count(),0)
    await page.emulateMedia({reducedMotion:'no-preference'})
    report.surfaces.push({surface,entranceOpacity:entrance,exitOpacity:leaving,keyedReentry:true,badgeIdentity:true,geometry,actualBehaviorRecipes:true,queuedWorking:true,oldLightConsumedOnResume:true,reducedMotion:true,destroy:true})
  }
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.pageErrors,[]);report.ok=true
  await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}

import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const source=fileURLToPath(new URL('../src/',import.meta.url))
import {rich} from './reading-fixture'
const fixture=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"><style>body{margin:0;padding:16px}section{min-width:0;max-width:100%;margin-bottom:30px}#converse-root{height:650px;display:flex;flex-direction:column;overflow:hidden}.wb-history-body{max-height:none}</style><body><div id="converse-root"></div><section id="task"></section><section id="history"></section><section id="dialogue"></section><section id="markdown-file"></section><section id="plain-file" class="wb-input-preview-body"></section><script type="module">
import {initConversePage} from '/modules/converse.js';import {renderMessageFor,renderWorkbenchArtifactText} from '/modules/workbench.js';import {renderHistoryPanel} from '/modules/workbench-history.js';import {renderDialogueMessage} from '/modules/dialogue-page.js';
const text=${JSON.stringify(rich)},event={id:1,taskId:'A',kind:'text',text,createdAt:1};
initConversePage({invoke:async()=>'',invokeWorkbenchApi:async()=>({events:[{kind:'user',text,createdAt:1},{kind:'text',text,createdAt:2}]})});
document.querySelector('#task').innerHTML=renderMessageFor({detail:null,helper:'CC',handoffs:[],actionable:false,lastReply:null,otherProvider:null,origin:null})(event);
document.querySelector('#history').innerHTML=renderHistoryPanel({providers:['codex'],providerId:'codex',busy:false,error:'',preview:{session:{providerId:'codex',title:'已有记录',key:'k',nativeId:'n'},messages:[{id:'m',role:'assistant',text}]}});
document.querySelector('#dialogue').innerHTML=renderDialogueMessage({id:'d',chatId:'owner',direction:'out',kind:'text',text,ts:'2026-10-28',source:'desktop'},{showAuthor:true});
document.querySelector('#markdown-file').innerHTML=renderWorkbenchArtifactText('notes.md','text/markdown',text);
document.querySelector('#plain-file').innerHTML=renderWorkbenchArtifactText('notes.txt','text/plain','\\n'+text+'\\r\\n');
window.ready=true;</script>`
for(const size of [{width:1400,height:900},{width:760,height:700},{width:390,height:700}])test(`all real reading renderers ${size.width}`,async({page},info)=>{
 page.on('pageerror',e=>console.error(e.message));await page.setViewportSize(size)
 const remote:string[]=[];page.on('request',r=>{if(r.url().startsWith('https://example.com'))remote.push(r.url())})
 await page.route('http://127.0.0.1:4271/**',async route=>{const p=new URL(route.request().url()).pathname;try{await route.fulfill({contentType:p==='/'?'text/html':/\.m?js$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream',body:p==='/'?fixture:process.env.READING_BASELINE&&['/modules/workbench.js','/modules/workbench-history.js','/styles/workbench.css'].includes(p)?execFileSync('git',['show','f808c2f40431de5b7ca0eef35d535d83c66f017e:apps/desktop/src'+p]):await readFile(source+p)})}catch{await route.fulfill({status:404,body:''})}})
 await page.goto('http://127.0.0.1:4271');await page.waitForFunction(()=>(window as any).ready)
 for(const entry of ['#task','#converse-scroll .converse-msg-cc','#history .wb-history-message:first-of-type','#dialogue','#markdown-file']){
  const el=page.locator(entry).first();await expect(el.locator('h6').first()).toBeVisible()
  const metrics=await el.evaluate(root=>({headings:[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(x=>parseFloat(getComputedStyle(x).fontSize)),table:root.querySelector('table')!.getBoundingClientRect().width,cell:root.querySelector('td')!.getBoundingClientRect().width,pre:getComputedStyle(root.querySelector('pre')!).whiteSpace}))
  if(process.env.READING_BASELINE)console.log(entry,metrics);expect(Math.min(...metrics.headings)).toBeGreaterThanOrEqual(16);expect(metrics.cell).toBeGreaterThanOrEqual(140);expect(metrics.table).toBeLessThanOrEqual(size.width);expect(metrics.pre).toBe('pre')
  await expect(el.locator('a[href="https://example.com/image.png"]').first()).toHaveText('打开图片');await expect(el).toContainText('/Users/example/a.md');await expect(el).toContainText('./image.png');await expect(el.locator('img[src="https://example.com/image.png"]')).toHaveCount(0)
  expect(await el.locator('pre').first().evaluate(x=>{x.scrollLeft=x.scrollWidth;return x.scrollLeft>0})).toBe(true)
 }
 await expect(page.locator('#plain-file h1')).toHaveCount(0);expect(await page.locator('#plain-file pre').textContent()).toBe('\n'+rich+'\r\n')
 await page.locator('#converse-input').fill('保留草稿');await page.locator('#converse-scroll [data-user-source] summary').click();await expect(page.locator('#converse-input')).toHaveValue('保留草稿')
 expect(remote).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:info.outputPath('reading.png'),fullPage:true})
})

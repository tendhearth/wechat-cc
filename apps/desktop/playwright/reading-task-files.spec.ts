import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {rich} from './reading-fixture'
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"><style>html,body{margin:0;height:100%;overflow:hidden}#workbench-root{height:100%}</style><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage,stopWorkbenchPolling} from '/modules/workbench.js';
const text=${JSON.stringify(rich)},task={id:'A',title:'真实内容阅读',path:'/synthetic/project',providerId:'codex',status:'completed',phase:'replied',createdAt:1,updatedAt:2,error:null};
const meta=(id,name,mime)=>({id,name,mime,size:new TextEncoder().encode(text).length,sha256:'a'.repeat(64)}),md=meta('md','input.md','text/markdown'),plain=meta('raw','source.json','application/json'),artifact={...meta('result','output.md','text/markdown'),taskId:'A',createdAt:1,approvedAt:null};
const detail={task,events:[{id:1,taskId:'A',kind:'user',text,createdAt:1,attachments:[md,plain]},{id:2,taskId:'A',kind:'text',text,createdAt:2}],artifacts:[artifact],permissions:[],questions:[],continuation:{mode:'continue'}};
const base64=()=>btoa(String.fromCharCode(...new TextEncoder().encode(text)));window.qa={detail};
const controller=initWorkbenchPage({pollMs:60000,invokeWorkbenchApi:async(method,path)=>{
 if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(()=>{}):detail;
 if(path.startsWith('/v1/workbench/review?'))return{reviews:[]};
 if(path.startsWith('/v1/workbench/attachment?'))return{attachment:new URL(path,location.origin).searchParams.get('id')==='md'?md:plain,base64:base64()};
 if(path.startsWith('/v1/workbench/artifact?'))return{...artifact,contentBase64:base64()};
 if(path.startsWith('/v1/matters?'))return{matters:[]};
 return{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false};
}});window.qa.controller=controller;window.qa.stop=stopWorkbenchPolling;
</script>`
for(const size of [{width:1400,height:900},{width:760,height:700},{width:390,height:700}])test(`actual task input and output reading ${size.width}`,async({page},info)=>{
 await page.setViewportSize(size);await page.route('http://127.0.0.1:4271/**',async route=>{const p=new URL(route.request().url()).pathname;try{await route.fulfill({contentType:p==='/'?'text/html':/\.m?js$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream',body:p==='/'?fixture:await readFile(source+p)})}catch{await route.fulfill({status:404,body:''})}})
 await page.goto('http://127.0.0.1:4271');await expect(page.locator('#wb-followup-text')).toBeVisible();await page.locator('#wb-followup-text').fill('保留这份草稿')
 await page.locator('[data-action="preview-input-attachment"][data-attachment-id="md"]').click();await expect(page.locator('dialog h6')).toHaveText('Heading 六');expect(await page.locator('dialog h6').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
 await page.locator('dialog details summary').click();expect(await page.locator('dialog details pre').textContent()).toBe(rich);await page.screenshot({path:info.outputPath('markdown-input.png')});await page.keyboard.press('Escape')
 await page.locator('[data-action="preview-input-attachment"][data-attachment-id="raw"]').click();await expect(page.locator('dialog h1')).toHaveCount(0);expect(await page.locator('dialog pre').textContent()).toBe(rich);await page.keyboard.press('Escape')
 await page.locator('[data-action="show-artifacts"]').click();await expect(page.locator('#wb-preview h6')).toBeVisible();await page.locator('#wb-preview details summary').click();expect(await page.locator('#wb-preview details pre').textContent()).toBe(rich)
 await page.evaluate(()=>{const qa=(window as any).qa;qa.node=document.querySelector('#wb-preview');const text=qa.node.querySelector('h6').firstChild,range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);qa.selection=getSelection().toString();qa.scroll=qa.node.scrollTop=100;qa.controller.paint(true)});expect(await page.evaluate(()=>document.querySelector('#wb-preview')===(window as any).qa.node)).toBe(true);expect(await page.evaluate(()=>getSelection()?.toString())).toBe('Heading 六');await expect(page.locator('#wb-preview details')).toHaveAttribute('open','')
 await page.screenshot({path:info.outputPath('markdown-output.png')});await page.locator('[data-action="back-to-dialogue"]').click();await expect(page.locator('#wb-followup-text')).toHaveValue('保留这份草稿');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>(window as any).qa.stop())
})

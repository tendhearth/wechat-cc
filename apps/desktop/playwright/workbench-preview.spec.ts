import {join} from 'node:path'
import {zipSync,unzipSync} from 'fflate'
import {test,expect,clickNav} from './fixtures'


/** 「下载」在真 app 里走 Rust 的 save_file(webview 不处理 <a download>,2026-10-05):收集这次的调用。 */
function captureSaves(page: import('@playwright/test').Page) {
  const saves: Array<{ filename: string; bytes: Buffer }> = []
  page.on('request', req => {
    const body = req.postData() ?? ''
    if (!body.includes('"save_file"')) return
    const args = JSON.parse(body).args as { filename: string; data_b64: string }
    saves.push({ filename: args.filename, bytes: Buffer.from(args.data_b64, 'base64') })
  })
  return saves
}

const html = `<!doctype html><html><meta charset="utf-8"><style>body{margin:0;background:#faf7f2;color:#2a2622;font:18px Georgia;padding:32px}h1{font-weight:400}button{font:inherit;padding:12px;background:#4f6b4f;color:white;border:0;border-radius:24px}</style><h1>周末的小花园</h1><p>这是 CC 做好的页面，可以直接试用。</p><button id="counter">浇水 · 0</button><script>let n=0;document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent='浇水 · '+(++n);window.parentAccess=false;try{parent.document.body;window.parentAccess=true}catch{}</script></html>`
const task={id:'abcd1234',title:'做一页周末花园',path:'/demo/garden',providerId:'codex',status:'completed',createdAt:1,updatedAt:2,error:null}
function smallPdf(){
  const stream='BT /F1 22 Tf 48 740 Td (Garden design report) Tj ET'
  const second='BT /F1 22 Tf 48 740 Td (Planting notes) Tj ET'
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',`<< /Length ${second.length} >>\nstream\n${second}\nendstream`]
  let text='%PDF-1.4\n';const offsets=[0]
  objects.forEach((value,i)=>{offsets.push(text.length);text+=`${i+1} 0 obj\n${value}\nendobj\n`})
  const start=text.length
  text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return text
}
const outputs = [
  {id:'html',name:'garden.html',mime:'text/plain',text:html},
  {id:'md',name:'说明.md',mime:'text/markdown',text:'# 花园说明\n\n点击浇水，可以看到次数变化。'},
  {id:'web',name:'garden.preview.json',mime:'application/json',text:'{"url":"http://localhost:4301/"}'},
  {id:'pdf',name:'Garden report.pdf',mime:'application/pdf',text:smallPdf()},
]

async function setup(page:any,shim:any,shimUrl:string,withAttachment=false,siteArchive?:Uint8Array){
  const delivered=outputs.map(a=>({...a,size:Buffer.byteLength(a.text),contentBase64:Buffer.from(a.text).toString('base64')}))
  if(siteArchive)delivered.push({id:'site',name:'花园.site.zip',mime:'application/vnd.cc.workbench-site+zip',text:'',size:siteArchive.length,contentBase64:Buffer.from(siteArchive).toString('base64')})
  await shim.invoke('demo.seed',{chat_id:'test_chat',daemonAlive:true})
  const approved=new Set<string>()
  await page.route('**/v1/workbench**',async(route:any)=>{
    const url=new URL(route.request().url())
    if(url.pathname==='/v1/workbench/approve')approved.add(route.request().postDataJSON().artifactId)
    const artifacts=delivered.map(a=>({...a,taskId:task.id,sha256:a.id,createdAt:3,approvedAt:approved.has(a.id)?4:null}))
    let json:any={}
    if(url.pathname==='/v1/workbench')json={tasks:[task],projects:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}
    else if(url.pathname==='/v1/workbench/task')json={task,events:[...(withAttachment?[{id:'0',taskId:task.id,kind:'user',text:'请看看这份 PDF',createdAt:1,attachments:[{id:'input-pdf',name:'参考.pdf',mime:'application/pdf',size:smallPdf().length,sha256:'input-pdf'}]}]:[]),{id:'1',taskId:task.id,kind:'text',text:'页面已做好。可以打开成果试一试，或继续告诉我怎么改。',createdAt:2}],artifacts}
    else if(url.pathname==='/v1/workbench/attachment')json={attachment:{id:'input-pdf',name:'参考.pdf',mime:'application/pdf',size:smallPdf().length,sha256:'input-pdf'},base64:Buffer.from(smallPdf()).toString('base64')}
    else if(url.pathname==='/v1/workbench/artifact'){const a=delivered.find(a=>a.id===url.searchParams.get('artifactId'))!;json={...a,sha256:a.id}}
    else if(url.pathname==='/v1/workbench/review')json={reviews:[]}
    await route.fulfill({json})
  })
  await page.goto(shimUrl)
  await page.waitForFunction(()=>document.documentElement.dataset.mode && document.documentElement.dataset.mode!=='loading')
  await page.evaluate(()=>{document.documentElement.dataset.mode='dashboard'})
  await clickNav(page,'workbench')
  await expect(page.locator('.wb-task-head h2')).toHaveText(task.title)
}

test('HTML is interactive beside the conversation, isolated, and survives task repaint',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:1440,height:900})
  await setup(page,shim,shimUrl)
  await expect(page.getByRole('complementary',{name:'成果预览'})).toHaveCount(0)
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  const frame=page.frameLocator('#wb-preview-frame')
  await expect(frame.locator('h1')).toHaveText('周末的小花园')
  await frame.locator('#counter').click()
  await expect(frame.locator('#counter')).toHaveText('浇水 · 1')
  expect(await page.locator('#wb-preview-frame').evaluate((el:any)=>el.contentDocument)).toBeNull()
  await page.getByRole('button',{name:'窄屏',exact:true}).click()
  await expect(frame.locator('#counter')).toHaveText('浇水 · 1')
  await expect(page.getByRole('button',{name:'窄屏',exact:true})).toHaveAttribute('aria-pressed','true')
  await expect(page.getByRole('button',{name:'窄屏',exact:true})).toBeFocused()
  const dir=process.env.WECHAT_CC_DESIGN_SHOTS
  if(dir){await page.waitForTimeout(700);await page.screenshot({path:join(dir,'preview-html-wide.png')})}
  await page.getByRole('button',{name:'源码',exact:true}).click()
  await expect(page.locator('#wb-preview pre')).toContainText('<!doctype html>')
  await page.getByRole('button',{name:'预览',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('md')
  await expect(page.locator('#wb-preview h1')).toHaveText('花园说明')
  await page.getByRole('button',{name:'关闭成果预览'}).click()
  await expect(page.getByRole('complementary',{name:'成果预览'})).toHaveCount(0)
  await expect(page.locator('#wb-followup-text')).toBeVisible()
})

test('narrow windows show a full reader with an obvious return and keep the task draft',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:760,height:1000})
  await setup(page,shim,shimUrl)
  await page.locator('#wb-followup-text').fill('把背景再淡一点')
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await expect(page.locator('.wb-main')).toBeHidden()
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const dir=process.env.WECHAT_CC_DESIGN_SHOTS
  if(dir){await page.waitForTimeout(700);await page.screenshot({path:join(dir,'preview-narrow.png')})}
  await page.getByRole('button',{name:'关闭成果预览'}).click()
  await expect(page.locator('#wb-followup-text')).toHaveValue('把背景再淡一点')
})

test('live webpage output has refresh controls and is clearly distinguished from a saved version',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:1440,height:900})
  await page.route('http://localhost:4301/**',route=>route.fulfill({body:'<!doctype html><meta charset="utf-8"><h1>运行中的花园</h1>',contentType:'text/html; charset=utf-8'}))
  await setup(page,shim,shimUrl)
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('web')
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('运行中的花园')
  await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'浏览器打开',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'确认这份成果',exact:true})).toHaveCount(0)
  await expect(page.locator('.wb-artifact-panel footer')).toContainText('内容随项目更新')
  const dir=process.env.WECHAT_CC_DESIGN_SHOTS
  if(dir){await page.waitForTimeout(700);await page.screenshot({path:join(dir,'preview-wide.png')})}
})

test('preview failures are visible in the narrow reader and can be retried',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:760,height:1000})
  await setup(page,shim,shimUrl)
  let broken=true
  await page.route('**/v1/workbench/artifact?**',async route=>{
    if(broken)await route.fulfill({status:404,json:{error:'这份成果暂时没能读取'}})
    else await route.fulfill({json:{...outputs[0],contentBase64:Buffer.from(html).toString('base64')}})
  })
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await expect(page.locator('.wb-artifact-panel [role=alert]')).toContainText('暂时没能读取')
  await expect(page.locator('.wb-main')).toBeHidden()
  broken=false
  await page.getByRole('button',{name:'重新打开',exact:true}).click()
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('周末的小花园')
})

test('downloading during a slow preview does not cancel its pending result',async({page,shim,shimUrl})=>{
  await setup(page,shim,shimUrl)
  let release!:()=>void
  const pending=new Promise<void>(resolve=>{release=resolve})
  let first=true
  await page.route('**/v1/workbench/artifact?**',async route=>{
    if(first){first=false;await pending}
    await route.fulfill({json:{...outputs[0],contentBase64:Buffer.from(html).toString('base64')}})
  })
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await expect(page.locator('#wb-preview')).toContainText('正在打开成果')
  const saves=captureSaves(page)
  await page.getByRole('button',{name:'下载',exact:true}).click()
  await expect.poll(()=>saves.length).toBe(1)
  release()
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('周末的小花园')
})

test('PDF paints real pages, supports text selection, page and zoom, preserves reading state, and downloads exact bytes',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:1440,height:900})
  await setup(page,shim,shimUrl)
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('pdf')
  const reader=page.locator('#wb-preview .cc-pdf-reader')
  await expect(reader).toHaveAttribute('data-pdf-ready','true')
  await expect(reader.locator('.cc-pdf-text')).toContainText('Garden design report')
  const size=await reader.boundingBox()
  expect(size!.height).toBeGreaterThan(500)
  const ink=await reader.locator('canvas').evaluate((canvas:any)=>{
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data
    let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&pixels[i]<150&&pixels[i+1]<150&&pixels[i+2]<150)dark++
    return dark
  })
  expect(ink).toBeGreaterThan(200)
  expect(await reader.locator('.cc-pdf-text').evaluate(el=>{
    const range=document.createRange();range.selectNodeContents(el)
    const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range)
    const selected=selection.toString();selection.removeAllRanges();return selected
  })).toContain('Garden design report')
  await reader.getByRole('button',{name:'下一页',exact:true}).click()
  await expect(reader.locator('.cc-pdf-text')).toContainText('Planting notes')
  await reader.getByLabel('缩放',{exact:true}).selectOption('2')
  await expect(reader.locator('.cc-pdf-page')).toHaveCSS('width','1224px')
  await expect(reader.locator('.cc-pdf-text')).toContainText('Planting notes')
  await page.getByRole('button',{name:'确认这份成果',exact:true}).click()
  await expect(page.locator('.wb-artifact-panel footer')).toContainText('已确认此版本')
  await expect(reader).toHaveAttribute('data-pdf-page','2')
  await expect(reader.getByLabel('缩放',{exact:true})).toHaveValue('2')
  await reader.getByLabel('缩放',{exact:true}).selectOption('auto')
  await reader.getByRole('button',{name:'上一页',exact:true}).click()
  await expect(reader.locator('.cc-pdf-text')).toContainText('Garden design report')
  const saves=captureSaves(page)
  await page.getByRole('button',{name:'下载',exact:true}).click()
  await expect.poll(()=>saves.length).toBe(1)
  expect(saves[0]!.filename).toBe('Garden report.pdf')
  expect(saves[0]!.bytes.toString()).toBe(smallPdf())
  const dir=process.env.WECHAT_CC_DESIGN_SHOTS
  if(dir){await page.waitForTimeout(700);await page.screenshot({path:join(dir,'preview-pdf-wide.png')})}
  await page.setViewportSize({width:760,height:900})
  await expect(page.locator('.wb-main')).toBeHidden()
  await expect.poll(()=>reader.locator('.cc-pdf-page').evaluate(el=>el.clientWidth<=el.parentElement!.clientWidth)).toBe(true)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await expect(reader.locator('.cc-pdf-text')).toContainText('Garden design report')
})

test('unreadable PDFs keep a visible error and the download action',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:760,height:900})
  await setup(page,shim,shimUrl)
  await page.route('**/v1/workbench/artifact?**',async route=>route.fulfill({json:{...outputs[3],contentBase64:Buffer.from('not a PDF').toString('base64')}}))
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('pdf')
  await expect(page.locator('.cc-pdf-reader [role=alert]')).toContainText('暂时没能显示')
  await expect(page.getByRole('button',{name:'下载',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'关闭成果预览'}).click()
  await expect(page.locator('.cc-pdf-reader')).toHaveCount(0)
})

test('PDF input attachments use the same reader and release it when closed',async({page,shim,shimUrl})=>{
  await setup(page,shim,shimUrl,true)
  await page.locator('[data-action=preview-input-attachment][data-attachment-id=input-pdf]').click()
  const dialog=page.getByRole('dialog',{name:'参考.pdf',exact:true})
  await expect(dialog.locator('.cc-pdf-reader')).toHaveAttribute('data-pdf-ready','true')
  await expect(dialog.locator('.cc-pdf-text')).toContainText('Garden design report')
  await dialog.getByRole('button',{name:'下一页',exact:true}).click()
  await expect(dialog.locator('.cc-pdf-text')).toContainText('Planting notes')
  await dialog.getByRole('button',{name:'关闭',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await page.locator('[data-action=preview-input-attachment][data-attachment-id=input-pdf]').click()
  await expect(dialog.locator('.cc-pdf-text')).toContainText('Garden design report')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('a stopped webpage service shows recovery instead of a blank frame',async({page,shim,shimUrl})=>{
  await page.setViewportSize({width:760,height:900})
  let running=false
  await page.route('http://localhost:4301/**',route=>running?route.fulfill({body:'<!doctype html><meta charset="utf-8"><h1>服务已恢复</h1>',contentType:'text/html; charset=utf-8'}):route.abort('connectionrefused'))
  await setup(page,shim,shimUrl)
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('web')
  await expect(page.locator('.wb-artifact-panel [role=alert]')).toContainText('网页服务暂时没有响应')
  await expect(page.getByRole('button',{name:'确认这份成果',exact:true})).toHaveCount(0)
  running=true
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('服务已恢复')
})


test('saved website renders linked CSS, image and module imports, navigates within the frozen bundle, and downloads the whole site',async({page,shim,shimUrl})=>{
  const encode=(s:string)=>new TextEncoder().encode(s)
  const files={
    '__cc_preview.json':encode(JSON.stringify({version:1,entry:'花园/index.html'})),
    '花园/index.html':encode('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css?v=1"><h1>周末的小花园</h1><p id="note">正在打开…</p><img src="leaf.svg" alt="绿叶"><p><button id="counter">浇水 · 0</button></p><a href="pages/about.html">种植说明</a><script type="module" src="app.mjs"></script>'),
    '花园/style.css':encode('body{margin:0;padding:32px;background:#faf7f2;color:#2a2622;font:18px Georgia}h1{font-size:32px;font-weight:400;color:rgb(79,107,79)}button{font:inherit;background:#4f6b4f;color:white;border:0;border-radius:24px;padding:12px 24px}img{width:96px;height:96px}a{color:#4f6b4f}'),
    '花园/leaf.svg':encode('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><path fill="#4f6b4f" d="M12 80Q12 12 82 12Q82 82 12 80Z"/></svg>'),
    '花园/app.mjs':encode('import {ready} from "./lib/message.mjs";document.querySelector("#note").textContent=ready;let n=0;document.querySelector("#counter").onclick=()=>document.querySelector("#counter").textContent="浇水 · "+(++n);fetch("data.json").then(r=>r.json()).then(data=>document.body.dataset.season=data.season)'),
    '花园/lib/message.mjs':encode('export const ready="这是 CC 做好的完整网页，可以直接试用。"'),
    '花园/data.json':encode('{"season":"spring"}'),
    '花园/pages/about.html':encode('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../style.css"><h1>种植说明</h1><p>土壤干了，再浇水。</p><a href="../index.html">回到花园</a>'),
  }
  const archive=zipSync(files,{level:0})
  await page.setViewportSize({width:1440,height:900})
  await setup(page,shim,shimUrl,false,archive)
  await page.locator('#wb-followup-text').fill('把种植说明加上月份')
  await page.getByRole('button',{name:'成果 · 5',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('site')
  const frame=page.frameLocator('#wb-preview-frame')
  await expect(frame.locator('#note')).toContainText('完整网页')
  await expect(frame.locator('h1')).toHaveCSS('color','rgb(79, 107, 79)')
  await expect(frame.locator('body')).toHaveAttribute('data-season','spring')
  expect(await frame.locator('img').evaluate((el:any)=>el.complete&&el.naturalWidth>0)).toBe(true)
  expect(await page.locator('#wb-preview-frame').evaluate((el:any)=>el.contentDocument)).toBeNull()
  await frame.locator('#counter').click()
  await page.getByRole('button',{name:'窄屏',exact:true}).click()
  await expect(frame.locator('#counter')).toHaveText('浇水 · 1')
  const dir=process.env.WECHAT_CC_DESIGN_SHOTS
  if(dir)await page.screenshot({path:join(dir,'preview-site-wide.png')})
  await frame.getByRole('link',{name:'种植说明'}).click()
  await expect(frame.locator('h1')).toHaveText('种植说明')
  await expect(frame.locator('h1')).toHaveCSS('color','rgb(79, 107, 79)')
  await page.getByRole('button',{name:'确认这份成果',exact:true}).click()
  await expect(frame.locator('h1')).toHaveText('种植说明')
  const saves=captureSaves(page)
  await page.getByRole('button',{name:'下载',exact:true}).click()
  await expect.poll(()=>saves.length).toBe(1)
  expect(saves[0]!.filename).toBe('花园.site.zip')
  expect(saves[0]!.bytes).toEqual(Buffer.from(archive))
  expect(Object.keys(unzipSync(saves[0]!.bytes))).toEqual(Object.keys(files))
  await page.setViewportSize({width:760,height:900})
  await expect(page.locator('.wb-main')).toBeHidden()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.getByRole('button',{name:'关闭成果预览'}).click()
  await expect(page.locator('#wb-followup-text')).toHaveValue('把种植说明加上月份')
})

test('HTTPS loopback webpages pass availability checks under the production CSP',async({page,shim,shimUrl})=>{
  await setup(page,shim,shimUrl)
  await page.route('https://localhost:4301/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>安全连接的网页</h1>'}))
  await page.route('**/v1/workbench/artifact?**',route=>route.request().url().includes('artifactId=web')?route.fulfill({json:{name:'garden.preview.json',mime:'application/json',contentBase64:Buffer.from('{"url":"https://localhost:4301/"}').toString('base64')}}):route.fallback())
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('web')
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('安全连接的网页')
})

test('refreshing an already open webpage detects that its service stopped and can recover',async({page,shim,shimUrl})=>{
  let running=true
  await page.route('http://localhost:4301/**',route=>running?route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>花园正在运行</h1>'}):route.abort('connectionrefused'))
  await setup(page,shim,shimUrl)
  await page.getByRole('button',{name:'成果 · 4',exact:true}).click()
  await page.locator('#wb-artifact-choice').selectOption('web')
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('花园正在运行')
  running=false
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await expect(page.locator('.wb-artifact-panel [role=alert]')).toContainText('网页服务暂时没有响应')
  running=true
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await expect(page.frameLocator('#wb-preview-frame').locator('h1')).toHaveText('花园正在运行')
})

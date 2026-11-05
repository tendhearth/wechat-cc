import { test, expect, WORKBENCH_ROUTES } from './fixtures'
import { REPORTS } from './reports'

test.beforeEach(async ({ page, shim }) => {
  await page.route('**/__dev_reload.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
  await shim.invoke('demo.unseed'); await shim.invoke('demo.seed', {})
  await shim.invoke('mock.doctor', { report: REPORTS.allGreen })
})

async function nativeEntry(page: import('@playwright/test').Page, options: { doctor?: boolean, pending?: boolean, config?: boolean, destination?: unknown, duringListen?: unknown }) {
  await page.addInitScript(options => {
    const listeners = new Map<string, (event: any) => void>()
    let releaseDoctor!: () => void, releasePending!: () => void, releaseConfig!: () => void
    const doctor = new Promise<void>(resolve => { releaseDoctor = resolve })
    const pending = new Promise<void>(resolve => { releasePending = resolve })
    const config = new Promise<void>(resolve => { releaseConfig = resolve })
    const fixture = { doctorRead: false, pendingRead: false, configRead: false,
      releaseDoctor, releasePending, releaseConfig,
      emit: (target: unknown) => { const fn = listeners.get('wechat-cc:navigate'); fn?.({ payload: typeof target === 'string' ? { page: target } : target }); return Boolean(fn) },
    }
    ;(window as any).__entryFixture = fixture
    ;(window as any).__TAURI__ = { event: {
      listen: async (name: string, fn: (event: any) => void) => {
        listeners.set(name, fn)
        if (name === 'wechat-cc:navigate' && options.duringListen) fn({ payload: typeof options.duringListen === 'string' ? { page: options.duringListen } : options.duringListen })
        return () => listeners.delete(name)
      },
    }, window: { getCurrentWindow: () => ({ startDragging: async () => {} }) }, core: {
      invoke: async (command: string, args: any = {}) => {
        if (command === 'take_pending_navigate') {
          fixture.pendingRead = true
          if (options.pending) await pending
          return options.destination === undefined ? 'converse' : options.destination
        }
        if (command === 'wechat_cli_json' && args.args?.[0] === 'doctor') {
          fixture.doctorRead = true
          if (options.doctor) await doctor
        }
        if (command === 'wechat_cli_json' && args.args?.[0] === 'provider' && args.args?.[1] === 'show') {
          fixture.configRead = true
          if (options.config) await config
        }
        if (command === 'daemon_request') {
          const response = await fetch(args.path, { method: args.method,
            ...(args.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: args.body ?? '{}' } : {}) })
          if (!response.ok) throw Error(`Test daemon boundary returned ${response.status}`)
          return response.text()
        }
        const response = await fetch('/__invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) })
        const value = await response.json()
        if (value.error !== undefined) throw Error(String(value.error))
        return value.result
      },
    } }
  }, options)
}

async function expectConversation(page: import('@playwright/test').Page) {
  await expect(page.locator('main.dashboard')).toBeVisible()
  await expect(page.locator('.cc-now-pane')).toHaveAttribute('data-now', 'chat')
  await expect(page.locator('#converse-input')).toBeFocused()
}

test('fast pending pet navigation waits for the visible dashboard before focusing chat', async ({ page, shimUrl }) => {
  await nativeEntry(page, { doctor: true })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (window as any).__entryFixture.doctorRead)).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__entryFixture.pendingRead)).toBe(true)
  await page.evaluate(() => (window as any).__entryFixture.releaseDoctor())
  await expectConversation(page)
})

test('slow pending pet navigation focuses chat after the dashboard has already opened', async ({ page, shimUrl }) => {
  await nativeEntry(page, { pending: true })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.dashboard')).toBeVisible()
  await page.evaluate(() => (window as any).__entryFixture.releasePending())
  await expectConversation(page)
})

test('a live pet navigation received while provider setup loads is retained', async ({ page, shimUrl }) => {
  await nativeEntry(page, { config: true, destination: null })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (window as any).__entryFixture.configRead)).toBe(true)
  expect(await page.evaluate(() => (window as any).__entryFixture.emit('converse'))).toBe(true)
  await page.evaluate(() => (window as any).__entryFixture.releaseConfig())
  await expectConversation(page)
})

test('a running main window uses the same focused conversation entry', async ({ page, shimUrl }) => {
  await nativeEntry(page, { destination: null })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main.dashboard')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__entryFixture.emit('converse'))).toBe(true)
  await expectConversation(page)
})

test('a live destination during registration wins over a previous pending destination', async ({ page, shimUrl }) => {
  await nativeEntry(page, { duringListen: 'converse', destination: 'a2a-agents' })
  await page.goto(shimUrl, { waitUntil: 'domcontentloaded' })
  await expectConversation(page)
})


async function taskBoundary(page:import('@playwright/test').Page, missing:string|null=null) {
 const posts:string[]=[],reads:string[]=[]
 const task=(id:string)=>({id,title:id==='deadbeef'?'桌宠指定的那件事':'原来的任务',path:'/demo/pet',providerId:'claude',status:'completed',phase:'replied',createdAt:1,updatedAt:2,error:null,archivedAt:null})
 await page.route(WORKBENCH_ROUTES,async route=>{
  const request=route.request(),url=new URL(request.url());if(request.method()!=='GET')posts.push(url.pathname)
  let json:any={}
  if(url.pathname==='/v1/workbench')json={tasks:[task('aaaa1111')],projects:[{path:'/demo/pet',name:'pet',providerId:'claude'}],providers:[{id:'claude',displayName:'Claude Code'}],defaultProvider:'claude',canWechat:false}
  else if(url.pathname==='/v1/workbench/task'){
   const id=url.searchParams.get('id')!;reads.push(id)
   if(id===missing){await route.fulfill({status:404,json:{error:'not_found'}});return}
   json={task:task(id),version:1,events:[],artifacts:[],permissions:[],questions:[],continuation:{mode:'new'}}
  } else if(url.pathname==='/v1/matter/changes')json={reviews:[]}
  else if(url.pathname==='/v1/workbench/attention')json={tasks:[],progress:[]}
  await route.fulfill({json})
 })
 return {posts,reads}
}
for(const gate of ['doctor','pending'] as const)test(`cold pet task target survives ${gate} readiness and selects an item outside the list`,async({page,shimUrl})=>{
 const boundary=await taskBoundary(page)
 await nativeEntry(page,{[gate]:true,destination:{page:'workbench',taskId:'deadbeef'}})
 await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
 await expect.poll(()=>page.evaluate(g=>(window as any).__entryFixture[g+'Read'],gate)).toBe(true)
 await page.evaluate(g=>(window as any).__entryFixture[g==='doctor'?'releaseDoctor':'releasePending'](),gate)
 await expect(page.locator('.wb-task-head h2')).toHaveText('桌宠指定的那件事')
 expect(boundary.reads).toContain('deadbeef');expect(boundary.posts).toEqual([])
})
test('a newer live pet task wins an older cold target without sending or losing the prior draft',async({page,shimUrl})=>{
 const boundary=await taskBoundary(page)
 await nativeEntry(page,{pending:true,destination:{page:'workbench',taskId:'deadbeef'}})
 await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
 await expect(page.locator('main.dashboard')).toBeVisible()
 await page.evaluate(()=>(window as any).__entryFixture.emit({page:'workbench',taskId:'aaaa1111'}))
 await expect(page.locator('.wb-task-head h2')).toHaveText('原来的任务')
 await page.locator('#wb-followup-text').fill('这段草稿还没有交办')
 await page.evaluate(()=>(window as any).__entryFixture.releasePending())
 await expect(page.locator('.wb-task-head h2')).toHaveText('原来的任务')
 await expect(page.locator('#wb-followup-text')).toHaveValue('这段草稿还没有交办')
 await page.evaluate(()=>(window as any).__entryFixture.emit({page:'workbench',taskId:'deadbeef'}))
 await expect(page.locator('.wb-task-head h2')).toHaveText('桌宠指定的那件事')
 await page.evaluate(()=>(window as any).__entryFixture.emit({page:'workbench',taskId:'aaaa1111'}))
 await expect(page.locator('#wb-followup-text')).toHaveValue('这段草稿还没有交办')
 expect(boundary.posts).toEqual([])
})

test('an unavailable exact task shows the existing error without opening another task or submitting',async({page,shimUrl})=>{
 const boundary=await taskBoundary(page,'deadbeef')
 await nativeEntry(page,{destination:{page:'workbench',taskId:'deadbeef'}})
 await page.goto(shimUrl,{waitUntil:'domcontentloaded'})
 await expect(page.locator('.workbench-pane')).toBeVisible()
 await expect(page.locator('.workbench-pane .wb-error[role="alert"]')).toContainText('404')
 // Observe the real periodic list refresh, not merely the initial 404.
 await page.waitForTimeout(3_500)
 await expect(page.locator('.workbench-pane .wb-error[role="alert"]')).toContainText('404')
 expect(boundary.reads).toContain('deadbeef');expect(boundary.reads).not.toContain('aaaa1111')
 expect(boundary.posts).toEqual([]);await expect(page.locator('.wb-task-head h2')).toHaveCount(0)
})

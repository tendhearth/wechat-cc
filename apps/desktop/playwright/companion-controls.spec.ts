import { test, expect } from './fixtures'

// Source-generating checks can run alongside this suite; developer reloads
// must not replace the document in the middle of an actual control action.
test.beforeEach(async ({ page }) => {
  await page.route('**/__dev_reload.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
})

async function toggleSettings(page: import('@playwright/test').Page) {
  // Approach the pet before using its intentionally tucked-away controls.
  if (await page.locator('.pet-settings').getAttribute('open') === null) await page.locator('#pet-stage').hover()
  await page.getByText('陪伴设置', { exact: true }).click()
}

async function openCompanion(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(new URL('companion-window.html?lab', shimUrl).href)
  await page.waitForFunction(() => Boolean((window as any).__pet))
}

test('idle controls stop intercepting clicks and return on nearby hover, keyboard focus and an open menu', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 240, height: 300 })
  await openCompanion(page, shimUrl)
  const controls = page.locator('.pet-controls')
  await page.mouse.move(-10, -10)
  await expect(controls).toHaveCSS('opacity', '0')
  expect(await page.locator('#pet-open-main').evaluate(button => {
    const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return Boolean(hit?.closest('.pet-controls'))
  })).toBe(false)
  await page.locator('#pet-stage').hover()
  await expect(controls).toHaveCSS('opacity', '1')
  await toggleSettings(page)
  await page.mouse.move(-10, -10)
  await expect(controls).toHaveCSS('opacity', '1')
  await expect(page.getByRole('checkbox', { name: '减少动作' })).toBeVisible()
  await toggleSettings(page)
  await page.keyboard.press('Tab')
  await page.locator('#pet-stage').focus()
  await page.mouse.move(-10, -10)
  await expect(controls).toHaveCSS('opacity', '1')
})

test('pointer-used controls tuck away on leave while keyboard users retain visible controls', async ({ page, shimUrl }) => {
  await page.setViewportSize({ width: 240, height: 300 })
  await page.addInitScript(() => {
    ;(window as any).__TAURI__ = { core: { invoke: async () => null } }
  })
  await openCompanion(page, shimUrl)
  await page.locator('#pet-stage').hover()
  await page.locator('#pet-zoom-in').click()
  await page.mouse.move(-10, -10)
  await expect(page.locator('.pet-controls')).toHaveCSS('opacity', '0')
  await page.keyboard.press('Tab')
  await expect(page.locator('.pet-controls')).toHaveCSS('opacity', '1')
})

test('the character activates the same chat route by click and keyboard while a drag only moves', async ({ page, shimUrl }) => {
  await page.addInitScript(() => {
    ;(window as any).__commands = []
    ;(window as any).__TAURI__ = { core: { invoke: async (cmd: string, args: any) => {
      ;(window as any).__commands.push({ cmd, args })
      return cmd === 'start_companion_drag' ? { x: 1000, y: 500 } : cmd === 'wechat_cli_json' ? { ok: false } : undefined
    } } }
  })
  await openCompanion(page, shimUrl)
  const stage = page.locator('#pet-stage')
  await stage.click()
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((c: any) => c.cmd === 'show_main_window').length)).toBe(1)
  await stage.focus(); await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((c: any) => c.cmd === 'show_main_window').length)).toBe(2)
  await page.evaluate(() => {
    document.getElementById('pet-stage')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, screenX: 120, screenY: 130 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, screenX: 120, screenY: 130 }))
  })
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((c: any) => c.cmd === 'move_companion_window').length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__commands.filter((c: any) => c.cmd === 'show_main_window'))).toEqual([
    { cmd: 'show_main_window', args: { page: 'converse' } }, { cmd: 'show_main_window', args: { page: 'converse' } },
  ])
})

for (const width of [200, 240]) test(`companion controls fit without wrapping at ${width}px`, async ({ page, shimUrl }) => {
  await page.setViewportSize({ width, height: 300 })
  await openCompanion(page, shimUrl)
  const layout = await page.locator('.pet-controls').evaluate(controls => {
    const button = controls.querySelector<HTMLButtonElement>('#pet-open-main')!
    const range = document.createRange(); range.selectNodeContents(button)
    const lines = [...range.getClientRects()].filter(rect => rect.width > 0)
    const box = button.getBoundingClientRect(), group = controls.getBoundingClientRect()
    return { lineCount: new Set(lines.map(rect => Math.round(rect.top))).size,
      textBottom: Math.max(...lines.map(rect => rect.bottom)), buttonBottom: box.bottom,
      left: group.left, right: group.right, viewport: innerWidth }
  })
  expect(layout.lineCount).toBe(1)
  expect(layout.textBottom).toBeLessThanOrEqual(layout.buttonBottom + 1)
  expect(layout.left).toBeGreaterThanOrEqual(0)
  expect(layout.right).toBeLessThanOrEqual(layout.viewport)
})

for (const width of [200, 240]) test(`opened companion settings remain reachable at ${width}px`, async ({ page, shimUrl }) => {
  await page.setViewportSize({ width, height: 250 })
  await openCompanion(page, shimUrl)
  await toggleSettings(page)
  const bounds = await page.locator('.pet-settings-panel').evaluate(panel => {
    const { left, top, right, bottom } = panel.getBoundingClientRect()
    return { left, top, right, bottom, width: innerWidth, height: innerHeight }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
  await page.getByRole('checkbox', { name: '减少动作' }).check()
  await expect(page.getByRole('checkbox', { name: '减少动作' })).toBeChecked()
  await page.getByRole('button', { name: '安静一小时' }).click()
  await expect(page.getByRole('button', { name: '恢复动作' })).toBeVisible()
})

// Companion is a separate entry point; the dev server installs its IPC transport
// only on index.html. Connect explicitly so facts still come from the dry-run shim.
async function attachShim(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    ;(window as any).__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      const response = await fetch('/__invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) })
      const value = await response.json()
      if (value.error) throw new Error(value.error)
      return value.result
    } } }
  })
}

test('motion controls follow system live, persist user choices, and retain Light/Dark facts', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', {})
  await attachShim(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openCompanion(page, shimUrl)
  await expect(page.locator('#pet-stage')).toHaveAttribute('aria-label', 'CC，已连接')
  await toggleSettings(page)
  const reduced = page.getByRole('checkbox', { name: '减少动作' })
  await reduced.check()
  await expect(page.locator('#pet-stage')).not.toHaveClass(/pet-breathing/)
  await expect(page.locator('#pet-sprite')).toHaveCSS('transition-duration', '0s')
  await page.reload()
  await toggleSettings(page)
  await expect(reduced).toBeChecked()
  await reduced.uncheck()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(reduced).toBeChecked(); await expect(reduced).toBeDisabled()
  await expect(page.locator('#pet-stage')).not.toHaveClass(/pet-breathing/)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(reduced).not.toBeChecked(); await expect(reduced).toBeEnabled()
  await page.getByRole('button', { name: '安静一小时' }).click()
  await expect(page.getByRole('button', { name: '恢复动作' })).toBeVisible()
  await shim.invoke('demo.seed', { presenceDown: true })
  await page.reload()
  await expect(page.locator('#pet-stage')).toHaveAttribute('aria-label', 'CC，暂时联系不上')
  await expect(page.locator('#pet-stage')).not.toHaveClass(/pet-breathing/)
  await expect(page.locator('#pet-hint')).toHaveText('暂时联系不上 CC')
  await toggleSettings(page)
  await expect(page.getByRole('button', { name: '恢复动作' })).toBeVisible()
  await page.getByRole('button', { name: '恢复动作' }).click()
  await expect(page.locator('#pet-stage')).not.toHaveClass(/pet-breathing/)
})

test('main entry works with keyboard in browser preview and stays outside the drag stage', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', {})
  await openCompanion(page, shimUrl)
  const button = page.getByRole('button', { name: '找 CC', exact: true })
  await expect(button).toBeVisible()
  expect(await button.evaluate(el => Boolean(el.closest('#pet-stage')))).toBe(false)
  await button.focus(); await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/index\.html$/)
})

test('native main entry sends only the explicit conversation destination', async ({ page, shimUrl }) => {
  await page.addInitScript(() => {
    ;(window as any).__commands = []
    ;(window as any).__TAURI__ = { core: { invoke: async (cmd: string, args: any) => {
      ;(window as any).__commands.push({ cmd, args })
      if (cmd === 'wechat_cli_json') return { ok: false }
      return undefined
    } } }
  })
  await openCompanion(page, shimUrl)
  const button = page.getByRole('button', { name: '找 CC', exact: true })
  await button.focus(); await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => (window as any).__commands.filter((c: any) => c.cmd === 'show_main_window'))).toEqual([{ cmd: 'show_main_window', args: { page: 'converse' } }])
  expect(await page.evaluate(() => (window as any).__commands.some((c: any) => c.cmd === 'start_companion_drag'))).toBe(false)
})

test('hiding pauses breathing and current one-shots; becoming visible observes current connection', async ({ page, shimUrl, shim }) => {
  await attachShim(page)
  await shim.invoke('demo.seed', {})
  await openCompanion(page, shimUrl)
  await expect(page.locator('#pet-stage')).toHaveAttribute('aria-label', 'CC，已连接')
  await page.evaluate(() => {
    ;(window as any).__pet.setState('done')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#pet-stage')).not.toHaveClass(/pet-breathing/)
  await shim.invoke('demo.seed', { presenceDown: true })
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#pet-stage')).toHaveAttribute('aria-label', 'CC，暂时联系不上')
  await expect(page.locator('#pet-stage')).not.toHaveClass(/pet-breathing/)
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('sleep')
})

test('quiet keeps permission controls usable in a small companion window', async ({ page, shimUrl, shim }) => {
  await attachShim(page)
  await shim.invoke('demo.seed', {})
  await page.setViewportSize({ width: 240, height: 250 })
  await page.route('**/v1/companion/pet', route => route.fulfill({ json: {
    owner_last_contact_at: null, last_done_at: null,
    turn: { phase: 'permission', since: '2026-10-29T10:00:00Z' },
    pending_permissions: [{ hash: 'test-permission', prompt: '确认这次本地操作', since: '2026-10-29T10:00:00Z', expires_at: '2026-10-30T10:00:00Z' }],
  } }))
  await openCompanion(page, shimUrl)
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible()
  await toggleSettings(page)
  await page.getByRole('button', { name: '安静一小时' }).click()
  await toggleSettings(page)
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('permission')
  await page.getByRole('button', { name: '查看', exact: true }).click()
  await expect(page.locator('.pet-card-prompt')).toHaveText('确认这次本地操作')
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled()
  const positions = await page.locator('#pet-stage, #pet-card, #pet-open-main').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
  }))
  for (const r of positions) { expect(r.top).toBeGreaterThanOrEqual(0); expect(r.bottom).toBeLessThanOrEqual(250); expect(r.left).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(240) }
  await page.screenshot({ path: '.superpowers/companion-quiet-permission.png' })
})

test('an existing pet snapshot ends suspended quiet after consuming its completion', async ({ page, shimUrl, shim }) => {
  await attachShim(page)
  await shim.invoke('demo.seed', {})
  await page.addInitScript(() => {
    const wallNow = Date.now
    ;(window as any).__quietWallOffset = 0
    Date.now = () => wallNow() + (window as any).__quietWallOffset
  })
  let complete = false, reads = 0
  // 拨钟和换成「已完成」之间要是溜进一次 working 的拉取,安静已结束、基线成了 working,
  // 下一拍的完成就是真·新完成(该播)—— 测的不是这个场景。拨钟期间扣住拉取。
  let gate: Promise<void> | null = null
  await page.route('**/v1/companion/pet', async route => {
    if (gate) await gate
    reads++
    return route.fulfill({ json: {
      owner_last_contact_at: null, last_done_at: complete ? '2026-10-29T11:00:00Z' : null,
      turn: { phase: complete ? 'idle' : 'working', since: '2026-10-29T10:00:00Z' }, pending_permissions: [],
    } })
  })
  await openCompanion(page, shimUrl)
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('working')
  await toggleSettings(page)
  await page.getByRole('button', { name: '安静一小时' }).click()
  let release!: () => void
  gate = new Promise(r => { release = r })
  // 已经发出去、还没处理完的那一拍先落地(它仍在安静里,不算数)。
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    ;(window as any).__quietBehaviors = []
    ;(window as any).__pet.machine.subscribe((s: any) => (window as any).__quietBehaviors.push(s.behavior))
    // Simulate a sleeping WebKit clock without sleeping the host or running the quiet timeout.
    ;(window as any).__quietWallOffset = 3_600_001
  })
  const before = reads; complete = true
  gate = null; release()
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(page.getByRole('button', { name: '安静一小时' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('idle')
  expect(await page.evaluate(() => (window as any).__quietBehaviors)).not.toContain('done')
  expect(await page.evaluate(() => (window as any).__quietBehaviors)).not.toContain('receive')
  await expect(page.locator('#pet-stage')).toHaveAttribute('aria-label', 'CC，已连接')
})

for (const recovery of ['quiet', 'user', 'system']) test(`${recovery} ends before cached presence and a fresh pet completion without replay`, async ({ page, shimUrl, shim }) => {
  await attachShim(page); await shim.invoke('demo.seed', {})
  await page.addInitScript(() => {
    const wallNow = Date.now, interval = window.setInterval.bind(window)
    ;(window as any).__quietWallOffset = 0
    Date.now = () => wallNow() + (window as any).__quietWallOffset
    // Accelerate only the two existing pollers; their requests, caches and subscriptions stay real.
    window.setInterval = ((fn: any, ms: number, ...args: any[]) => interval(fn, ms === 20_000 ? 100 : (ms === 2_000 || ms === 10_000) ? 50 : ms, ...args)) as any
  })
  let phase = 'working', done: string | null = null, contact: string | null = null
  let hold = false, release!: () => void, held = false
  const gate = new Promise<void>(r => { release = r })
  await page.route('**/v1/companion/pet', async route => {
    if (hold) { held = true; await gate }
    return route.fulfill({ json: { owner_last_contact_at: contact, last_done_at: done,
      turn: { phase, since: '2026-10-29T10:00:00Z' }, pending_permissions: [] } })
  })
  let presenceReads = 0
  await page.route('**/v1/companion/presence', route => { presenceReads++; return route.fulfill({ json: { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } } }) })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openCompanion(page, shimUrl)
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('working')
  await toggleSettings(page)
  if (recovery === 'quiet') await page.getByRole('button', { name: '安静一小时' }).click()
  else if (recovery === 'user') await page.getByRole('checkbox', { name: '减少动作' }).check()
  else await page.emulateMedia({ reducedMotion: 'reduce' })
  hold = true
  await expect.poll(() => held).toBe(true)
  await page.evaluate(() => {
    ;(window as any).__quietBehaviors = []
    ;(window as any).__quietProps = []
    ;(window as any).__pet.machine.subscribe((s: any) => {
      const seen = (window as any).__quietBehaviors
      if (seen.at(-1) !== s.behavior) seen.push(s.behavior)
      ;(window as any).__quietProps.push(...s.props)
    })
  })
  const beforePresence = presenceReads
  if (recovery === 'quiet') await page.evaluate(() => { (window as any).__quietWallOffset = 3_600_001 })
  else if (recovery === 'user') await page.getByRole('checkbox', { name: '减少动作' }).uncheck()
  else await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => presenceReads).toBeGreaterThan(beforePresence)
  // A real unchanged presence response applies the cached working turn before the held fresh turn.
  await expect(page.getByRole('button', { name: '安静一小时' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('working')
  phase = 'idle'; done = '2026-10-29T11:00:00Z'; contact = done; hold = false; release()
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('idle')
  expect(await page.evaluate(() => (window as any).__quietBehaviors)).not.toContain('done')
  expect(await page.evaluate(() => (window as any).__quietBehaviors)).not.toContain('receive')
  expect(await page.evaluate(() => (window as any).__quietProps)).not.toContain('micro-light')
  // A genuinely new round still produces exactly one receipt and one completion.
  phase = 'working'
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('working')
  phase = 'idle'; done = '2026-10-29T12:00:00Z'; contact = done
  await expect.poll(() => page.evaluate(() => (window as any).__quietBehaviors.filter((b: string) => b === 'done').length)).toBe(1)
  await expect.poll(() => page.evaluate(() => (window as any).__pet.machine.snapshot().behavior)).toBe('idle')
  expect(await page.evaluate(() => (window as any).__quietBehaviors.filter((b: string) => b === 'done').length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__quietBehaviors.filter((b: string) => b === 'receive').length)).toBe(1)
})

for (const width of [200,240]) test(`factual task chooser opens exact tasks and preserves keyboard access at ${width}px`,async({page,shimUrl,shim})=>{
 await shim.invoke('demo.seed',{})
 await page.setViewportSize({width,height:250})
 await page.addInitScript(()=>{
  ;(window as any).__commands=[]
  ;(window as any).__TAURI__={core:{invoke:async(command:string,args:any)=>{
   ;(window as any).__commands.push({cmd:command,args})
   if(command==='show_main_window'||command==='close_companion_window')return null
   const response=await fetch('/__invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})
   const value=await response.json();if(value.error)throw Error(value.error);return value.result
  }}}
 })
 const activities=[{taskId:'deadbeef',title:'修好本地排版',phase:'needs_input',detail:'需要确认本地检查',updatedAt:1},{taskId:'bbbb2222',title:'<img src=x onerror=alert(1)>',phase:'working',detail:null,updatedAt:2}]
 await page.route('**/v1/companion/presence',route=>route.fulfill({json:{presence:'ok',activity:{kind:'idle',label:'',since:null},news:{unread:0,latest_kind:null,latest_title:null}}}))
 await page.route('**/v1/companion/pet',route=>route.fulfill({json:{owner_last_contact_at:null,last_done_at:null,turn:{phase:width===200?'working':'thinking',since:null},pending_permissions:[],activities}}))
 await openCompanion(page,shimUrl)
 const host=page.locator('#pet-tasks'),primary=page.locator('#pet-task-primary'),toggle=page.locator('#pet-task-toggle')
 await expect(primary).toContainText('修好本地排版');await expect(primary).toContainText('等你决定')
 await expect.poll(()=>page.evaluate(()=>(window as any).__pet.machine.snapshot().behavior)).toBe('permission')
 await page.locator('#pet-stage').evaluate(el=>(el as HTMLElement).click())
 await expect.poll(()=>page.evaluate(()=>(window as any).__commands.filter((c:any)=>c.cmd==='show_main_window'))).toEqual([{cmd:'show_main_window',args:{page:'workbench',taskId:'deadbeef'}}])
 await toggle.click();const second=page.locator('#pet-task-list [data-task-id="bbbb2222"]')
 await expect(second).toHaveText(/<img src=x onerror=alert\(1\)>/);expect(await host.locator('img').count()).toBe(0)
 await second.focus();await page.keyboard.press('Escape');await expect(page.locator('#pet-task-list')).toBeHidden();await expect(toggle).toBeFocused()
 expect(await page.evaluate(()=>(window as any).__commands.some((c:any)=>c.cmd==='close_companion_window'))).toBe(false)
 await toggle.click();await second.click()
 await expect.poll(()=>page.evaluate(()=>(window as any).__commands.filter((c:any)=>c.cmd==='show_main_window').at(-1))).toEqual({cmd:'show_main_window',args:{page:'workbench',taskId:'bbbb2222'}})
 const bounds=await host.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,height:innerHeight,width:innerWidth}})
 expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(bounds.width);expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
 await page.screenshot({path:`.superpowers/companion-tasks-${width}.png`})
})

test('a focused task choice survives factual reordering and falls back to a visible entry when removed',async({page,shimUrl,shim})=>{
 await shim.invoke('demo.seed',{});await attachShim(page)
 let activities=[{taskId:'deadbeef',title:'排版检查',phase:'working',detail:null,updatedAt:2},{taskId:'bbbb2222',title:'动作素材',phase:'working',detail:null,updatedAt:1}]
 await page.route('**/v1/companion/presence',route=>route.fulfill({json:{presence:'ok',activity:{kind:'idle',label:'',since:null},news:{unread:0,latest_kind:null,latest_title:null}}}))
 await page.route('**/v1/companion/pet',route=>route.fulfill({json:{owner_last_contact_at:null,last_done_at:null,turn:{phase:'idle',since:null},pending_permissions:[],activities}}))
 await openCompanion(page,shimUrl)
 await page.locator('#pet-task-toggle').click()
 const focused=page.locator('#pet-task-list [data-task-id="bbbb2222"]');await focused.focus()
 activities=[{...activities[1]!,updatedAt:3},activities[0]!]
 await expect(page.locator('#pet-task-list button').first()).toHaveAttribute('data-task-id','bbbb2222')
 await expect(focused).toBeFocused()
 activities=[activities[1]!]
 await expect(page.locator('#pet-task-toggle')).toBeHidden()
 await expect(page.locator('#pet-task-primary')).toBeFocused()
 await expect(page.locator('#pet-task-list')).toBeHidden()
})

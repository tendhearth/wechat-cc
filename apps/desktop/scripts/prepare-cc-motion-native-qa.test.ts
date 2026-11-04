import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareMotionNativeQA } from './prepare-cc-motion-native-qa.mjs'
import { createQAApi, createQAInvoke, createQAClock, captureQAObservation } from '../art/cc-v1/native-motion-qa/qa-bridge.mjs'
import * as qaBridge from '../art/cc-v1/native-motion-qa/qa-bridge.mjs'

function lifeClock(now:()=>number){
  const create=(qaBridge as any).createQALifeClock
  expect(typeof create,'native QA can advance eligibility while retaining real sprite timers').toBe('function')
  return create(now)
}

it('advances only the isolated monotonic eligibility clock and keeps real frame clocks and randomness intact',()=>{
  const host={performance:performance.now,wall:Date.now,random:Math.random,schedule:setTimeout,cancel:clearTimeout}
  let time=123
  const clock=lifeClock(()=>time)
  expect(clock.now()).toBe(123);expect(clock.offset()).toBe(0)
  expect([clock.random(),clock.random()]).toEqual([0,0])
  time=456;expect(clock.now()).toBe(456)
  clock.setOffset(75_000);expect(clock.now()).toBe(75_456)
  expect({performance:performance.now,wall:Date.now,random:Math.random,schedule:setTimeout,cancel:clearTimeout}).toEqual(host)
})

it('rejects backwards, nonfinite and unbounded native eligibility offsets without changing the accepted value',()=>{
  const clock=lifeClock(()=>1000)
  clock.setOffset(75_000);clock.setOffset(75_000)
  for(const value of [-1,74_999,NaN,Infinity,'1800000',14_400_001]){
    expect(()=>clock.setOffset(value)).toThrow('clock')
    expect(clock.offset()).toBe(75_000);expect(clock.now()).toBe(76_000)
  }
  clock.setOffset(14_400_000);expect(clock.now()).toBe(14_401_000)
})

it('forwards bounded companion motion controls but never arbitrary window or backend commands',async()=>{
 const calls:unknown[]=[]
 const invoke=createQAInvoke(async(command:string,args:unknown)=>{calls.push({command,args});return command==='companion_motion_context'?{token:7,minOffset:-48,maxOffset:48}:null})
 expect(await invoke('companion_motion_context')).toEqual({token:7,minOffset:-48,maxOffset:48})
 await invoke('step_companion_motion',{token:7,offset:-24});await invoke('stop_companion_motion')
 expect(calls).toHaveLength(3)
 for(const name of ['move_other_window','wechat_cli_json','daemon_request'])await expect(invoke(name)).rejects.toThrow(/blocked/)
 expect(calls).toHaveLength(3)
})

describe('isolated native motion QA', () => {
  it('serves only synthetic presence/pet facts and rejects every other backend request', async () => {
    const api = createQAApi()
    expect((await api.invokeApi('GET', '/v1/companion/presence')).presence).toBe('ok')
    api.setScenario('away')
    expect((await api.invokeApi('GET', '/v1/companion/presence')).presence).toBe('down')
    await expect(api.invokeApi('GET', '/v1/workbench')).rejects.toThrow('blocked')
    await expect(api.invokeApi('POST', '/v1/companion/pet')).rejects.toThrow('blocked')
    expect(() => api.setScenario('unknown')).toThrow('scenario')
    api.setScenario('completed')
    expect((await api.invokeApi('GET', '/v1/companion/pet')).last_done_at).toEqual(expect.any(String))
  })

  it('simulates a suspended wall clock without changing the host clock', () => {
    const hostNow = Date.now
    const clock = createQAClock(() => 1000)
    expect(clock.now()).toBe(1000)
    clock.setOffset(2 * 60 * 60_000)
    expect(clock.now()).toBe(7_201_000)
    expect(Date.now).toBe(hostNow)
  })

  it('rejects unbounded or invalid simulated clock offsets', () => {
    const clock = createQAClock(() => 1000)
    for (const value of [-1, NaN, Infinity, '7200000', 24 * 60 * 60_000]) expect(() => clock.setOffset(value)).toThrow('clock')
    expect(clock.now()).toBe(1000)
  })

  it('does not mistake a computed expired deadline for applied quiet-off controls', () => {
    const observation = captureQAObservation({ behavior: 'done' }, false, { getAttribute: () => 'true', textContent: '恢复动作' })
    expect(observation).toMatchObject({ behavior: 'done', quiet: false, quietPressed: 'true', quietAction: '恢复动作', quietOffApplied: false })
  })

  it('requires both the actual applied quiet-off control and expired preference', () => {
    const control = { getAttribute: () => 'false', textContent: '安静一小时' }
    expect(captureQAObservation({ behavior: 'idle' }, false, control).quietOffApplied).toBe(true)
    expect(captureQAObservation({ behavior: 'idle' }, true, control).quietOffApplied).toBe(false)
    expect(captureQAObservation({ behavior: 'idle' }, false, null).quietOffApplied).toBe(false)
  })

  it('allows only trusted native window controls and never forwards operator/backend commands', async () => {
    const calls: string[] = []
    const invoke = createQAInvoke(async (command: string) => { calls.push(command); return true })
    await invoke('reset_companion_position', {})
    expect(calls).toEqual(['reset_companion_position'])
    await expect(invoke('workbench_api', {})).rejects.toThrow('blocked')
    await expect(invoke('wechat_cli_json', {})).rejects.toThrow('blocked')
    expect(await invoke('pet_permission_resolve', {})).toBe(false)
    expect(calls).toEqual(['reset_companion_position'])
  })

  it('preserves the native drag origin and forwards only scoped movement and finish controls', async () => {
    const moved: unknown[] = []
    const invoke = createQAInvoke(async (command: string, args: unknown) => {
      if (command === 'start_companion_drag') return { x: 1000, y: 500 }
      moved.push([command, args]); return null
    })
    expect(await invoke('start_companion_drag')).toEqual({ x: 1000, y: 500 })
    await invoke('move_companion_window', { x: 920, y: 460 })
    await invoke('finish_companion_drag')
    expect(moved).toEqual([['move_companion_window', { x: 920, y: 460 }], ['finish_companion_drag', {}]])
    await expect(invoke('wechat_cli_json', {})).rejects.toThrow('blocked')
  })

  it('records a native acknowledgement only after the real command settles', async () => {
    let complete!: (value: unknown) => void
    const receipts: unknown[] = []
    const invoke = createQAInvoke(() => new Promise(resolve => { complete = resolve }), () => {}, value => { receipts.push(value) })
    const pending = invoke('finish_companion_drag')
    expect(receipts).toEqual([])
    complete(null); await pending
    expect(receipts).toEqual([{ command: 'finish_companion_drag', ok: true }])
    await expect(invoke('wechat_cli_json')).rejects.toThrow('blocked')
    expect(receipts).toHaveLength(1)
  })

  it('stages real UI code with isolated boundaries and excludes private boards and unfinished art', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'cc-motion-native-qa-'))
    const source = join(temporary, 'source'), destination = join(temporary, 'dist')
    const put = (path: string, text: string) => { const parts = path.split('/'); parts.pop(); mkdirSync(join(source, ...parts), { recursive: true }); writeFileSync(join(source, path), text) }
    try {
      put('companion-window.js', 'let storage = null; try { storage = window.localStorage } catch {}\nconst pet=await createPet(root,{life:true,})')
      put('companion-window.html', '<main>real companion fixture</main>')
      put('ui.test.js', 'fixture test code')
      put('ui.test.mjs', 'fixture test code')
      put('api.js', 'unsafe original API boundary')
      put('ipc.js', 'unsafe original native boundary')
      for(const path of ['pet/pet.js','pet/life/life-director.js','pet/renderer/sprite-renderer.js'])put(path,`unchanged player fixture: ${path}`)
      put('assets/pet/cc-v1/manifest.json', '\uFEFF' + JSON.stringify({ assets: { 'canonical/lit/front.png': {} } }))
      put('assets/pet/cc-v1/canonical/lit/front.png', 'accepted fixture bytes')
      put('assets/pet/cc-v1/motion/lit/unfinished.png', 'unfinished fixture bytes')
      put('assets/pet/cc-v1/CC_MASTER_V1.png', 'private fixture marker')
      put('assets/pet/cc-v1/CC_DESIGN_SHEET_V1.png', 'private fixture marker')
      prepareMotionNativeQA({ source, destination })
      expect(readFileSync(join(destination, 'companion-window.html'), 'utf8')).toBe('<main>real companion fixture</main>')
      expect(readFileSync(join(destination, 'companion-window.js'), 'utf8')).not.toContain('window.localStorage')
      expect(readFileSync(join(source, 'companion-window.js'), 'utf8')).toContain('window.localStorage')
      expect(readFileSync(join(destination, 'assets/pet/cc-v1/canonical/lit/front.png'), 'utf8')).toBe('accepted fixture bytes')
      for (const path of ['CC_MASTER_V1.png', 'CC_DESIGN_SHEET_V1.png', 'motion/lit/unfinished.png']) expect(existsSync(join(destination, 'assets/pet/cc-v1', path))).toBe(false)
      expect(existsSync(join(destination, 'ui.test.js'))).toBe(false)
      expect(existsSync(join(destination, 'ui.test.mjs'))).toBe(false)
      expect(readFileSync(join(destination, 'api.js'), 'utf8')).not.toContain('unsafe original')
      expect(readFileSync(join(destination, 'api.js'), 'utf8')).not.toContain('visibilitychange')
      expect(readFileSync(join(destination, 'api.js'), 'utf8')).toContain('cc-motion-qa-refresh')
      expect(readFileSync(join(destination, 'companion-window.js'), 'utf8')).toContain('Promise.all([poller.refresh(), petPoller.refresh()])')
      expect(readFileSync(join(destination, 'companion-window.js'), 'utf8')).toContain('window.__ccMotionQAControl = { pet, stopPolling:')
      expect(readFileSync(join(destination,'companion-window.js'),'utf8')).toContain('life:true,random:qaLifeClock.random,monotonicNow:qaLifeClock.now,')
      expect(readFileSync(join(destination,'companion-window.js'),'utf8')).toContain('setLifeClockOffset:qaLifeClock.setOffset')
      expect(readFileSync(join(source,'companion-window.js'),'utf8')).not.toContain('qaLifeClock')
      for(const path of ['pet/pet.js','pet/life/life-director.js','pet/renderer/sprite-renderer.js'])expect(readFileSync(join(destination,path))).toEqual(readFileSync(join(source,path)))
      expect(readFileSync(join(source, 'companion-window.js'), 'utf8')).not.toContain('__ccMotionQAControl')
      expect(readFileSync(join(destination, 'api.js'), 'utf8')).toContain('Date.now = qaClock.now')
      expect(readFileSync(join(source, 'companion-window.js'), 'utf8')).not.toContain('qaClock')
      expect(readFileSync(join(destination, 'ipc.js'), 'utf8')).not.toContain('unsafe original')
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })

  for(const count of [0,2])it(`preserves existing staged output if the native life options anchor appears ${count} times`,()=>{
    const temporary=mkdtempSync(join(tmpdir(),'cc-motion-qa-anchor-'))
    const source=join(temporary,'source'),destination=join(temporary,'dist')
    try{
      mkdirSync(join(source,'assets/pet/cc-v1'),{recursive:true});mkdirSync(destination)
      writeFileSync(join(source,'assets/pet/cc-v1/manifest.json'),JSON.stringify({assets:{}}))
      writeFileSync(join(source,'companion-window.js'),`storage = window.localStorage; ${'life:true,'.repeat(count)}`)
      writeFileSync(join(destination,'keep.txt'),'preserve existing staged fixture')
      expect(()=>prepareMotionNativeQA({source,destination})).toThrow('life options boundary')
      expect(readFileSync(join(destination,'keep.txt'),'utf8')).toBe('preserve existing staged fixture')
    }finally{rmSync(temporary,{recursive:true,force:true})}
  })
})

it('provides only synthetic task targets and retains them while disconnected for stale-target checks',async()=>{
 const api=createQAApi();api.setScenario('tasks')
 const body=await api.invokeApi('GET','/v1/companion/pet')
 expect(body.activities).toMatchObject([{taskId:'deadbeef',phase:'needs_input'},{taskId:'bbbb2222',phase:'working'}])
 api.setScenario('tasks-away');expect((await api.invokeApi('GET','/v1/companion/presence')).presence).toBe('down')
 expect((await api.invokeApi('GET','/v1/companion/pet')).activities).toEqual(body.activities)
 await expect(api.invokeApi('POST','/v1/workbench/deadbeef/reply')).rejects.toThrow('blocked')
})
it('native acknowledgements keep only validated complete task destinations',async()=>{
 const receipts:unknown[]=[];const invoke=createQAInvoke(async()=>null,()=>{},receipt=>receipts.push(receipt))
 await invoke('show_main_window',{page:'workbench',taskId:'deadbeef'})
 expect(receipts).toEqual([{command:'show_main_window',ok:true,destination:{page:'workbench',taskId:'deadbeef'}}])
 await invoke('show_main_window',{page:'workbench',taskId:'../secret',token:'private'})
 expect(receipts.at(-1)).toEqual({command:'show_main_window',ok:true})
})

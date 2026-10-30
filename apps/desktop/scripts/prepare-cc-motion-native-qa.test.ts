import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareMotionNativeQA } from './prepare-cc-motion-native-qa.mjs'
import { createQAApi, createQAInvoke, createQAClock, captureQAObservation } from '../art/cc-v1/native-motion-qa/qa-bridge.mjs'

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
      put('companion-window.js', 'let storage = null; try { storage = window.localStorage } catch {}')
      put('companion-window.html', '<main>real companion fixture</main>')
      put('ui.test.js', 'fixture test code')
      put('ui.test.mjs', 'fixture test code')
      put('api.js', 'unsafe original API boundary')
      put('ipc.js', 'unsafe original native boundary')
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
      expect(readFileSync(join(destination, 'api.js'), 'utf8')).toContain('Date.now = qaClock.now')
      expect(readFileSync(join(source, 'companion-window.js'), 'utf8')).not.toContain('qaClock')
      expect(readFileSync(join(destination, 'ipc.js'), 'utf8')).not.toContain('unsafe original')
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
})

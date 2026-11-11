import { supportsBrowserSnapshot } from './macmini-browser-snapshot.mjs'
import { supportsAppSnapshot } from './macmini-app-snapshot.mjs'
import { test, expect } from 'vitest'
import { main } from './macmini-ui.mjs'
import { readFileSync } from 'node:fs'

test('fake SSH carries gate limits to both remote lanes and propagates failure', () => {
  for (const lane of ['browser', 'unit', 'app-build', 'app-maestro']) {
    const calls = []
    const fakeSSH = (...args) => { calls.push(args); return { status: 124 } }
    expect(main(['node', 'entry', lane], { PATH: '/fake-ssh', CC_UI_LOCK_WAIT_MS: '20', CC_UI_LOAD_WAIT_MS: '30', CC_UI_JOB_TIMEOUT_MS: '40' }, fakeSSH)).toBe(124)
    expect(calls).toHaveLength(1)
    const [file, args, options] = calls[0]
    expect(file).toBe('ssh')
    expect(args.at(-1)).toContain('CC_UI_LOCK_WAIT_MS=20 CC_UI_LOAD_WAIT_MS=30 CC_UI_JOB_TIMEOUT_MS=40')
    expect(args.at(-1)).toContain(lane.startsWith('app-') ? 'app-run.mjs' : 'run.mjs')
    expect(JSON.parse(options.input).command).toBe(lane)
    expect(options.env.PATH).toBe('/fake-ssh')
  }
})

test('invalid limits fail before fake SSH executes', () => {
  for (const value of ['0', '-1', 'NaN', '1; touch /tmp/no', '1.2']) {
    expect(() => main(['node', 'entry', 'browser'], { CC_UI_LOCK_WAIT_MS: value }, () => { throw Error('SSH called') })).toThrow('Invalid machine gate limit')
  }
})

test('remote installed executor blocks verify and gates all CPU dispatch', () => {
  const remote = readFileSync(new URL('./macmini-ui-remote.mjs', import.meta.url), 'utf8')
  expect(remote).toContain("['affected', 'full', 'full-platform'].includes(request.command)")
  expect(remote).not.toContain("['run', 'verify'")
  expect(remote.indexOf('await acquireMachineLock')).toBeLessThan(remote.indexOf('switch (request.command)'))
  expect(remote).toContain('onAcquired: lifecycle.acquired')
  expect(remote).toContain('lifecycle.track(child)')
  const snapshot = readFileSync(new URL('./macmini-app-snapshot.mjs', import.meta.url), 'utf8')
  expect(snapshot.indexOf('await acquireMachineLock')).toBeLessThan(snapshot.indexOf("tar = spawn"))
})

test('both installed desktop and App receivers acquire the machine gate before work', () => {
  for (const name of ['macmini-ui-remote.mjs', 'macmini-app-snapshot.mjs']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8')
    expect(source).toContain("path: join(mini.homeDir, 'ci/lock')")
    expect(source).toContain('await acquireMachineLock')
    expect(source).toContain('onAcquired: lifecycle.acquired')
    expect(source).toContain('lifecycle.track(')
  }
})

test('legacy verify lanes fail locally before reaching even an old remote', () => {
  for (const lane of ['affected', 'full', 'full-platform']) {
    expect(() => main(['node', 'entry', lane], {}, () => { throw Error('SSH called') })).toThrow('verify runs on the primary Mac')
  }
})

test('browser transport is isolated from the App and native desktop wrappers', () => {
  const calls=[]
  main(['node','entry','browser'],{},(...args)=>{calls.push(args);return {status:0}})
  expect(calls[0][1].at(-1)).toContain('/browser-run.mjs')
  const receiver=readFileSync(new URL('./macmini-browser-snapshot.mjs',import.meta.url),'utf8')
  expect(receiver.indexOf('await acquireMachineLock')).toBeLessThan(receiver.indexOf("await mkdir(join(root,'project')"))
  expect(receiver).toContain('archiveSha256')
  expect(receiver).toContain('Workspace dependency leaves snapshot')
  expect(receiver).toContain("{...config,browserRoot:root}")
  expect(receiver).not.toContain('appRoot:')
  const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
  expect(remote).toContain("probe.listen(4198,'127.0.0.1'")
  expect(remote).toContain('Browser snapshot changed while queued')
  expect(remote).toContain("'t5-conversation.spec.ts'")
  expect(remote).toContain("'task-detail-minimal.spec.ts'")
  expect(remote).toContain("'workbench-line-review.spec.ts'")
})

test('browser launch uses the known lab Chromium without changing product or App launchers',()=>{
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 expect(remote).toContain("await insideLab(join(config.browserRuntimeRoot??config.root,'browser-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'))")
 expect(remote).toContain('CC_UI_BROWSER_EXECUTABLE:browserExecutable')
 const config=readFileSync(new URL('../playwright.config.ts',import.meta.url),'utf8')
 expect(config).toContain('process.env.CC_UI_BROWSER_EXECUTABLE')
 expect(config).toContain('Lab browser must remain inside the dedicated mini lab')
})

test('snapshot modules expose an explicit entry for trusted import wrappers and browser caches stay separate',()=>{
 for(const name of ['macmini-app-snapshot.mjs','macmini-browser-snapshot.mjs']){
  const source=readFileSync(new URL(name,import.meta.url),'utf8')
  expect(source).toContain('export async function main()')
  expect(source).toContain('lifecycle.assertRunning()')
 }
 const browser=readFileSync(new URL('./macmini-browser-snapshot.mjs',import.meta.url),'utf8')
 expect(browser).toContain('config.browserSourceRoot??config.appRoot')
 expect(browser).toContain("readFile(join(cacheRoot,'snapshot.json')")
 expect(browser).toContain('PUBLIC_CACHE_COMMIT')
 expect(browser).toContain("gitObject('blob',bytes)!==file.blob")
})

test('project topic snapshots accept only the explicit task branch and preserve source ref boundaries',()=>{
 expect(supportsBrowserSnapshot('cc-alive-2')).toBe(true)
 expect(supportsAppSnapshot('cc-alive-2')).toBe(true)
 expect(supportsBrowserSnapshot('topics-are-projects')).toBe(true)
 expect(supportsAppSnapshot('topics-are-projects')).toBe(true)
 expect(supportsBrowserSnapshot('topics-waiting-honest')).toBe(true)
 expect(supportsAppSnapshot('topics-waiting-honest')).toBe(true)
 for(const ref of ['master','unknown-task','topics-are-projects;echo x','../topics-are-projects']){
  expect(supportsBrowserSnapshot(ref)).toBe(false)
  expect(supportsAppSnapshot(ref)).toBe(false)
 }
})


test('B3 accepts only the assigned immutable source branch and includes its page regressions',()=>{
 expect(supportsBrowserSnapshot('design-b3')).toBe(true)
 expect(supportsAppSnapshot('design-b3')).toBe(true)
 for(const ref of ['design-b3-other','design-b3;echo x','../design-b3']){
  expect(supportsBrowserSnapshot(ref)).toBe(false)
  expect(supportsAppSnapshot(ref)).toBe(false)
 }
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 for(const spec of ['memory.spec.ts','settings-projects.spec.ts'])expect(remote).toContain("'"+spec+"'")
})

test('attention UI evidence uses the locked browser lane and a test-only baseline harness',()=>{
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 const receiver=readFileSync(new URL('./macmini-browser-snapshot.mjs',import.meta.url),'utf8')
 expect(remote).toContain("['design-unify-shots.spec.ts','cc-alive-shots.spec.ts']")
 expect(receiver).toContain("['cc-alive-shots.spec.ts','apps/desktop/playwright/cc-alive-shots.spec.ts']")
 expect(supportsBrowserSnapshot('cc-alive-2;echo x')).toBe(false)
 expect(supportsAppSnapshot('../cc-alive-2')).toBe(false)
 expect(remote).toContain("selected.appRoot !== config.appRoot")
 expect(remote.indexOf('assertExpectedSource(process.env.CC_UI_EXPECTED_SOURCE, actual)')).toBeLessThan(remote.indexOf('await mkdir(run'))
})

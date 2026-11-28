import { supportsBrowserSnapshot } from './macmini-browser-snapshot.mjs'
import { supportsAppSnapshot } from './macmini-app-snapshot.mjs'
import { test, expect } from 'vitest'
import { assertPushedSource, browserHarness, sshInvocation } from './macmini-ui-protocol.mjs'
import { main } from './macmini-ui.mjs'
import { readFileSync } from 'node:fs'

const jsonBody = input => JSON.parse(input.subarray(4 + input.readUInt32BE(0)))

test('fake SSH carries gate limits to both remote lanes and propagates failure', () => {
  for (const lane of ['status', 'doctor', 'native-smoke', 'capture', 'browser', 'unit', 'embedded',
    'embedded-build', 'production-build', 'app-status', 'app-prepare', 'app-build', 'app-maestro']) {
    const calls = []
    const fakeSSH = (...args) => { calls.push(args); return { status: 124 } }
    expect(main(['node', 'entry', lane], { PATH: '/fake-ssh', CC_UI_LOCK_WAIT_MS: '20', CC_UI_LOAD_WAIT_MS: '30', CC_UI_JOB_TIMEOUT_MS: '40' }, fakeSSH)).toBe(124)
    expect(calls).toHaveLength(1)
    const [file, args, options] = calls[0]
    expect(file).toBe('ssh')
    expect(args.at(-1)).toContain('CC_UI_LOCK_WAIT_MS=20 CC_UI_LOAD_WAIT_MS=30 CC_UI_JOB_TIMEOUT_MS=40')
    expect(args.at(-1)).toContain('/macmini-lab-bootstrap.mjs')
    expect(jsonBody(options.input).command).toBe(lane)
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
  expect(calls[0][1].at(-1)).toContain('/macmini-lab-bootstrap.mjs')
  expect(sshInvocation('browser').args.at(-1)).toContain('/browser-run.mjs')
  expect(sshInvocation('unit').args.at(-1)).toContain('/run.mjs')
  const receiver=readFileSync(new URL('./macmini-browser-snapshot.mjs',import.meta.url),'utf8')
  const lock = receiver.indexOf('await acquire(')
  expect(lock).toBeGreaterThanOrEqual(0)
  expect(lock).toBeLessThan(receiver.indexOf('await (fs.mkdir??nativeFs.mkdir)(snapshotRoot'))
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

test('snapshot refs are plain names; anything a shell or git would read differently is refused',()=>{
 for(const ref of ['cc-alive-2','topics-are-projects','integrate/1127','origin/dev','codex/lab-health','v1.8.12']){
  expect(supportsBrowserSnapshot(ref)).toBe(true)
  expect(supportsAppSnapshot(ref)).toBe(true)
 }
})

test('only commits already on a pushed origin/* branch may be sent',()=>{
 const git=out=>()=>Buffer.from(out)
 expect(assertPushedSource(git('  origin/dev\n  origin/codex/x\n'),'a'.repeat(40))).toEqual(['origin/dev','origin/codex/x'])
 expect(()=>assertPushedSource(git(''),'b'.repeat(40))).toThrow(/not on any pushed origin\/\* branch/)
 expect(()=>assertPushedSource(git('  upstream/dev\n'),'c'.repeat(40))).toThrow(/push it/)
})

test('reply speaker transports the registered App flow', () => {
  const calls = []
  expect(main(['node', 'entry', 'app-maestro', 'reply-speaker'], {}, (...args) => { calls.push(args); return { status: 0 } })).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0][1].at(-1)).toContain('/macmini-lab-bootstrap.mjs')
  expect(sshInvocation('app-maestro', 'home', undefined, 'reply-speaker').args.at(-1)).toContain('/app-run.mjs')
  expect(jsonBody(calls[0][2].input)).toEqual({ command: 'app-maestro', flow: 'reply-speaker' })
})


test('B3 includes its page regressions',()=>{
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 for(const spec of ['memory.spec.ts','settings-projects.spec.ts'])expect(remote).toContain("'"+spec+"'")
})

test('attention UI evidence uses the locked browser lane and a test-only baseline harness',()=>{
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 const receiver=readFileSync(new URL('./macmini-browser-snapshot.mjs',import.meta.url),'utf8')
 expect(remote).toContain("['design-unify-shots.spec.ts','cc-alive-shots.spec.ts']")
 expect(receiver).toContain("target === 'browser' ? browserHarness : []")
 expect(browserHarness).toContainEqual(['cc-alive-shots.spec.ts','apps/desktop/playwright/cc-alive-shots.spec.ts'])
 expect(remote).toContain("selected.appRoot !== config.appRoot")
 expect(remote.indexOf('assertExpectedSource(process.env.CC_UI_EXPECTED_SOURCE, actual)')).toBeLessThan(remote.indexOf('await mkdir(run'))
})





test('CLI setup runs its regression after the baseline',()=>{
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 const suites=remote.match(/const specs=phase==='before' \? (\[[^\]]*\]) : (\[[^\]]*\])/)
 expect(suites).not.toBeNull()
 expect(suites[1]).not.toContain("'cli-setup.spec.ts'")
 expect(suites[2]).toContain("'cli-setup.spec.ts'")
})


test('unified acceptance uses the bounded suite',()=>{
 const calls=[]
 main(['node','entry','browser','homebot'],{CC_UI_BROWSER_SUITE:'mini-ui-acceptance'},(...args)=>{calls.push(args);return{status:0}})
 expect(calls[0][1].at(-1)).toContain('CC_UI_BROWSER_SUITE=mini-ui-acceptance')
 expect(()=>main(['node','entry','browser'],{CC_UI_BROWSER_SUITE:'arbitrary.spec.ts'},()=>{throw Error('SSH called')})).toThrow('Invalid browser suite')
 const remote=readFileSync(new URL('./macmini-ui-remote.mjs',import.meta.url),'utf8')
 expect(remote).toContain("'butler-checkup.spec.ts'")
 expect(remote).toContain("['task-detail-minimal.spec.ts','--grep','ordinary single-executor']")
})


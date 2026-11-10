import { afterEach, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findOnPath } from '../src/lib/util'
import { makeProcessTreeFreezer } from '../src/lib/process-tree-freeze'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

async function verify(mode: 'silent' | 'noisy' | 'teardown' | 'real-import' | 'orphan' | 'worker-teardown' | 'success') {
  const root = mkdtempSync(join(tmpdir(), 'verify-timeout-')); roots.push(root)
  const bin = join(root, 'bin'); mkdirSync(bin); mkdirSync(join(root, 'apps/app'), { recursive: true })
  const node = findOnPath('node')!, bun = findOnPath('bun')!
  if (mode === 'real-import') {
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir')
    writeFileSync(join(root, 'fixture.config.mjs'), "export default {test:{include:['import-hang.test.ts'],maxWorkers:1}}")
    writeFileSync(join(root, 'import-hang.test.ts'), "import {it} from 'vitest'; await new Promise(()=>{}); it('never reached',()=>{});")
  }
  writeFileSync(join(root, 'fake-test.cjs'), `#!${node}
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');
if (process.argv[3] !== 'test') process.exit(0);
if (${JSON.stringify(mode)} === 'real-import') {
  const result = require('node:child_process').spawnSync(${JSON.stringify(bun)}, ['--bun', ${JSON.stringify(resolve('node_modules/vitest/vitest.mjs'))}, 'run', '--config', 'fixture.config.mjs', ...process.argv.slice(4)], {stdio:'inherit'});
  process.exit(result.status ?? 1);
}
if (${JSON.stringify(mode)} === 'success') { console.log('fixture passed'); process.exit(0); }
const child = spawn(process.execPath, ['-e', ${JSON.stringify(mode)} === 'orphan' ? 'setInterval(()=>console.log("orphan busy"),15)' : 'setInterval(()=>{},1000)'], {detached:true,stdio:${JSON.stringify(mode)} === 'orphan' ? 'inherit' : 'ignore'});
writeFileSync('child.pid', String(child.pid));
if (['noisy', 'teardown', 'worker-teardown', 'orphan'].includes(${JSON.stringify(mode)})) {
  console.log('\\x1eCC_VERIFY:' + process.env.CC_VERIFY_PROGRESS_TOKEN + ':' + JSON.stringify({event:'start',file:'fixture/hanging.test.ts'}));
  if (['teardown', 'worker-teardown'].includes(${JSON.stringify(mode)})) {
    console.log('\\x1eCC_VERIFY:' + process.env.CC_VERIFY_PROGRESS_TOKEN + ':' + JSON.stringify({event:'end',file:'fixture/hanging.test.ts'}));
    if (${JSON.stringify(mode)} === 'teardown') console.log('\\x1eCC_VERIFY:' + process.env.CC_VERIFY_PROGRESS_TOKEN + ':' + JSON.stringify({event:'finished'}));
  }
  if (${JSON.stringify(mode)} === 'orphan') setTimeout(()=>process.exit(0), 1000);
  setInterval(()=>process.stdout.write('still busy\\n'), 15);
} else setInterval(()=>{}, 1000);
`, { mode: 0o755 })
  writeFileSync(join(bin, 'bun'), `#!/bin/sh
if [ \"$2\" = test ]; then exec ${JSON.stringify(node)} ${JSON.stringify(join(root, 'fake-test.cjs'))} \"$@\"; fi
exit 0
`, { mode: 0o755 })
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const child = spawn(bun, [resolve('scripts/verify.ts'), '--full'], { cwd: root, detached: true,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, CC_VERIFY_FILE_TIMEOUT_MS: mode === 'orphan' ? '2500' : '200', CC_VERIFY_SILENCE_TIMEOUT_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', guardFired = false
  child.stdout.on('data', b => { output += b.toString() }); child.stderr.on('data', b => { output += b.toString() })
  const tree = makeProcessTreeFreezer(() => child.pid)
  const guard = setTimeout(() => { guardFired = true; tree.freeze(); tree.kill(); try { process.kill(-Number(readFileSync(join(root, 'child.pid'), 'utf8')), 'SIGKILL') } catch { /* owned fixture only */ } }, 12000)
  const status = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', code => done(code)) })
  clearTimeout(guard)
  // The fixture deliberately starts a separate group, as real test workers can.
  let pid = 0
  try { pid = Number(readFileSync(join(root, 'child.pid'), 'utf8')) } catch { /* success fixture */ }
  let alive = false
  if (pid) {
    // ps distinguishes a terminated zombie waiting for reaping from a live worker.
    const until = Date.now() + 1000
    do {
      alive = false
      try { const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {encoding:'utf8'}).trim(); alive = !!state && !state.startsWith('Z') } catch { /* gone */ }
      if (!alive || Date.now() >= until) break
      // SIGKILL delivery and reaping are asynchronous; require actual death,
      // rather than observing the scheduler's immediate post-signal window.
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (alive)
    try { process.kill(-pid, 'SIGKILL') } catch { /* fixture cleanup after a failed assertion */ }
  }
  return { status, output, guardFired, alive }
}

it.skipIf(process.platform === 'win32')('verify ends a silent test stage, names the timeout and kills its descendants', async () => {
  const result = await verify('silent')
  expect(result.guardFired).toBe(false)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toMatch(/超时|timeout/i)
  expect(result.output).toContain('测试(bun)')
  expect(result.alive).toBe(false)
})
it.skipIf(process.platform === 'win32')('verify expires a single hanging file even while it keeps printing', async () => {
  const result = await verify('noisy')
  expect(result.guardFired).toBe(false)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toMatch(/超时|timeout/i)
  expect(result.output).toContain('fixture/hanging.test.ts')
  expect(result.output).toMatch(/\d+(?:\.\d+)?s/)
  expect(result.alive).toBe(false)
})
it.skipIf(process.platform === 'win32')('verify preserves a successful test stage and exits zero', async () => {
  const result = await verify('success')
  expect(result.guardFired).toBe(false)
  expect(result.status).toBe(0)
  expect(result.output).toContain('fixture passed')
})

it.skipIf(process.platform === 'win32')('verify expires noisy teardown after all modules ended and names the last file', async () => {
  const result = await verify('teardown')
  expect(result.guardFired).toBe(false)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('测试收尾')
  expect(result.output).toContain('fixture/hanging.test.ts')
  expect(result.alive).toBe(false)
})

it.skipIf(process.platform === 'win32')('the real Vitest reporter names a file that hangs during import', async () => {
  const result = await verify('real-import')
  expect(result.guardFired).toBe(false)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('单文件超过')
  expect(result.output).toContain('import-hang.test.ts')
  expect(result.output).toContain('正在跑:')
})

it.skipIf(process.platform === 'win32')('verify bounds worker teardown before the run-end reporter event despite continued output', async () => {
  const result = await verify('worker-teardown')
  expect(result.guardFired).toBe(false)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('测试收尾')
  expect(result.output).toContain('fixture/hanging.test.ts')
  expect(result.alive).toBe(false)
})
it.skipIf(process.platform === 'win32')('verify times out after the test launcher exits and kills an observed orphan holding its pipes', async () => {
  const result = await verify('orphan')
  expect(result.guardFired).toBe(false)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('超时')
  expect(result.output).toContain('fixture/hanging.test.ts')
  expect(result.alive).toBe(false)
})

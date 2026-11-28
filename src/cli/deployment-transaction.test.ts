import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'

const childScript = `
if (!process.versions.bun) {
  globalThis.require = require;
  const { extname } = require('node:path');
  require('node:module').registerHooks({
    resolve(id, context, next) {
      return next(id.startsWith('.') && !extname(id) ? id + '.ts' : id, context);
    }
  });
}
const { acquireDeploymentLock } = require(process.argv[1]);
const input = require('node:readline').createInterface({ input: process.stdin });
let held;
input.on('line', () => {
  if (held) { console.log('held'); return; }
  const lock = acquireDeploymentLock(process.argv[2]);
  if ('busy' in lock) console.log('busy');
  else { held = lock; console.log('held'); }
});
`

it('returns busy across concurrent processes and releases the same lock when its holder is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-deploy-lock-'))
  function worker() {
    const args = process.versions.bun ? [] : ['--experimental-transform-types']
    const child = spawn(process.execPath, [...args, '--eval', childScript,
      resolve('src/cli/deployment-transaction.ts'), dir], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    const closed = once(child, 'close')
    const lines = createInterface({ input: child.stdout })
    return {
      async acquire() {
        const next = Promise.race([
          once(lines, 'line').then(([line]) => line),
          closed.then(() => { throw new Error('lock worker exited') }),
        ])
        child.stdin.write('acquire\n')
        return next
      },
      async kill() { child.kill('SIGKILL'); await closed },
    }
  }
  const holder = worker()
  const challenger = worker()
  try {
    expect(await holder.acquire()).toBe('held')
    const started = performance.now()
    expect(await challenger.acquire()).toBe('busy')
    expect(performance.now() - started).toBeLessThan(2000)
    await holder.kill()
    expect(await challenger.acquire()).toBe('held')
  } finally {
    await Promise.all([holder.kill(), challenger.kill()])
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)

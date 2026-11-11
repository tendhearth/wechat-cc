import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findOnPath } from '../../lib/util'
import { removeTempDir } from '../../lib/test-temp'
import { taskEnvironment } from './task-environment'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

it.skipIf(process.platform !== 'darwin')('#891: offline frozen install, run, Vitest and bunx work in real Seatbelt with task uptime', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-task-bun-'))); roots.push(root)
  const home = join(root, 'home'), pkg = join(root, 'package')
  mkdirSync(home); mkdirSync(pkg)
  const check = "if (!(require('node:os').uptime() > 60)) throw Error('missing task uptime');"
  const cli = '#!/usr/bin/env node\n' + check + "console.log('offline-fixture-ok:'+Boolean(globalThis.Bun))\n"
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'offline-fixture', version: '1.0.0', bin: { 'offline-fixture': 'cli.cjs' } }))
  writeFileSync(join(pkg, 'cli.cjs'), cli, { mode: 0o700 })
  execFileSync('/usr/bin/tar', ['-czf', join(root, 'fixture.tgz'), '-C', root, 'package'])
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'task-fixture', version: '1.0.0',
    dependencies: { 'offline-fixture': 'file:./fixture.tgz' }, scripts: { probe: 'bun probe.cjs' } }))
  const bun = realpathSync(findOnPath('bun')!), task = await taskEnvironment(root, 'abcd1234')
  const env = { ...process.env, ...task, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home }
  // No network and no writes outside this task; deny the real uptime syscall.
  const profile = `(version 1)(deny default)(allow process*)(allow mach-lookup)(allow sysctl-read)(deny sysctl-read (sysctl-name "kern.boottime"))(allow file-read*)(allow file-write* (subpath ${JSON.stringify(root)}))`
  const sandbox = (command: string, args: string[]) => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, command, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })
  // Generate a real lock offline, then require the wrapper to reinstall from it.
  sandbox(bun, ['install', '--ignore-scripts'])
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8')
  rmSync(join(root, 'node_modules'), { recursive: true })
  sandbox('bun', ['install', '--frozen-lockfile'])
  expect(readFileSync(join(root, 'node_modules/offline-fixture/cli.cjs'), 'utf8')).toBe(cli)
  expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toBe(lock)
  const nestedInstall = `require('node:child_process').execFileSync(process.execPath,['install','--frozen-lockfile'],{stdio:'pipe'});`
  writeFileSync(join(root, 'probe.cjs'), check + nestedInstall + "console.log('run-ok')")
  expect(sandbox('bun', ['run', 'probe'])).toContain('run-ok')
  expect(sandbox('bunx', ['--no-install', 'offline-fixture'])).toContain('offline-fixture-ok:')
  expect(sandbox('bunx', ['--no-install', '--bun', 'offline-fixture'])).toContain('offline-fixture-ok:')
  // Use the actual installed Vitest CLI, not a bin double or a registry download.
  symlinkSync(resolve('node_modules/vitest'), join(root, 'node_modules/vitest'), 'dir')
  symlinkSync('../vitest/vitest.mjs', join(root, 'node_modules/.bin/vitest'))
  writeFileSync(join(root, 'vitest.config.mjs'), "export default {test:{include:['uptime.test.mjs'],maxWorkers:1}}")
  writeFileSync(join(root, 'uptime.test.mjs'), "import {it,expect} from 'vitest';import {uptime} from 'node:os';it('task uptime',()=>expect(uptime()).toBeGreaterThan(60));")
  expect(sandbox('bun', ['--bun', 'vitest', 'run', '--config', 'vitest.config.mjs'])).toContain('1 passed')
}, 60_000)

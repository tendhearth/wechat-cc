import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
import { execFileSync } from 'node:child_process'
import { runApp } from './macmini-ui-app.mjs'

let lab, root, context, calls
beforeEach(async () => {
  lab = await realpath(await mkdtemp(join(tmpdir(), 'cc-app-lane-')))
  root = join(lab, 'snapshot')
  const cwd = join(root, 'project/apps/app')
  for (const path of [cwd, join(lab, 'app-tools/java/Contents/Home'), join(cwd, '.maestro'), join(root, 'build/Build/Products/Release-iphonesimulator/Tendhearth.app'), join(root, 'artifacts'), join(root, 'maestro-driver/driver-iPhoneSimulator/Debug-iphonesimulator/maestro-driver-iosUITests-Runner.app')]) await mkdir(path, { recursive: true })
  const source = { commit: 'a'.repeat(40) }
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(source))
  await writeFile(join(root, 'build-receipt.json'), JSON.stringify({ source, app: join(root, 'build/Build/Products/Release-iphonesimulator/Tendhearth.app') }))
  await writeFile(join(root, 'simulator.json'), JSON.stringify({ udid: 'lab-udid' }))
  for (const name of ['cc-acts', 'push-open', 'terminal-sessions']) await writeFile(join(cwd, '.maestro', name + '.yaml'), '')
  execFileSync.mockImplementation((file, args) => {
    expect(file).toBe('/usr/bin/xcrun')
    expect(args.slice(0, 3)).toEqual(['simctl', '--set', join(root, 'simulators')])
    return JSON.stringify({ devices: { ios: [{ name: 'CC UI Lab App', udid: 'lab-udid', state: 'Shutdown' }] } })
  })
  calls = []
  context = { request: { command: 'app-maestro', flow: 'all' }, config: { appRoot: root }, labHome: lab, run: join(root, 'artifacts'),
    environment: { PATH: '/usr/bin:/bin' },
    insideLab: async path => { const resolved = await realpath(path); if (!resolved.startsWith(lab + '/')) throw Error('outside lab'); return resolved },
    command: async (label, file, args, options) => { calls.push({ label, file, args, options }); if (label === 'maestro-push-open') throw Error('fixture failure'); return { exitCode: 0 } } }
})
afterEach(async () => { await rm(lab, { recursive: true, force: true }); vi.clearAllMocks() })

test('all flows retain individual failures, continue the suite and shut down only the owned simulator', async () => {
  await expect(runApp(context)).rejects.toThrow('Maestro failed')
  const receipt = JSON.parse(await readFile(join(context.run, 'app-results.json'), 'utf8'))
  expect(receipt.results.map(result => [result.flow, result.ok])).toEqual([['cc-acts', true], ['push-open', false], ['terminal-sessions', true]])
  expect(calls.at(-1).label).toBe('simulator-shutdown')
  for (const call of calls.filter(call => call.file.endsWith('/bin/maestro'))) {
    expect(call.args.slice(0, 3)).toEqual(['--device', 'lab-udid', 'test'])
    expect(call.options.extraEnv.HOME).toBe(join(root, 'home'))
    expect(call.options.extraEnv).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(call.options).not.toHaveProperty('offline', false)
  }
})

test('a stale build receipt or unregistered flow fails before boot or installation', async () => {
  await writeFile(join(root, 'snapshot.json'), JSON.stringify({ commit: 'b'.repeat(40) }))
  await expect(runApp(context)).rejects.toThrow('does not match')
  expect(calls).toEqual([])
})

test('a snapshot with an unknown flow never boots a simulator', async () => {
  await writeFile(join(root, 'project/apps/app/.maestro/unregistered.yaml'), '')
  await expect(runApp(context)).rejects.toThrow('unregistered')
  expect(calls).toEqual([])
})

test('an App snapshot is required and paths cannot escape the lab', async () => {
  await expect(runApp({ ...context, config: {} })).rejects.toThrow('APP_BLOCKED')
  await expect(runApp({ ...context, config: { appRoot: '/' } })).rejects.toThrow('outside lab')
  expect(calls).toEqual([])
})

test('a failed rebuild invalidates its previous receipt without starting a simulator', async () => {
  context.request = { command: 'app-build' }
  context.command = async () => { throw Error('build fixture failure') }
  await expect(runApp(context)).rejects.toThrow('build fixture failure')
  await expect(readFile(join(root, 'build-receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(execFileSync).not.toHaveBeenCalled()
})

test('only the explicit preparation command permits public dependency downloads', async () => {
  context.request = { command: 'app-prepare' }
  await expect(runApp(context)).resolves.toMatchObject({ prepared: true })
  expect(calls.map(call => call.label)).toEqual(['app-js-dependencies', 'expo-prebuild-prepare', 'pods-prepare'])
  expect(calls.every(call => call.options.offline === false)).toBe(true)
  expect(calls[0].args).toEqual(['install', '--frozen-lockfile', '--ignore-scripts'])
  expect(execFileSync).not.toHaveBeenCalled()
})

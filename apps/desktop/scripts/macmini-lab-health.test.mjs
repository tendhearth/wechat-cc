import { expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { labHealth } from './macmini-lab-health.mjs'

const GiB = 1024 ** 3
const NOW = 1_800_000_000_000
const snapshot = (kind, timestamp) => `${kind}-${'a'.repeat(40)}-${timestamp}`

async function fixture(run) {
  const root = await fs.mkdtemp(join(tmpdir(), 'lab-health-'))
  const labHome = join(root, 'cc-ui-lab'), lockPath = join(root, 'ci', 'lock')
  await fs.mkdir(labHome, { recursive: true }); await fs.mkdir(join(root, 'ci'))
  try { return await run({ root, labHome, lockPath }) } finally { await fs.rm(root, { recursive: true, force: true }) }
}
// statfs and realpath are the only calls that depend on the real machine.
const fakeFs = ({ freeGiB = 100, real } = {}) => ({ ...fs,
  statfs: async () => ({ bavail: freeGiB * GiB / 4096, bsize: 4096 }),
  ...(real ? { realpath: async () => real } : {}) })

test('a healthy lab has no warnings', () => fixture(async ({ labHome, lockPath }) => {
  await fs.mkdir(join(labHome, snapshot('app', 1))); await fs.mkdir(join(labHome, snapshot('browser', 1)))
  await fs.mkdir(join(labHome, 'runtime-20261030'))
  const health = await labHealth({ labHome, lockPath, fs: fakeFs(), now: () => NOW })
  expect(health.warnings).toEqual([])
  expect(health).toMatchObject({ diskFreeGiB: 100, lock: { held: false }, snapshots: { app: 1, browser: 1 } })
}))

test('warns about a low disk and piled-up snapshots of one kind', () => fixture(async ({ labHome, lockPath }) => {
  for (const t of [1, 2, 3, 4, 5]) await fs.mkdir(join(labHome, snapshot('browser', t)))
  await fs.mkdir(join(labHome, 'browser-not-a-snapshot'))
  const health = await labHealth({ labHome, lockPath, fs: fakeFs({ freeGiB: 14 }), now: () => NOW })
  expect(health.snapshots).toEqual({ app: 0, browser: 5 })
  expect(health.warnings).toEqual([
    `disk_low: 14 GiB free under ${labHome}`,
    'snapshots_piling_up: 5 browser snapshots (retention keeps referenced + newest 2)',
  ])
}))

test('a lock whose holder died is stale; a live holder past two hours is held long', () => fixture(async ({ labHome, lockPath }) => {
  await fs.mkdir(lockPath)
  const since = NOW / 1000 - 3 * 3600
  await fs.writeFile(join(lockPath, 'info'), `pid=4242\nsince=${since}\nowner=browser\n`)
  const dead = await labHealth({ labHome, lockPath, fs: fakeFs(), now: () => NOW, alive: () => false })
  expect(dead.lock).toEqual({ held: true, owner: 'browser', pid: 4242, heldSec: 3 * 3600, stale: true })
  expect(dead.warnings).toEqual(['lock_stale: owner=browser pid=4242 (next job reclaims it)'])
  const live = await labHealth({ labHome, lockPath, fs: fakeFs(), now: () => NOW, alive: () => true })
  expect(live.warnings).toEqual(['lock_held_long: owner=browser for 180 min'])
  await fs.writeFile(join(lockPath, 'info'), `pid=4242\nsince=${NOW / 1000 - 60}\nowner=browser\n`)
  expect((await labHealth({ labHome, lockPath, fs: fakeFs(), now: () => NOW, alive: () => true })).warnings).toEqual([])
}))

test('a lab whose real path is on an external volume is flagged', () => fixture(async ({ labHome, lockPath }) => {
  const health = await labHealth({ labHome, lockPath, fs: fakeFs({ real: '/Volumes/Build/cc-ui-lab' }), now: () => NOW })
  expect(health.labRealPath).toBe('/Volumes/Build/cc-ui-lab')
  expect(health.warnings).toEqual(['lab_on_external_volume: /Volumes/Build/cc-ui-lab — launchd agents cannot read it without a privacy grant'])
}))

test('never throws when parts cannot be read', () => fixture(async ({ root, lockPath }) => {
  const missing = join(root, 'gone')
  const failingStatfs = { ...fs, statfs: async () => { throw Object.assign(Error('denied'), { code: 'EPERM' }) } }
  const health = await labHealth({ labHome: missing, lockPath, fs: failingStatfs, now: () => NOW })
  expect(health).toMatchObject({ diskFreeGiB: null, labRealPath: null, snapshots: null, lock: { held: false } })
  expect(health.warnings).toEqual(['disk_unknown: EPERM', 'lab_unreadable: ENOENT', 'snapshots_unknown: ENOENT'])
}))

import { test, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireMachineLock, lockStale } from './macmini-machine-lock.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'cc-machine-lock-'))
  const path = join(root, 'lock')
  let time = 1000000
  const logs = []
  const options = { path, lane: 'browser', sha: 'abcdef1234', pid: 42, now: () => time,
    sleep: async ms => { time += ms }, load: () => 0, cores: 10, log: line => logs.push(line), pollMs: 10 }
  try { await run({ path, options, logs }) } finally { await rm(root, { recursive: true, force: true }) }
}

test('family reservation and process expiry match runner.sh exactly', () => {
  expect(lockStale('', 1000, () => true)).toBe(true)
  expect(lockStale('pid=0\nsince=100', 1000, () => false)).toBe(false)
  expect(lockStale('pid=0\nsince=99', 1000, () => true)).toBe(true)
  expect(lockStale('pid=8\nsince=1', 100000, () => true)).toBe(false)
  expect(lockStale('pid=8', 1000, () => false)).toBe(true)
})

test('acquires family format, releases only its own lock, release is repeatable', () => fixture(async ({ path, options }) => {
  const release = await acquireMachineLock(options)
  expect(await readFile(join(path, 'info'), 'utf8')).toBe('pid=42\nsince=1000\nowner=wechat-cc browser abcdef1\n')
  await release(); await release()
  await expect(readFile(join(path, 'info'))).rejects.toThrow()
  const again = await acquireMachineLock(options)
  await writeFile(join(path, 'info'), 'pid=9\nowner=rici full')
  await again()
  expect(await readFile(join(path, 'info'), 'utf8')).toContain('rici full')
}))

test('queues behind family check until fake clock ends its process', () => fixture(async ({ path, options, logs }) => {
  await mkdir(path); await writeFile(join(path, 'info'), 'pid=8\nowner=rici full 1234567\n')
  let polls = 0
  const release = await acquireMachineLock({ ...options, isAlive: () => polls++ < 2 })
  expect(logs).toHaveLength(2)
  expect(logs[0]).toBe('家族 check 在跑 rici full 1234567,等它')
  await release()
}))

test('queue timeout leaves live family owner intact', () => fixture(async ({ path, options }) => {
  await mkdir(path); await writeFile(join(path, 'info'), 'pid=8\nowner=ranu full\n')
  await expect(acquireMachineLock({ ...options, waitMs: 20, isAlive: () => true })).rejects.toThrow('queue timed out')
  expect(await readFile(join(path, 'info'), 'utf8')).toContain('ranu full')
}))

for (const info of ['', 'pid=0\nsince=99\n', 'pid=8\n']) test(`reclaims stale lock ${JSON.stringify(info)}`, () => fixture(async ({ path, options }) => {
  await mkdir(path); if (info) await writeFile(join(path, 'info'), info)
  const release = await acquireMachineLock({ ...options, isAlive: () => false })
  expect(await readFile(join(path, 'info'), 'utf8')).toContain('pid=42')
  await release()
}))

test('holds lock while high load falls to exactly cores × 1.5', () => fixture(async ({ path, options, logs }) => {
  let polls = 0
  const release = await acquireMachineLock({ ...options, load: () => ++polls < 3 ? 16 : 15,
    sleep: async () => { expect(await readFile(join(path, 'info'), 'utf8')).toContain('pid=42') } })
  expect(logs).toHaveLength(2)
  await release()
}))

test('load timeout and load failure release ownership', () => fixture(async ({ path, options }) => {
  await expect(acquireMachineLock({ ...options, load: () => 700, loadWaitMs: 20 })).rejects.toThrow('load gate timed out')
  await expect(readFile(join(path, 'info'))).rejects.toThrow()
  await expect(acquireMachineLock({ ...options, load: () => { throw Error('probe failed') } })).rejects.toThrow('probe failed')
  await expect(readFile(join(path, 'info'))).rejects.toThrow()
}))

test('publishes cleanup before waiting on load, so interruption can release immediately', () => fixture(async ({ path, options }) => {
  let cleanup
  await expect(acquireMachineLock({ ...options, onAcquired: release => { cleanup = release }, load: () => 700,
    sleep: async () => { await cleanup(); throw Error('interrupted') } })).rejects.toThrow('interrupted')
  await expect(readFile(join(path, 'info'))).rejects.toThrow()
}))

for (const stage of ['queue','load']) test(`cancels ${stage} wait without acquiring or retaining ownership`,()=>fixture(async({path,options})=>{
 let stopping=false
 if(stage==='queue'){await mkdir(path);await writeFile(join(path,'info'),'pid=8\nowner=family full\n')}
 await expect(acquireMachineLock({...options,assertRunning:()=>{if(stopping)throw Error('stopping')},isAlive:()=>true,load:()=>99,waitMs:20,loadWaitMs:20,
  sleep:async()=>{stopping=true},now:(()=>{let n=1000;return()=>n++})(),
 })).rejects.toThrow('stopping')
 if(stage==='queue')expect(await readFile(join(path,'info'),'utf8')).toContain('family full')
 else await expect(readFile(join(path,'info'))).rejects.toThrow()
}))

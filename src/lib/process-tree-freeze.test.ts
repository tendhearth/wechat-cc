import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProcessTreeFreezer, type ProcessRow } from './process-tree-freeze'

const posix = process.platform !== 'win32'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// 一棵真的树:根(detached 组长)每 20ms 往 root.ticks 写一次计数,开两个孩子 ——
// 一个留在根的组里(same.ticks),一个自己另起一个组(own.ticks,detached ⇒ setsid)。
const TICKER = `
const fs = require('node:fs')
const [file] = process.argv.slice(2)
let n = 0
setInterval(() => { fs.writeFileSync(file, String(++n)) }, 20)
`
const ROOT = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const [dir, ticker] = process.argv.slice(2)
let n = 0
setInterval(() => { fs.writeFileSync(path.join(dir, 'root.ticks'), String(++n)) }, 20)
spawn(process.execPath, [ticker, path.join(dir, 'same.ticks')], { stdio: 'ignore' })
spawn(process.execPath, [ticker, path.join(dir, 'own.ticks')], { stdio: 'ignore', detached: true })
`

describe.skipIf(!posix)('makeProcessTreeFreezer — a real child tree', () => {
  let dir = '', root: ChildProcess | undefined
  afterEach(() => {
    try { if (root?.pid) process.kill(-root.pid, 'SIGKILL') } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const read = (name: string) => { try { return Number(readFileSync(join(dir, name), 'utf8')) } catch { return 0 } }
  const ticks = () => ({ root: read('root.ticks'), same: read('same.ticks'), own: read('own.ticks') })

  it('SIGSTOP stops every process in the tree (incl. a child in its own group); SIGCONT resumes all; kill ends them without resuming', async () => {
    dir = mkdtempSync(join(tmpdir(), 'freeze-'))
    writeFileSync(join(dir, 'ticker.cjs'), TICKER)
    writeFileSync(join(dir, 'root.cjs'), ROOT)
    root = spawn(process.execPath, [join(dir, 'root.cjs'), dir, join(dir, 'ticker.cjs')], { stdio: 'ignore', detached: true })
    // 满载套件里三层 spawn 可能要好几秒才开始数(和 claude-workbench-process.test.ts 同一个理由):预算给够。
    for (let i = 0; i < 400 && !(ticks().same > 2 && ticks().own > 2); i++) await sleep(50)
    expect(ticks().same).toBeGreaterThan(2)
    expect(ticks().own).toBeGreaterThan(2)

    const freezer = makeProcessTreeFreezer(() => root!.pid)
    expect(freezer.freeze()).toBe(true)
    expect(freezer.frozen).toBe(true)
    await sleep(100)                       // 在途的那一次写落定
    const frozenAt = ticks()
    await sleep(400)
    expect(ticks()).toEqual(frozenAt)      // 三个都不动了

    freezer.thaw()
    expect(freezer.frozen).toBe(false)
    await expect.poll(() => { const t = ticks(); return t.root > frozenAt.root && t.same > frozenAt.same && t.own > frozenAt.own }, { timeout: 10_000 }).toBe(true)

    // 再冻一次,然后不放开直接杀:SIGKILL 对停住的进程照样生效。
    expect(freezer.freeze()).toBe(true)
    freezer.kill()
    for (let i = 0; i < 40 && freezer.alive(); i++) await sleep(50)
    expect(freezer.alive()).toBe(false)
  }, 45_000)
})

describe('makeProcessTreeFreezer — unit', () => {
  it('win32: refuses (no SIGSTOP); caller falls back to the old stop', () => {
    const sent: unknown[] = []
    const f = makeProcessTreeFreezer(() => 42, { platform: 'win32', signal: (t, s) => { sent.push([t, s]) } })
    expect(f.freeze()).toBe(false)
    expect(sent).toEqual([])
  })

  it('no pid / dead root ⇒ false', () => {
    expect(makeProcessTreeFreezer(() => undefined, { platform: 'darwin', signal: () => {} }).freeze()).toBe(false)
    const esrch = Object.assign(new Error('x'), { code: 'ESRCH' })
    expect(makeProcessTreeFreezer(() => 10, { platform: 'darwin', signal: () => { throw esrch } }).freeze()).toBe(false)
  })

  it('stops the root group, every descendant-led group, and loose descendants; thaws descendants before the root', () => {
    const sent: Array<[number, string | 0]> = []
    const rows: ProcessRow[] = [
      { pid: 10, parent: 1, group: 10 },     // root
      { pid: 11, parent: 10, group: 10 },    // same group
      { pid: 12, parent: 10, group: 12 },    // own group (led by a descendant)
      { pid: 13, parent: 12, group: 12 },
      { pid: 14, parent: 11, group: 99 },    // a descendant parked in someone else's group
      { pid: 99, parent: 1, group: 99 },     // unrelated
    ]
    const f = makeProcessTreeFreezer(() => 10, { platform: 'darwin', table: () => rows, signal: (t, s) => { sent.push([t, s]) } })
    expect(f.freeze()).toBe(true)
    expect(sent).toEqual([[-10, 'SIGSTOP'], [-12, 'SIGSTOP'], [14, 'SIGSTOP']])
    sent.length = 0
    f.thaw()
    expect(sent).toEqual([[14, 'SIGCONT'], [-12, 'SIGCONT'], [-10, 'SIGCONT']])
    sent.length = 0
    f.kill()
    expect(sent).toEqual([[-10, 'SIGKILL'], [-12, 'SIGKILL'], [14, 'SIGKILL']])
  })
})

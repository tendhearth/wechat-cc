import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownClaudeWorkbenchProcess } from './claude-workbench-process'

const exists = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
describe.skipIf(process.platform === 'win32')('Claude owned process teardown', () => {
  it('kills frozen detached descendants without allowing termination handlers to create new work', async () => {
    const area = mkdtempSync(join(tmpdir(), 'cc-claude-owned-process-')), sentinel = join(area, 'child.pid'), lateFile = join(area, 'late.pid')
    const owner = ownClaudeWorkbenchProcess(undefined)
    const lateChild = `require('node:fs').writeFileSync(${JSON.stringify(lateFile)},String(process.pid));setInterval(()=>{},1000)`
    const descendant = `process.on('SIGTERM',()=>{require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(lateChild)}],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}})}); require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, String(process.pid)); setInterval(()=>{}, 1000)`
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}}); setInterval(()=>{}, 1000)`
    const processChild = owner.spawn({ command: process.execPath, args: ['-e', parent], cwd: area, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    let descendantPid: number | undefined
    try {
      // expect.poll 的缺省预算是 1s,而这里等的是三层 spawn(owner → parent →
      // descendant)之后才写出的 sentinel:满载套件里实测 1124ms 就超了,红成
      // `expected false to be true`(2026-09-19)。等的条件没变,只是把预算给够。
      await expect.poll(() => existsSync(sentinel), { timeout: 30_000 }).toBe(true)
      descendantPid = Number(readFileSync(sentinel, 'utf8'))
      expect(exists(descendantPid)).toBe(true)
      const deadline = Date.now() + 2500
      owner.prepareClose(deadline); await owner.close(deadline)
      expect(exists(processChild.pid!)).toBe(false)
      expect(exists(descendantPid)).toBe(false)
      expect(exists(-descendantPid)).toBe(false)
      expect(existsSync(lateFile)).toBe(false)
    } finally {
      for (const pid of [descendantPid, processChild.pid, ...(existsSync(lateFile) ? [Number(readFileSync(lateFile, 'utf8'))] : [])]) if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      rmSync(area, { recursive: true, force: true })
    }
    // 三层 spawn 加上 close 那 2500ms 的 deadline,在满载机器上塞不进 5s。
  }, 60_000)

  it('closes an already-zombie detached descendant without requiring its parent to reap first', async () => {
    const area = mkdtempSync(join(tmpdir(), 'cc-claude-owned-zombie-')), sentinel = join(area, 'child.pid')
    const owner = ownClaudeWorkbenchProcess(undefined)
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, String(process.pid));setInterval(()=>{},1000)`
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});setInterval(()=>{},1000)`
    const child = owner.spawn({ command: process.execPath, args: ['-e', parent], cwd: area, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    let pid: number | undefined
    try {
      await expect.poll(() => existsSync(sentinel), { timeout: 30_000 }).toBe(true)
      pid = Number(readFileSync(sentinel, 'utf8'))
      // Hold the parent stopped so the killed child remains observable as Z.
      process.kill(-child.pid!, 'SIGSTOP')
      process.kill(-pid, 'SIGKILL')
      await expect.poll(() => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z'), { timeout: 2500 }).toBe(true)
      if (process.platform === 'darwin') expect(() => process.kill(-pid!, 0)).toThrow(expect.objectContaining({ code: 'EPERM' }))
      const deadline = Date.now() + 2500
      owner.prepareClose(deadline)
      await expect(owner.close(deadline)).resolves.toBeUndefined()
      expect(exists(child.pid!)).toBe(false)
    } finally {
      for (const target of [pid, child.pid]) if (target) { try { process.kill(-target, 'SIGKILL') } catch {} }
      rmSync(area, { recursive: true, force: true })
    }
  }, 60_000)

  // 网络守护「暂停在跑的任务」(2026-10-03):冻住整棵树(含另起一组的后代),放开后接着跑;
  // 冻住期间 terminate ⇒ 不放开直接杀,close 不再因为「进程已经没了」报 ownership_lost。
  it('freeze stops the whole tree, thaw resumes it, terminate-while-frozen closes cleanly', async () => {
    const area = mkdtempSync(join(tmpdir(), 'cc-claude-freeze-')), ticks = join(area, 'ticks'), childPid = join(area, 'child.pid')
    const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n)),20)`
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}}); setInterval(()=>{}, 1000)`
    const owner = ownClaudeWorkbenchProcess(undefined)
    const processChild = owner.spawn({ command: process.execPath, args: ['-e', parent], cwd: area, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    const read = () => { try { return Number(readFileSync(ticks, 'utf8')) } catch { return 0 } }
    let descendantPid: number | undefined
    try {
      // 同上一条:满载套件(编译型测试同时在跑)里两层 spawn 可能十几秒才开始数,预算给够。
      await expect.poll(() => read() > 2, { timeout: 30_000 }).toBe(true)
      descendantPid = Number(readFileSync(childPid, 'utf8'))
      expect(owner.freeze()).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 100))
      const frozenAt = read()
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(read()).toBe(frozenAt)
      owner.thaw()
      await expect.poll(() => read() > frozenAt, { timeout: 5_000 }).toBe(true)
      expect(owner.freeze()).toBe(true)
      owner.terminate()
      const deadline = Date.now() + 2500
      owner.prepareClose(deadline); await owner.close(deadline)
      expect(exists(processChild.pid!)).toBe(false)
      expect(exists(descendantPid)).toBe(false)
    } finally {
      for (const pid of [descendantPid, processChild.pid]) if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      rmSync(area, { recursive: true, force: true })
    }
  }, 60_000)
})

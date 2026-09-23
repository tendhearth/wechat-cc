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
      await expect.poll(() => existsSync(sentinel), { timeout: 15_000 }).toBe(true)
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
  }, 30_000)
})

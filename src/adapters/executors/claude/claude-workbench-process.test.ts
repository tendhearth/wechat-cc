import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownClaudeWorkbenchProcess } from './claude-workbench-process'

const exists = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
// 关掉以后进程「最后没了」才是要钉的事。被过继给 launchd / init 的孙进程是异步收尸的:close 返回那一刻 kill(pid,0)
// 还可能看得见它一小会儿(10-22 CI node 上、满载本机上各红过一次)。轮询等它消失;真逃掉的进程 5 秒后照样红。
const gone = (pid: number) => expect.poll(() => exists(pid), { timeout: 5_000 }).toBe(false)
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
      await gone(processChild.pid!)
      await gone(descendantPid)
      await gone(-descendantPid)
      expect(existsSync(lateFile)).toBe(false)
    } finally {
      for (const pid of [descendantPid, processChild.pid, ...(existsSync(lateFile) ? [Number(readFileSync(lateFile, 'utf8'))] : [])]) if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      rmSync(area, { recursive: true, force: true })
    }
    // 三层 spawn 加上 close 那 2500ms 的 deadline,在满载机器上塞不进 5s。
  }, 60_000)

  // 「没确认退出」的退出证据(2026-10-10 评审):扫描没做完就交不出完整的进程组 ⇒ 一个都不交(没有证据),
  // 免得「记下的组全没了」被当成退出、而 setsid 出去的子进程还在写。
  it('reports no process groups unless the descendant scan completed', async () => {
    const owner = ownClaudeWorkbenchProcess(undefined)
    const child = owner.spawn({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    expect(() => owner.prepareClose(Date.now() + 2500)).toThrow('claude_runtime_process_ownership_lost')
    expect(owner.groups()).toEqual([])
    const frozen = ownClaudeWorkbenchProcess(undefined)
    const live = frozen.spawn({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    try {
      frozen.terminate()
      frozen.prepareClose(Date.now() + 2500)
      expect(frozen.groups()).toEqual([])
    } finally { try { process.kill(-live.pid!, 'SIGKILL') } catch {} }
    const clean = ownClaudeWorkbenchProcess(undefined)
    const ok = clean.spawn({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    try {
      await expect.poll(() => { try { process.kill(ok.pid!, 0); return true } catch { return false } }).toBe(true)
      clean.prepareClose(Date.now() + 10_000)
      expect(clean.groups()).toEqual([ok.pid])
      await clean.close(Date.now() + 10_000)
    } finally { try { process.kill(-ok.pid!, 'SIGKILL') } catch {} }
  }, 60_000)

  // 网络守护「暂停在跑的任务」(2026-10-03):冻住整棵树(含另起一组的后代),放开后接着跑;
  // 冻住期间 terminate ⇒ 不放开直接杀,close 不再因为「进程已经没了」报 ownership_lost。
  it('freeze stops the whole tree, thaw resumes it, terminate-while-frozen closes cleanly', async () => {
    const area = mkdtempSync(join(tmpdir(), 'cc-claude-freeze-')), ticks = join(area, 'ticks'), childPid = join(area, 'child.pid')
    const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n)),20)`
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}}); setInterval(()=>{}, 1000)`
    const owner = ownClaudeWorkbenchProcess(undefined)
    const processChild = owner.spawn({ command: process.execPath, args: ['-e', parent], cwd: area, env: { PATH: '/usr/bin:/bin' }, signal: new AbortController().signal })
    // 计数文件整个重写(先截断再写):读在中间会读到空串 ⇒ 0。只增不减,记住见过的最大值(同 process-tree-freeze.test.ts)。
    let seen = 0
    const read = () => { try { seen = Math.max(seen, Number(readFileSync(ticks, 'utf8')) || 0) } catch { /* not yet written */ } return seen }
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
      await gone(processChild.pid!)
      await gone(descendantPid)
    } finally {
      for (const pid of [descendantPid, processChild.pid]) if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      rmSync(area, { recursive: true, force: true })
    }
  }, 60_000)
})

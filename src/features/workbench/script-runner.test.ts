import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { KILL_GRACE_MS, OUTPUT_TAIL_CHARS, scriptEnv, startScript } from './script-runner'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })
const area = () => { const d = mkdtempSync(join(tmpdir(), 'cc-script-runner-')); dirs.push(d); return d }
const vars = (cwd: string) => ({ port: 47123, workspacePath: cwd, rootPath: '/src/repo', branch: 'cc/abcd1234' })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const BASE = { PATH: '/usr/bin:/bin', HOME: tmpdir() }

describe('scriptEnv', () => {
  it('drops daemon credentials and GIT_*, adds the four TENDHEARTH_* vars', () => {
    const env = scriptEnv({ port: 47100, workspacePath: '/w', rootPath: '/r', branch: 'cc/x' }, { PATH: '/bin', WECHAT_TOKEN: 's', GIT_DIR: '/x/.git', TENDHEARTH_PORT: '1', OPENAI_API_KEY: 'k' })
    expect(env).toEqual({ PATH: '/bin', OPENAI_API_KEY: 'k', TENDHEARTH_PORT: '47100', TENDHEARTH_WORKSPACE_PATH: '/w', TENDHEARTH_ROOT_PATH: '/r', TENDHEARTH_BRANCH: 'cc/x' })
  })
  it('port null ⇒ no TENDHEARTH_PORT (an inherited one is removed too)', () => {
    expect(scriptEnv({ port: null, workspacePath: '/w', rootPath: '/r', branch: 'b' }, { TENDHEARTH_PORT: '9' })).not.toHaveProperty('TENDHEARTH_PORT')
  })
})

// 真进程;POSIX 的 shell / 进程组语义,win32 上另验(cmd + cc-jobspawn)
describe.skipIf(process.platform === 'win32')('startScript (real process)', () => {
  it('runs in cwd with TENDHEARTH_* in the env; output tail + exit code', async () => {
    const cwd = area()
    const outputs: string[] = []
    const run = startScript({ kind: 'setup', script: 'echo "port=$TENDHEARTH_PORT branch=$TENDHEARTH_BRANCH"; pwd; echo err >&2; exit 3', cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh', onOutput: t => outputs.push(t) })
    expect(run.pgid).toBeGreaterThan(0)
    const exit = await run.done
    expect(exit).toMatchObject({ code: 3, timedOut: false, stopped: false, error: null })
    expect(exit.tail).toContain('port=47123 branch=cc/abcd1234')
    expect(exit.tail).toContain('err')
    expect(exit.tail).toMatch(/cc-script-runner-/)
    // 最后一次推送就是完整的尾巴
    expect(outputs.at(-1)).toBe(exit.tail)
  })

  it('stop() takes the whole process group — the grandchild `sleep` dies too', async () => {
    const cwd = area()
    const pidFile = join(cwd, 'grandchild.pid')
    let grandchild: number | undefined
    try {
      const run = startScript({ kind: 'run', script: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
      await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, { timeout: 5000, interval: 50 }).toBe(true)
      grandchild = Number(readFileSync(pidFile, 'utf8').trim())
      expect(alive(grandchild)).toBe(true)
      await run.stop()
      const exit = await run.done
      expect(exit.stopped).toBe(true)
      await expect.poll(() => alive(grandchild!), { timeout: 6000, interval: 100 }).toBe(false)
    } finally {
      if (grandchild) { try { process.kill(grandchild, 'SIGKILL') } catch { /* 已经没了 */ } }
    }
  }, 15_000)

  it('timeout ⇒ timedOut, group killed', async () => {
    const cwd = area()
    const exit = await startScript({ kind: 'archive', script: 'sleep 30', cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh', timeoutMs: 300 }).done
    expect(exit).toMatchObject({ timedOut: true, stopped: false, code: null, signal: 'SIGTERM' })
  }, 10_000)

  it('keeps only the last 32KB of output; onOutput is throttled', async () => {
    const cwd = area()
    const outputs: string[] = []
    // 每行 100 字符,共 1000 行 ≈ 100KB,分几次吐、中间停一下
    const script = 'i=0; while [ $i -lt 1000 ]; do printf "%099d\\n" $i; i=$((i+1)); if [ $((i % 250)) -eq 0 ]; then sleep 0.2; fi; done; echo END'
    const exit = await startScript({ kind: 'setup', script, cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh', outputIntervalMs: 10_000, onOutput: t => outputs.push(t) }).done
    expect(exit.code).toBe(0)
    expect(exit.tail.length).toBe(OUTPUT_TAIL_CHARS)
    expect(exit.tail.endsWith('END\n')).toBe(true)
    // 间隔 10 秒 ⇒ 第一次立刻推、之后只剩退出时那一次
    expect(outputs.length).toBe(2)
    expect(outputs[1]).toBe(exit.tail)
  }, 15_000)

  it('stop() after a normal exit resolves immediately; an empty group gets no signal', async () => {
    const cwd = area()
    const run = startScript({ kind: 'setup', script: 'true', cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
    expect((await run.done).code).toBe(0)
    const kill = vi.spyOn(process, 'kill')
    try {
      await run.stop()
      expect(kill.mock.calls.filter(([pid, sig]) => typeof pid === 'number' && pid < 0 && sig !== 0)).toEqual([])
    } finally { kill.mockRestore() }
  })

  // 组空过一次,号码就可能被别人复用 ⇒ 即便 kill(-pgid, 0) 又成功了,也一个信号都不发(#410 评审)
  it('once the group has emptied, stop() sends nothing even if the pgid probes alive again (reused)', async () => {
    const cwd = area()
    const run = startScript({ kind: 'setup', script: 'true', cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
    await run.done
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await run.stop()
      expect(kill.mock.calls.filter(([pid, sig]) => typeof pid === 'number' && pid < 0 && sig !== 0)).toEqual([])
    } finally { kill.mockRestore() }
  })

  // 主 shell 退了、组里还剩后台进程 ⇒ 组号还是我们的,照样收掉(#409 评审:不然 `… &` 起的开发服务一直占着端口)
  it('stop() after the main shell exited still reaps a background child left in the group', async () => {
    const cwd = area()
    const pidFile = join(cwd, 'bg.pid')
    let bg: number | undefined
    const kill = vi.spyOn(process, 'kill')
    try {
      const run = startScript({ kind: 'run', script: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; exit 0`, cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
      await run.done
      bg = Number(readFileSync(pidFile, 'utf8').trim())
      kill.mockClear()
      await run.stop()
      expect(kill.mock.calls.filter(([pid, sig]) => typeof pid === 'number' && pid < 0 && sig !== 0).map(([, sig]) => sig)).toEqual(['SIGTERM'])
      await expect.poll(() => alive(bg!), { timeout: 3000, interval: 50 }).toBe(false)
    } finally {
      kill.mockRestore()
      if (bg) { try { process.kill(bg, 'SIGKILL') } catch { /* 已经没了 */ } }
    }
  }, 10_000)

  it('a background child that ignores SIGTERM still gets SIGKILL after the main shell exited', async () => {
    const cwd = area()
    const pidFile = join(cwd, 'stubborn.pid')
    let stubborn: number | undefined
    const kill = vi.spyOn(process, 'kill')
    try {
      // 后台那个不理 SIGTERM;主 shell 收到 SIGTERM 就退
      const run = startScript({ kind: 'run', script: `(trap '' TERM; sleep 30) & echo $! > ${JSON.stringify(pidFile)}; wait`, cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
      await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0, { timeout: 5000, interval: 50 }).toBe(true)
      stubborn = Number(readFileSync(pidFile, 'utf8').trim())
      await run.stop()
      await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS + 500))
      const signals = kill.mock.calls.filter(([pid, sig]) => typeof pid === 'number' && pid < 0 && sig !== 0).map(([, sig]) => sig)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(alive(stubborn)).toBe(false)
    } finally {
      kill.mockRestore()
      if (stubborn) { try { process.kill(stubborn, 'SIGKILL') } catch { /* 已经没了 */ } }
    }
  }, 15_000)

  it('a main shell that ignores SIGTERM still gets SIGKILL after the grace period', async () => {
    const cwd = area()
    const ready = join(cwd, 'ready')
    const run = startScript({ kind: 'run', script: `trap '' TERM; touch ${JSON.stringify(ready)}; while :; do sleep 1; done`, cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
    await expect.poll(() => existsSync(ready), { timeout: 5000, interval: 50 }).toBe(true)
    const started = Date.now()
    await run.stop()
    expect((await run.done).signal).toBe('SIGKILL')
    expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_GRACE_MS - 100)
  }, 15_000)

  it('missing shell ⇒ error, no throw', async () => {
    const cwd = area()
    const exit = await startScript({ kind: 'setup', script: 'true', cwd, env: vars(cwd), baseEnv: BASE, shell: join(cwd, 'no-such-shell') }).done
    expect(exit.error).toBeTruthy()
    expect(exit.code).toBeNull()
  })
})

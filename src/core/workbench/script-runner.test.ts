import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { OUTPUT_TAIL_CHARS, scriptEnv, startScript } from './script-runner'

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

  it('stop() after a normal exit resolves immediately', async () => {
    const cwd = area()
    const run = startScript({ kind: 'setup', script: 'true', cwd, env: vars(cwd), baseEnv: BASE, shell: '/bin/sh' })
    expect((await run.done).code).toBe(0)
    await run.stop()
  })

  it('missing shell ⇒ error, no throw', async () => {
    const cwd = area()
    const exit = await startScript({ kind: 'setup', script: 'true', cwd, env: vars(cwd), baseEnv: BASE, shell: join(cwd, 'no-such-shell') }).done
    expect(exit.error).toBeTruthy()
    expect(exit.code).toBeNull()
  })
})

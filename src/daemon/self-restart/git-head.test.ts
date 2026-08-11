import { describe, it, expect } from 'vitest'
import { readGitHead, readGitLockfileBlob } from './git-head'

/** 造一个假的 Bun.spawn:按需返回 stdout / 退出码 / 永不结束。 */
function fakeSpawn(opts: { stdout?: string; exitCode?: number; hang?: boolean }) {
  return (() => ({
    stdout: new Response(opts.stdout ?? '').body,
    exited: opts.hang ? new Promise<number>(() => {}) : Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn
}

describe('readGitHead', () => {
  it('正常返回时给出去空白的 commit', async () => {
    const head = await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ stdout: 'abc123def\n' }) })
    expect(head).toBe('abc123def')
  })

  it('非零退出码 ⇒ null(不是 git 仓库等)', async () => {
    expect(await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ stdout: '', exitCode: 128 }) })).toBeNull()
  })

  it('输出为空 ⇒ null', async () => {
    expect(await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ stdout: '   \n' }) })).toBeNull()
  })

  it('超时 ⇒ null,且不挂住调用方', async () => {
    const started = Date.now()
    const head = await readGitHead({ cwd: '/repo', spawn: fakeSpawn({ hang: true }), timeoutMs: 50 })
    expect(head).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('spawn 直接抛 ⇒ null,不向上抛', async () => {
    const throwing = (() => { throw new Error('ENOENT: git not found') }) as unknown as typeof Bun.spawn
    await expect(readGitHead({ cwd: '/repo', spawn: throwing })).resolves.toBeNull()
  })
})

// Task 3 review finding #2 — readGitLockfileBlob shares gitRevParse's
// timeout/exception skeleton with readGitHead; these mirror that file's own
// cases (success / non-zero exit / timeout / throw) rather than re-deriving
// them, since the underlying implementation is now shared.
describe('readGitLockfileBlob', () => {
  it('正常返回时给出 bun.lock 在 HEAD 的 blob hash', async () => {
    const blob = await readGitLockfileBlob({ cwd: '/repo', spawn: fakeSpawn({ stdout: 'deadbeef\n' }) })
    expect(blob).toBe('deadbeef')
  })

  it('非零退出码 ⇒ null(没有提交过 bun.lock 等)', async () => {
    expect(await readGitLockfileBlob({ cwd: '/repo', spawn: fakeSpawn({ stdout: '', exitCode: 128 }) })).toBeNull()
  })

  it('超时 ⇒ null,且不挂住调用方', async () => {
    const started = Date.now()
    const blob = await readGitLockfileBlob({ cwd: '/repo', spawn: fakeSpawn({ hang: true }), timeoutMs: 50 })
    expect(blob).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('spawn 直接抛 ⇒ null,不向上抛', async () => {
    const throwing = (() => { throw new Error('ENOENT: git not found') }) as unknown as typeof Bun.spawn
    await expect(readGitLockfileBlob({ cwd: '/repo', spawn: throwing })).resolves.toBeNull()
  })
})

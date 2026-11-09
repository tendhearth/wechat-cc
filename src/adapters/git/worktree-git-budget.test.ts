import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { git } from './worktree-workspaces'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset() })

it('allows a slow filter probe within the shared Git deadline and still disables every discovered filter', () => {
  let now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.mocked(execFileSync).mockImplementation((_command, argv, options) => {
    if (argv!.includes('--get-regexp')) {
      if ((options as { timeout: number }).timeout < 6000) throw Object.assign(Error('probe timed out'), { code: 'ETIMEDOUT' })
      now += 6000
      return 'filter.fixture.process\0filter.fixture.required\0'
    }
    expect(argv).toContain('filter.fixture.process=')
    expect(argv).toContain('filter.fixture.required=false')
    expect(options).toMatchObject({ timeout: 24_000 })
    return ''
  })
  expect(git('/fixture', ['status', '--porcelain'])).toBe('')
  expect(execFileSync).toHaveBeenCalledTimes(2)
})

it('never runs the requested Git command after the filter probe consumes the total deadline', () => {
  let now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.mocked(execFileSync).mockImplementation(() => { now += 30_000; return '' })
  expect(() => git('/fixture', ['status', '--porcelain'])).toThrow('worktree_git_failed')
  expect(execFileSync).toHaveBeenCalledTimes(1)
})

it('fails closed and identifies the filter probe when configuration cannot be read', () => {
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(Error('denied'), { status: 128, stderr: 'config denied' }) })
  let failure: unknown
  try { git('/fixture', ['status', '--porcelain']) } catch (error) { failure = error }
  expect(failure).toMatchObject({ message: 'worktree_git_failed', phase: 'filters', exitStatus: 128, detail: 'config denied' })
  expect(execFileSync).toHaveBeenCalledTimes(1)
})

it('identifies a real command timeout separately from the filter probe', () => {
  vi.mocked(execFileSync).mockImplementation((_command, argv) => {
    if (argv!.includes('--get-regexp')) throw Object.assign(Error('no filters'), { status: 1 })
    throw Object.assign(Error('command timed out'), { code: 'ETIMEDOUT' })
  })
  let failure: unknown
  try { git('/fixture', ['status', '--porcelain']) } catch (error) { failure = error }
  expect(failure).toMatchObject({ message: 'worktree_git_failed', phase: 'command', timedOut: true })
  expect(execFileSync).toHaveBeenCalledTimes(2)
})

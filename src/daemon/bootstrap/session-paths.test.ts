import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionJsonlPath, codexSessionJsonlPaths } from './session-paths.js'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cc-session-paths-'))
  homes.push(home)
  const day = join(home, '.codex/sessions/2026/09/12')
  mkdirSync(day, { recursive: true })
  return { home, day }
}
describe('Claude session discovery', () => {
  it('uses the native project encoding for punctuation, spaces and Unicode', () => {
    const { home } = fixture()
    const cwd = '/Users/test_user/hello.world/画 室'
    const directory = join(home, '.claude/projects/-Users-test-user-hello-world----')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'session-one.jsonl')
    writeFileSync(file, '')
    expect(claudeSessionJsonlPath(home, cwd, 'session-one')).toBe(file)
    expect(existsSync(claudeSessionJsonlPath(home, cwd, 'session-one'))).toBe(true)
    expect(existsSync(claudeSessionJsonlPath(home, cwd, 'session-two'))).toBe(false)
  })
  it('matches the native 200-character prefix and original-path hash for long paths', () => {
    expect(claudeSessionJsonlPath('/home', '/' + 'a'.repeat(210), 'session'))
      .toBe(join('/home/.claude/projects', '-' + 'a'.repeat(199) + '-djaaup', 'session.jsonl'))
  })
  // 夹具是 POSIX 路径;win32 上 path.join 会把它写成反斜杠,测的就不再是同一件事。
  it.skipIf(process.platform === 'win32')('preserves ordinary native project paths', () => {
    expect(claudeSessionJsonlPath('/home', '/work/project', 'session'))
      .toBe('/home/.claude/projects/-work-project/session.jsonl')
  })
})
describe('Codex session discovery', () => {
  it('finds actual rollout filenames for only the requested thread', () => {
    const { home, day } = fixture()
    const id = '01993926-abcd-7123-8123-123456789012'
    const file = join(day, `rollout-2026-09-12T04-35-00-${id}.jsonl`)
    writeFileSync(file, '')
    expect(codexSessionJsonlPaths(home, id).filter(existsSync)).toEqual([file])
    expect(codexSessionJsonlPaths(home, 'another-thread').filter(existsSync)).toEqual([])
  })
  it('retains legacy filenames and does not recurse beyond date folders', () => {
    const { home, day } = fixture()
    const file = join(day, 'legacy.jsonl')
    writeFileSync(file, '')
    mkdirSync(join(day, 'nested'))
    writeFileSync(join(day, 'nested/rollout-date-other.jsonl'), '')
    expect(codexSessionJsonlPaths(home, 'legacy').filter(existsSync)).toEqual([file])
    expect(codexSessionJsonlPaths(home, 'other').filter(existsSync)).toEqual([])
  })
})

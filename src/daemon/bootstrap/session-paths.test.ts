import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexSessionJsonlPaths } from './session-paths.js'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cc-session-paths-'))
  homes.push(home)
  const day = join(home, '.codex/sessions/2026/09/12')
  mkdirSync(day, { recursive: true })
  return { home, day }
}
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

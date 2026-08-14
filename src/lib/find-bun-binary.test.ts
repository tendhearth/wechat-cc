import { describe, expect, it } from 'vitest'
import { findBunBinary } from './find-bun-binary'

// Why these cases: codex-autofix spawns bun to realign the bundled SDK, and
// it spawned a bare `bun` relying on PATH. A launchd/systemd daemon starts
// with a minimal PATH (/usr/bin:/bin), which does not contain ~/.bun/bin —
// so the autofix logged `bun not found on PATH` on every boot of the
// maintainer's own machine from 2026-07-17 onward and never once realigned
// anything. find-codex-binary.ts already solved this exact class for the
// codex binary; this mirrors it for bun.

const HOME = '/home/u'

function fs(paths: string[]) {
  const set = new Set(paths)
  return (p: string) => set.has(p)
}

describe('findBunBinary', () => {
  it('returns the PATH hit when bun is on PATH', () => {
    const found = findBunBinary({
      exists: fs(['/usr/local/bin/bun']),
      pathEnv: '/usr/bin:/usr/local/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBe('/usr/local/bin/bun')
  })

  it('falls back to ~/.bun/bin/bun under a minimal service PATH (the real failure)', () => {
    const found = findBunBinary({
      exists: fs([`${HOME}/.bun/bin/bun`]),
      pathEnv: '/usr/bin:/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBe(`${HOME}/.bun/bin/bun`)
  })

  it('prefers an explicit PATH entry over the ~/.bun fallback', () => {
    const found = findBunBinary({
      exists: fs(['/opt/custom/bun', `${HOME}/.bun/bin/bun`]),
      pathEnv: '/opt/custom',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBe('/opt/custom/bun')
  })

  it('finds a Homebrew bun on darwin when PATH is minimal', () => {
    const found = findBunBinary({
      exists: fs(['/opt/homebrew/bin/bun']),
      pathEnv: '/usr/bin:/bin',
      homeDir: HOME,
      platform: 'darwin',
    })
    expect(found).toBe('/opt/homebrew/bin/bun')
  })

  it('does not use Homebrew prefixes on linux', () => {
    const found = findBunBinary({
      exists: fs(['/opt/homebrew/bin/bun']),
      pathEnv: '/usr/bin:/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBeNull()
  })

  it('walks nvm newest-first for an `npm i -g bun` install', () => {
    const found = findBunBinary({
      exists: fs([`${HOME}/.nvm/versions/node`, `${HOME}/.nvm/versions/node/v20.1.0/bin/bun`]),
      readdir: () => ['v18.0.0', 'v20.1.0'],
      pathEnv: '/usr/bin:/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBe(`${HOME}/.nvm/versions/node/v20.1.0/bin/bun`)
  })

  it('uses bun.exe and the Windows home layout on win32', () => {
    const found = findBunBinary({
      exists: fs(['C:\\Users\\u\\.bun\\bin\\bun.exe']),
      pathEnv: 'C:\\Windows\\system32',
      homeDir: 'C:\\Users\\u',
      platform: 'win32',
    })
    expect(found).toBe('C:\\Users\\u\\.bun\\bin\\bun.exe')
  })

  it('returns null when bun is nowhere', () => {
    const found = findBunBinary({
      exists: fs([]),
      pathEnv: '/usr/bin:/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBeNull()
  })

  it('survives an unreadable nvm dir instead of throwing', () => {
    const found = findBunBinary({
      exists: fs([`${HOME}/.nvm/versions/node`]),
      readdir: () => { throw new Error('EACCES') },
      pathEnv: '/usr/bin:/bin',
      homeDir: HOME,
      platform: 'linux',
    })
    expect(found).toBeNull()
  })
})

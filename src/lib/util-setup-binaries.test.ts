import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ platform: 'darwin', home: '/fixture', files: new Set<string>() }))
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), platform: () => fixture.platform, homedir: () => fixture.home }))
vi.mock('child_process', () => ({ spawnSync: () => ({ status: 1, stdout: '' }) }))
vi.mock('node:fs', () => ({ existsSync: () => false, readdirSync: () => [], statSync: (path: string) => {
  if (!fixture.files.has(path)) throw new Error('ENOENT')
  return { isFile: () => true, mode: 0o755 }
} }))
import { findOnPath } from './util'
beforeEach(() => { fixture.files.clear() })
it('detects a freshly installed macOS Grok without a new daemon PATH', () => {
  fixture.platform = 'darwin'; fixture.home = '/fixture'
  fixture.files.add('/fixture/.grok/bin/grok')
  expect(findOnPath('grok')).toBe('/fixture/.grok/bin/grok')
})
it('detects Windows Cursor cmd and Grok exe from official user installation roots', () => {
  fixture.platform = 'win32'; fixture.home = 'C:\\Users\\fixture'
  vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\fixture\\AppData\\Local')
  fixture.files.add('C:\\Users\\fixture\\AppData\\Local\\cursor-agent\\cursor-agent.cmd')
  fixture.files.add('C:\\Users\\fixture\\.grok\\bin\\grok.exe')
  try {
    expect(findOnPath('cursor-agent')).toBe('C:\\Users\\fixture\\AppData\\Local\\cursor-agent\\cursor-agent.cmd')
    expect(findOnPath('grok')).toBe('C:\\Users\\fixture\\.grok\\bin\\grok.exe')
  } finally { vi.unstubAllEnvs() }
})

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { locateAtelierSdCli, resolveAtelierRenderer } from './atelier-renderer-resolve'

const base = {
  sdCliPath: '/bin/sd-cli', modelPath: '/m/sd-turbo.safetensors', workDir: '/work',
  makeRenderer: () => ({ id: 'stub', render: async () => { throw new Error('unused') } }),
}
const present = () => true

describe('resolveAtelierRenderer', () => {
  it('returns a renderer on Apple Silicon with binary and model present', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'arm64', existsSync: present })).not.toBeNull()
  })
  it('returns null on Intel mac', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'x64', existsSync: present })).toBeNull()
  })
  it('returns null on windows/linux (Phase 1)', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'win32', arch: 'x64', existsSync: present })).toBeNull()
  })
  it('returns null when the sd-cli binary is missing', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'arm64', existsSync: (p) => p !== base.sdCliPath })).toBeNull()
  })
  it('returns null when the model file is missing', () => {
    expect(resolveAtelierRenderer({ ...base, platform: 'darwin', arch: 'arm64', existsSync: (p) => p !== base.modelPath })).toBeNull()
  })
})

describe('locateAtelierSdCli', () => {
  it('uses the sd-cli shipped beside the compiled desktop CLI', () => {
    // 期望值用 join 拼:源码按平台分隔符找,Windows CI 上是反斜杠。
    const macos = join('/Applications', 'wechat-cc.app', 'Contents', 'MacOS')
    const bundled = join(macos, 'sd-cli')
    expect(locateAtelierSdCli({
      execPath: join(macos, 'wechat-cc-cli'),
      stateDir: '/state',
      existsSync: (p) => p === bundled,
    })).toBe(bundled)
  })

  it('keeps an explicit override authoritative', () => {
    expect(locateAtelierSdCli({
      explicitPath: '/custom/sd-cli',
      execPath: '/app/wechat-cc-cli',
      stateDir: '/state',
      existsSync: () => true,
    })).toBe('/custom/sd-cli')
  })

  it('falls back to the state directory for source installs', () => {
    expect(locateAtelierSdCli({
      execPath: '/opt/homebrew/bin/bun',
      stateDir: '/state',
      existsSync: () => false,
    })).toBe(join('/state', 'atelier', 'bin', 'sd-cli'))
  })
})

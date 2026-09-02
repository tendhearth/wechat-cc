import { describe, it, expect } from 'vitest'
import { resolveAtelierRenderer } from './atelier-renderer-resolve'

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

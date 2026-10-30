import { describe, expect, it } from 'vitest'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createQALaunchEnvironment, verifyQABundle } from './launch-cc-motion-native-qa.mjs'

describe('native QA launch boundary', () => {
  it('always replaces inherited daemon paths with fresh private empty directories', () => {
    const result = createQALaunchEnvironment({ HOME: '/unchanged-home', WECHAT_STATE_DIR: '/daily-state', WECHAT_CC_WORKBENCH_STATE_DIR: '/daily-workbench', WECHAT_CC_NO_BUNDLE_MIGRATE: '0' })
    try {
      expect(result.env.HOME).toBe('/unchanged-home')
      expect(result.env.WECHAT_STATE_DIR).not.toBe('/daily-state')
      expect(result.env.WECHAT_CC_WORKBENCH_STATE_DIR).not.toBe('/daily-workbench')
      expect(result.env.WECHAT_STATE_DIR).not.toBe(result.env.WECHAT_CC_WORKBENCH_STATE_DIR)
      expect(result.env.WECHAT_CC_NO_BUNDLE_MIGRATE).toBe('1')
      for (const path of [result.env.WECHAT_STATE_DIR, result.env.WECHAT_CC_WORKBENCH_STATE_DIR]) {
        expect(readdirSync(path)).toEqual([])
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o700)
      }
    } finally { rmSync(result.root, { recursive: true, force: true }) }
  })

  it('rejects a daily or unknown app identifier before launching', () => {
    const fixture = join(tmpdir(), 'fixture.app')
    expect(() => verifyQABundle(fixture, () => 'com.tendhearth.wechat-cc')).toThrow('identifier')
    expect(() => verifyQABundle(fixture, () => '')).toThrow('identifier')
    expect(verifyQABundle(fixture, (_file: string, key: string) => key === 'CFBundleIdentifier' ? 'com.tendhearth.cc-motion-qa-20261029' : 'Tendhearth CC')).toBe(join(fixture, 'Contents/MacOS/Tendhearth CC'))
  })
})

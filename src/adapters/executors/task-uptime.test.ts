import { expect, it, vi } from 'vitest'
import { TASK_UPTIME_PRELOAD } from './task-uptime'

function shim(original: () => number, expectedSyncs = 0, boot = Date.now() - 100_000) {
  const os = { uptime: original }, syncBuiltinESMExports = vi.fn()
  const load = new Function('require', 'process', TASK_UPTIME_PRELOAD)
  load((name: string) => name === 'node:os' ? os : { syncBuiltinESMExports }, {env:{CC_TASK_SYSTEM_BOOT_MS:String(boot)},hrtime:process.hrtime})
  expect(syncBuiltinESMExports).toHaveBeenCalledTimes(expectedSyncs)
  return os.uptime
}
it('preserves a healthy native uptime exactly', () => expect(shim(()=>123.5)()).toBe(123.5))
it.each([{code:'EPERM',syscall:'uv_uptime'},{code:'ERR_SYSTEM_ERROR',info:{code:'EACCES',syscall:'uv_uptime'}}])('falls back only for uv_uptime permission denial: %j', error => {
  expect(shim(()=>{throw error}, 1)()).toBeGreaterThan(99)
})
it.each([{code:'ENOENT',syscall:'uv_uptime'},{code:'EACCES',syscall:'other'},{code:'ERR_SYSTEM_ERROR',info:{code:'EINVAL',syscall:'uv_uptime'}}])('preserves unrelated errors: %j', error => {
  expect(()=>shim(()=>{throw error})()).toThrow(error)
})

it('leaves the original uptime function untouched on a healthy host', () => {
  const original = () => 123.5
  expect(shim(original)).toBe(original)
})
it('recovers the zero returned by sandboxed Bun and synchronizes ESM exports', () => {
  expect(shim(() => 0, 1)()).toBeGreaterThan(99)
})
it.each([NaN, -1, Date.now() + 100_000])('does not patch a denied native uptime with invalid boot baseline %s', boot => {
  const error = { code: 'EPERM', syscall: 'uv_uptime' }
  const original = () => { throw error }
  expect(shim(original, 0, boot)).toBe(original)
  expect(() => shim(original, 0, boot)()).toThrow(error)
})

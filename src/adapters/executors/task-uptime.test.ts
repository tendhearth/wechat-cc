import { expect, it, vi } from 'vitest'
import { TASK_UPTIME_PRELOAD } from './task-uptime'

function shim(original: () => number) {
  const os = { uptime: original }, syncBuiltinESMExports = vi.fn()
  const load = new Function('require', 'process', TASK_UPTIME_PRELOAD)
  load((name: string) => name === 'node:os' ? os : { syncBuiltinESMExports }, {env:{CC_TASK_SYSTEM_BOOT_MS:String(Date.now()-100_000)},hrtime:process.hrtime})
  expect(syncBuiltinESMExports).toHaveBeenCalledOnce()
  return os.uptime
}
it('preserves a healthy native uptime exactly', () => expect(shim(()=>123.5)()).toBe(123.5))
it.each([{code:'EPERM',syscall:'uv_uptime'},{code:'ERR_SYSTEM_ERROR',info:{code:'EACCES',syscall:'uv_uptime'}}])('falls back only for uv_uptime permission denial: %j', error => {
  expect(shim(()=>{throw error})()).toBeGreaterThan(99)
})
it.each([{code:'ENOENT',syscall:'uv_uptime'},{code:'EACCES',syscall:'other'},{code:'ERR_SYSTEM_ERROR',info:{code:'EINVAL',syscall:'uv_uptime'}}])('preserves unrelated errors: %j', error => {
  expect(()=>shim(()=>{throw error})()).toThrow(error)
})

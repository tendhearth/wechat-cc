import { AsyncLocalStorage } from 'node:async_hooks'

const suppressed = new AsyncLocalStorage<true>()

export function withoutPrivateLogging<T>(fn: () => T): T {
  return suppressed.run(true, fn)
}

export function privateLoggingSuppressed(): boolean {
  return suppressed.getStore() === true
}

import { describe, it, expect } from 'vitest'
import { makeIdleCheck, ignoredBusyLabel } from './wire'
import { CLI_SPECS } from '../../core/cli-upgrade/specs'

describe('CLI upgrade idle gate — never interrupt', () => {
  const base = { anyInFlight: () => false, liveSessionProviders: () => [] as string[], busyLabels: () => [] as string[] }

  it('idle when nothing runs', () => {
    expect(makeIdleCheck(base)(CLI_SPECS.codex)).toEqual({ idle: true })
  })
  it('any in-flight turn ⇒ not idle', () => {
    expect(makeIdleCheck({ ...base, anyInFlight: () => true })(CLI_SPECS.codex).idle).toBe(false)
  })
  it('a live (cached) session of THIS provider ⇒ not idle; another provider’s session does not block', () => {
    const check = makeIdleCheck({ ...base, liveSessionProviders: () => ['claude'] })
    expect(check(CLI_SPECS.claude).idle).toBe(false)
    expect(check(CLI_SPECS.codex).idle).toBe(true)
  })
  it('busy registry holders block (workbench task, A2A, terminal resume) — except our own token and the request asking us', () => {
    expect(makeIdleCheck({ ...base, busyLabels: () => ['workbench/t1'] })(CLI_SPECS.cursor)).toMatchObject({ idle: false })
    expect(makeIdleCheck({ ...base, busyLabels: () => ['cli-upgrade:codex', 'api:POST /v1/cli/upgrade'] })(CLI_SPECS.cursor)).toEqual({ idle: true })
    expect(ignoredBusyLabel('api:POST /v1/selftest/converse')).toBe(false)
  })
  it('a throwing probe counts as busy (fail safe)', () => {
    expect(makeIdleCheck({ ...base, anyInFlight: () => { throw new Error('x') } })(CLI_SPECS.agy).idle).toBe(false)
  })
})

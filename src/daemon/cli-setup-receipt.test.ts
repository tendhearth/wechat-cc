import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeCliSetup } from './cli-setup'
import * as receipts from './cli-setup-receipt'

it.runIf(process.platform !== 'win32').each([0, 1])('Grok completion receipt requires official login success; fake exit=%s', exit => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-grok-setup-receipt-'))
  try {
    const bin = join(dir, 'fake-grok'), scripts = join(dir, 'scripts')
    mkdirSync(scripts)
    writeFileSync(bin, '#!/bin/sh\nexit ' + exit + '\n', { mode: 0o700 })
    const service = makeCliSetup({ stateDir: dir, platform: 'darwin', binary: () => bin, grokLoggedIn: () => true,
      guard: () => ({ enabled: true, safe: true, source: 'bx' }), checkGuard: async () => ({ safe: true, source: 'bx', detail: '' }),
      beginLogin: () => receipts.makeCliSetupReceipt(dir, 'darwin') })
    return service.plan({ provider: 'grok', action: 'login' }).then(plan => {
      expect(service.snapshot().providers.find(p => p.id === 'grok')!.loginCompleted).toBe(false)
      const path = join(scripts, 'login.command')
      writeFileSync(path, plan.script, { mode: 0o700 })
      const r = spawnSync('/bin/bash', [path], { env: { HOME: dir, PATH: '/usr/bin:/bin', GROK_HOME: '/never-read-owner' } })
      expect(r.status).toBe(exit)
      expect(service.snapshot().providers.find(p => p.id === 'grok')!.loginCompleted).toBe(exit === 0)
    }).finally(() => rmSync(dir, { recursive: true, force: true }))
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e }
})

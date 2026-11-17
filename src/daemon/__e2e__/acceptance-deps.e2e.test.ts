import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeTokenRegistry } from '../internal-api/token-registry'
import type { makeCheckupTurn } from '../../features/checkup'
import { fenceNetwork } from './fake-boundaries'
import { startTestDaemon } from './harness'

it('uses the supplied session registry without widening token scope', async () => {
  const fence = fenceNetwork()
  const registry = makeTokenRegistry()
  const token = registry.mint('admin', 'synthetic-acceptance', { routeAllow: new Set(['GET /v1/health']) })
  try {
    const daemon = await startTestDaemon({ tokenRegistry: registry, claudeScript: { async onDispatch() { return { toolCalls: [], finalText: '合成回复' } } } })
    try {
      const { baseUrl } = JSON.parse(readFileSync(join(daemon.stateDir, 'internal-api-info.json'), 'utf8'))
      const headers = { authorization: 'Bearer ' + token }
      expect((await fetch(baseUrl + '/v1/health', { headers })).status).toBe(200)
      expect((await fetch(baseUrl + '/v1/sessions', { headers })).status).toBe(403)
      registry.invalidateSession('synthetic-acceptance')
      expect((await fetch(baseUrl + '/v1/health', { headers })).status).toBe(401)
      expect(fence.blocked().length).toBe(0)
    } finally { await daemon.stop() }
  } finally { fence.restore() }
})

it('runs the supplied checkup turn through the real API and observation store', async () => {
  const fence = fenceNetwork()
  let providerAvailable = false
  const reply = '这是合成体检观察。'
  const factory: typeof makeCheckupTurn = getProvider => {
    providerAvailable = getProvider('claude') !== null
    return async () => ({ text: reply, toolCalls: [], firstTextMs: 1, durationMs: 2 })
  }
  try {
    const daemon = await startTestDaemon({ makeCheckupTurn: factory, claudeScript: { async onDispatch() { return { toolCalls: [], finalText: '合成回复' } } } })
    try {
      const info = JSON.parse(readFileSync(join(daemon.stateDir, 'internal-api-info.json'), 'utf8'))
      const headers = { authorization: 'Bearer ' + readFileSync(info.operatorTokenFilePath, 'utf8').trim(), 'content-type': 'application/json' }
      const quote = await fetch(info.baseUrl + '/v1/checkup/estimate', { method: 'POST', headers, body: JSON.stringify({ providerId: 'claude', model: 'synthetic-model', full: false }) })
      expect(quote.status).toBe(200)
      const { targetKey } = await quote.json() as { targetKey: string }
      const run = await fetch(info.baseUrl + '/v1/checkup/run', { method: 'POST', headers, body: JSON.stringify({ providerId: 'claude', model: 'synthetic-model', full: false, expectedTargetKey: targetKey }) })
      expect(run.status).toBe(202)
      await expect.poll(async () => {
        const response = await fetch(info.baseUrl + '/v1/checkup?run=' + encodeURIComponent(targetKey), { headers })
        const view = await response.json() as { attempt?: { status: string } }
        return view.attempt?.status
      }).toBe('completed')
      const saved = JSON.parse(readFileSync(join(daemon.stateDir, 'checkup/observations.json'), 'utf8')) as Record<string, { samples: Record<string, { text: string }> }>
      const observations = Object.values(saved).flatMap(run => Object.values(run.samples))
      expect(providerAvailable).toBe(true)
      expect(observations.length).toBeGreaterThan(0)
      expect(observations.every(turn => turn.text === reply)).toBe(true)
      expect(fence.blocked().length).toBe(0)
    } finally { await daemon.stop() }
  } finally { fence.restore() }
})

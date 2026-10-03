/**
 * agy 边界产码(arch backlog #4 第 2 步)+ 红线 B。样本全是真机采集
 * (`diagnostics/__fixtures__/provider-errors/agy.json`)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyErrorCode } from './agy-errors'
import { createAgyAgentProvider } from './agy-agent-provider'
import { makeLlmHealth } from '../daemon/llm-health'
import { providerErrorCodeOf } from '../lib/provider-error-code'
import { TIER_PROFILES } from './user-tier'

const samples = JSON.parse(readFileSync(join(__dirname, '../daemon/diagnostics/__fixtures__/provider-errors/agy.json'), 'utf8')) as Array<{ id: string; message: string; errorCode: string | null }>
const AMBIGUOUS = samples.find(s => s.id === 'agy.ambiguous.cheap_eval')!

describe('agyErrorCode —— 每条真机样本的码与 fixture 一致', () => {
  it.each(samples.map(s => [s.id, s] as const))('%s', (_id, s) => {
    expect(agyErrorCode(s.message) ?? null).toBe(s.errorCode)
  })
  it('红线 B:歧义句固定是 network,永远不是认证码', () => {
    expect(agyErrorCode(AMBIGUOUS.message)).toBe('network')
  })
})

function fakeAgy(resultError: string) {
  const line = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', error: resultError.replace(/^agy result status=ERROR: /, ''), num_turns: 0 } })
  return (_args: string[], _o: { cwd: string }) => ({
    stdout: (async function* () { yield line + '\n' })(),
    exited: Promise.resolve(1),
    stderr: async () => '',
    kill: () => {},
  })
}

describe('agy provider 带码', () => {
  it('一次性评估:歧义句带 network 码抛出;桌面「测试连接」不报 AUTH FAILED、不给重新登录提示(以前报)', async () => {
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn: fakeAgy(AMBIGUOUS.message), log: () => {} })
    const err = await provider.cheapEval!('x').catch(e => e)
    expect((err as Error).message).toBe(AMBIGUOUS.message)
    expect(providerErrorCodeOf(err)).toBe('network')

    const health = makeLlmHealth({
      registry: { list: () => ['agy'] as never[], get: () => ({ provider }) } as never,
      defaultProviderId: 'agy' as never,
      hintFor: () => '请在电脑上重新登录 agy',
      timeoutMs: 5_000,
      log: () => {},
    })
    const [result] = (await health.dial()).results
    expect(result).toMatchObject({ provider: 'agy', ok: false, auth_failed: false, code: 'network' })
    expect(result).not.toHaveProperty('hint')
  })

  it('会话:result status=ERROR 的 error 事件带码(DNS ⇒ network)', async () => {
    const dns = samples.find(s => s.id === 'agy.dns.cheap_eval')!
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn: fakeAgy(dns.message), log: () => {} })
    const session = await provider.spawn({ alias: 'p', path: '/tmp' }, { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict', chatId: 'c' })
    const events: Array<{ kind: string; code?: string }> = []
    for await (const ev of session.dispatch('hi')) events.push(ev as never)
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'network' })])
  })
})

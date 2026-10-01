import { describe, expect, it } from 'vitest'
import { phoneLinkState, psetUrl } from './phone-link'

const RID = 'r' + 'a'.repeat(26)
const LEGACY = 't' + '0'.repeat(36)
const base = { owner: true, v2Configured: true, tunnelOn: true, bootRemoteId: RID }

describe('phoneLinkState(spec §4.1 的表,按顺序判)', () => {
  it.each([
    [{ ...base, owner: false, v2Configured: false }, 'no_owner'],
    [{ ...base, v2Configured: false, tunnelOn: false }, 'relay_not_configured'],
    [{ ...base, tunnelOn: false, bootRemoteId: null }, 'remote_off'],
    [{ ...base, bootRemoteId: null }, 'starting'],
    [{ ...base, bootRemoteId: LEGACY }, 'relay_unavailable'],
    [base, 'ready'],
  ] as const)('%o ⇒ %s', (i, want) => {
    expect(phoneLinkState(i)).toBe(want)
  })
})

describe('psetUrl:与原 linkUrl 同形', () => {
  it('v2 中继、带局域网地址', () => {
    expect(psetUrl({ relay: 'wss://relay.tendhearth.com/v2/phone', id: RID }, 't' + 'f'.repeat(32), '192.168.1.5:51234'))
      .toBe(`https://relay.tendhearth.com/pset/#id=${RID}&t=t${'f'.repeat(32)}&p=%2Fset&lan=192.168.1.5:51234`)
  })
  it('没有局域网地址就不带 lan=', () => {
    expect(psetUrl({ relay: 'wss://relay-staging.tendhearth.com/v2/phone', id: RID }, 'tx', null))
      .toBe(`https://relay-staging.tendhearth.com/pset/#id=${RID}&t=tx&p=%2Fset`)
  })
})

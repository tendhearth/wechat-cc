import { describe, expect, it } from 'vitest'
import { resolveAcpAgent } from './agents'

describe('ACP agent launch resolution', () => {
  it('prefers the configured cursor-agent path, then PATH, and never probes', () => {
    expect(resolveAcpAgent('cursor', { cursorAgentBin: '/opt/cursor-agent' }, () => '/usr/bin/cursor-agent')).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/opt/cursor-agent', args: ['acp'] })
    expect(resolveAcpAgent('cursor', {}, cmd => cmd === 'cursor-agent' ? '/usr/bin/cursor-agent' : null)).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/usr/bin/cursor-agent', args: ['acp'] })
    expect(resolveAcpAgent('cursor', {}, () => null)).toBeNull()
  })
})

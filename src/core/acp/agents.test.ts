import { describe, expect, it } from 'vitest'
import { resolveAcpAgent } from './agents'

describe('ACP agent launch resolution', () => {
  it('prefers the configured cursor-agent path, then PATH, and never probes', () => {
    expect(resolveAcpAgent('cursor', { cursorAgentBin: '/opt/cursor-agent' }, () => '/usr/bin/cursor-agent')).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/opt/cursor-agent', args: ['acp'] })
    expect(resolveAcpAgent('cursor', {}, cmd => cmd === 'cursor-agent' ? '/usr/bin/cursor-agent' : null)).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/usr/bin/cursor-agent', args: ['acp'] })
    expect(resolveAcpAgent('cursor', {}, () => null)).toBeNull()
    // 面板里把路径清空 = 空串,等于没配,该回落到 PATH 而不是去 spawn 一个空命令。
    expect(resolveAcpAgent('cursor', { cursorAgentBin: '' }, () => '/usr/bin/cursor-agent')).toEqual({ id: 'cursor', displayName: 'Cursor', command: '/usr/bin/cursor-agent', args: ['acp'] })
  })
})

import { describe, expect, it } from 'vitest'
import { agentGlyph, agentMonogram, agentName, agentsLabel, agentStack, matterAgents } from './agents'

describe('执行者头像', () => {
  it('认得的几家有图标,别的画首字母', () => {
    expect(agentGlyph('claude')).toBe('claude')
    expect(agentGlyph('agy')).toBe('agy')
    expect(agentGlyph('my-acp')).toBeNull()
    expect(agentMonogram('my-acp')).toBe('M')
    expect(agentName('codex')).toBe('Codex')
    expect(agentName('my-acp')).toBe('my-acp')
  })
  it('最多露 3 个,正好多一个就直接画出来,再多折成 +N;去重、保持顺序', () => {
    expect(agentStack(undefined)).toEqual({ shown: [], more: 0 })
    expect(agentStack(['codex', 'claude', 'codex'])).toEqual({ shown: ['codex', 'claude'], more: 0 })
    expect(agentStack(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c', 'd'], more: 0 })
    expect(agentStack(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
  })
  it('读屏念名字;详情页任务那一家排第一,老 daemon 不带 agents 也有', () => {
    expect(agentsLabel(['claude', 'codex'])).toBe('Claude Code、Codex')
    expect(matterAgents({ task: { providerId: 'codex' }, matter: { agents: ['claude', 'codex'] } })).toEqual(['codex', 'claude'])
    expect(matterAgents({ task: { providerId: 'claude' }, matter: {} })).toEqual(['claude'])
    expect(matterAgents({ task: null, matter: {} })).toEqual([])
  })
})

describe('执行者头像的许可', () => {
  it('页面上显示的许可跟随包的 LICENSE.txt 一字不差,每个图标都有 1x/2x/3x', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { ICON_LICENCE_TEXT } = await import('../ui/icon-licence')
    const { AGENT_GLYPHS } = await import('./agents')
    const dir = join(__dirname, '../../assets/agents')
    expect(ICON_LICENCE_TEXT).toBe(readFileSync(join(dir, 'LICENSE.txt'), 'utf8'))
    for (const g of AGENT_GLYPHS) for (const s of ['', '@2x', '@3x']) expect(existsSync(join(dir, `${g}${s}.png`)), `${g}${s}`).toBe(true)
  })
})

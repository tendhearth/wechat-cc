import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAgentAvatars } from './agent-avatars.js'

const A = createAgentAvatars()

describe('执行者头像(桌面 / 手机网页共用)', () => {
  it('认得的几家有图标,别的画首字母;名字先认桌面给的 displayName', () => {
    expect(A.AGENT_GLYPHS).toEqual(['claude', 'codex', 'cursor', 'agy', 'gemini', 'kimi', 'openai', 'deepseek', 'qwen'])
    expect(A.agentGlyph('claude')).toBe('claude')
    expect(A.agentGlyph('my-acp')).toBeNull()
    expect(A.agentGlyph('toString')).toBeNull()
    expect(A.agentMonogram('my-acp')).toBe('M')
    expect(A.agentMonogram('my-acp', () => '小助手')).toBe('小')
    expect(A.agentName('codex')).toBe('Codex')
    expect(A.agentName('my-acp')).toBe('my-acp')
    expect(A.agentName('claude', id => id === 'claude' ? 'Claude' : undefined)).toBe('Claude')
  })

  it('最多露 3 个,正好多一个就直接画出来,再多折成 +N;去重、去空、保持顺序', () => {
    expect(A.agentStack(undefined)).toEqual({ shown: [], more: 0 })
    expect(A.agentStack(['codex', 'claude', 'codex', '', null])).toEqual({ shown: ['codex', 'claude'], more: 0 })
    expect(A.agentStack(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c', 'd'], more: 0 })
    expect(A.agentStack(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
  })

  it('读屏念名字;任务那一家排第一,老 daemon 不带 agents 也有', () => {
    expect(A.agentsLabel(['claude', 'codex'])).toBe('Claude Code、Codex')
    expect(A.matterAgents('codex', ['claude', 'codex'])).toEqual(['codex', 'claude'])
    expect(A.matterAgents('claude', undefined)).toEqual(['claude'])
    expect(A.matterAgents(null, [])).toEqual([])
  })

  it('画出来:正在做的压在最上(z-index 递减),+N 垫底;整组一张图,标签和 title 念全部名字;没有就空串', () => {
    expect(A.agentAvatarsHtml([])).toBe('')
    expect(A.agentAvatarsHtml(undefined)).toBe('')
    const html = A.agentAvatarsHtml(['codex', 'claude', 'cursor', 'my-acp', 'kimi'], { cls: 'x' })
    expect(html).toMatch(/^<span class="th-agents x" role="img" aria-label="Codex、Claude Code、Cursor、my-acp、Kimi" title="Codex、Claude Code、Cursor、my-acp、Kimi">/)
    expect([...html.matchAll(/style="z-index:(\d+)" data-agent="([^"]+)"/g)].map(m => [m[2], Number(m[1])])).toEqual([['codex', 4], ['claude', 3], ['cursor', 2]])
    expect(html).toContain('<span class="th-agent th-agent-more" style="z-index:0" aria-hidden="true">+2</span>')
    // 单色:跟着 currentColor 走,不带任何品牌色
    expect(html).toContain('fill="currentColor"')
    expect(html).not.toMatch(/fill="#|stop-color|style="fill/)
  })

  it('没图标的画首字母圆;id / 名字都转义', () => {
    const html = A.agentAvatarsHtml(['<x>'], { nameOf: () => '"引号"' })
    expect(html).toContain('aria-label="&quot;引号&quot;"')
    expect(html).toContain('data-agent="&lt;x&gt;"')
    expect(html).toContain('<span class="th-agent-mono" aria-hidden="true">&quot;</span>')
    expect(html).not.toContain('<svg')
  })

  it('图形来自 LobeHub(MIT):许可原文跟 app 那份一字不差,源码里带着许可声明(手机页整段内联时一起带走)', () => {
    const here = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    expect(here('./agent-glyphs-LICENSE.txt')).toBe(here('../../../app/assets/agents/LICENSE.txt'))
    const source = here('./agent-avatars.js')
    const factory = source.slice(source.indexOf('export function createAgentAvatars'))
    expect(factory).toContain('Copyright (c) 2023 LobeHub')
    expect(factory).toContain('The above copyright notice and this permission notice shall be included in all')
  })
})

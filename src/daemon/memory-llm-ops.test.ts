import { describe, it, expect, vi } from 'vitest'
import { makeMemoryLlmOps, resolveCheapEval } from './memory-llm-ops'
import { invalidateDerivedMemory } from '../lib/memory-derived-state'

// NOTE: brief used '../../lib/memory-synthesis' — that resolves one level
// too high from src/daemon/. Both this test file and memory-llm-ops.ts live
// in src/daemon/, so the correct relative path (matching the impl's own
// dynamic import) is '../lib/memory-synthesis'.
vi.mock('../lib/memory-synthesis', () => ({
  synthesizeOverview: vi.fn(async (o: any) => ({ ok: true, written: { path: '_overview.md', bytesWritten: 10 }, _eval: await o.sdkEval('x') })),
  synthesizeProfile: vi.fn(async (o: any) => ({ ok: true, written: { path: '_profile.json', bytesWritten: 5 }, _eval: await o.sdkEval('y') })),
  OVERVIEW_FILENAME: '_overview.md',
}))
vi.mock('./life-stores', () => ({ makeLifeStoresReader: () => ({}) }))

function make(over: Record<string, any> = {}) {
  const cheapEval = vi.fn(async (p: string) => `EVAL:${p}`)
  const deps = {
    stateDir: '/tmp/s', db: {} as any,
    getMode: vi.fn(() => ({ kind: 'solo', provider: 'claude' })),
    registry: { get: vi.fn(() => ({ provider: { cheapEval } })), getCheapEval: () => cheapEval },
    ...over,
  }
  return { ops: makeMemoryLlmOps(deps as any), cheapEval, deps }
}

describe('makeMemoryLlmOps', () => {
  it('synthesize 用会话 provider 的 cheapEval', async () => {
    const { ops, cheapEval } = make()
    const r = await ops.synthesize('admin1') as any
    expect(r.written.path).toBe('_overview.md')
    expect(cheapEval).toHaveBeenCalled()          // sdkEval routed to the daemon cheapEval
  })
  it('generateProfile 用同一 cheapEval', async () => {
    const { ops, cheapEval } = make()
    const r = await ops.generateProfile('admin1') as any
    expect(r.written.path).toBe('_profile.json')
    expect(cheapEval).toHaveBeenCalled()
  })
  it('会话非 solo → 回落 registry.getCheapEval', async () => {
    const cheap = vi.fn(async () => 'X')
    const { ops } = make({ getMode: () => ({ kind: 'parallel' }), registry: { get: () => undefined, getCheapEval: () => cheap } })
    await ops.synthesize('a')
    expect(cheap).toHaveBeenCalled()
  })
  it('无任何 provider → 抛 no LLM provider', async () => {
    const { ops } = make({ getMode: () => undefined, registry: { get: () => undefined, getCheapEval: () => null } })
    await expect(ops.synthesize('a')).rejects.toThrow(/no LLM provider/)
  })
})

describe('generatePortrait (CC 手绘小像)', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')

  const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><circle cx="160" cy="120" r="60" fill="none" stroke="#5a3f2d" stroke-width="4"/></svg>'

  function seedState(overview = '# 主人\n全栈开发者,喜欢咖啡和键盘。'): string {
    const dir = mkdtempSync(join(tmpdir(), 'portrait-'))
    mkdirSync(join(dir, 'memory', 'admin1'), { recursive: true })
    if (overview) writeFileSync(join(dir, 'memory', 'admin1', '_overview.md'), overview)
    return dir
  }

  it('does not use stale derived material when generating a portrait', async () => {
    const stateDir = seedState('stale overview')
    const root = join(stateDir, 'memory', 'admin1')
    writeFileSync(join(root, '_profile.json'), JSON.stringify({ summary: 'stale profile' }))
    writeFileSync(join(root, 'profile.md'), 'canonical fresh profile')
    invalidateDerivedMemory(root)
    const { ops, cheapEval } = make({ stateDir })
    cheapEval.mockResolvedValueOnce(GOOD_SVG)
    expect((await ops.generatePortrait('admin1')).ok).toBe(true)
    expect(cheapEval.mock.calls[0]![0]).toContain('canonical fresh profile')
    expect(cheapEval.mock.calls[0]![0]).not.toContain('stale')
  })

  it('discards a portrait if sources were corrected while the LLM was running', async () => {
    const stateDir = seedState()
    const { ops, cheapEval } = make({ stateDir })
    cheapEval.mockImplementationOnce(async () => {
      invalidateDerivedMemory(join(stateDir, 'memory', 'admin1'))
      return GOOD_SVG
    })
    expect(await ops.generatePortrait('admin1')).toMatchObject({ ok: false, error: 'source_changed' })
    expect(existsSync(join(stateDir, 'memory', 'admin1', 'portrait.svg'))).toBe(false)
  })

  it('从画像素材取材,产出净化后的 portrait.svg + 元数据', async () => {
    const stateDir = seedState()
    const { ops, cheapEval } = make({ stateDir })
    cheapEval.mockResolvedValueOnce('好的!给主人画一张:\n```svg\n' + GOOD_SVG + '\n```')
    const r = await ops.generatePortrait('admin1') as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(readFileSync(join(stateDir, 'memory', 'admin1', 'portrait.svg'), 'utf8')).toBe(GOOD_SVG)
    const meta = JSON.parse(readFileSync(join(stateDir, 'memory', 'admin1', 'portrait.json'), 'utf8'))
    expect(typeof meta.generated_at).toBe('string')
    expect(String(cheapEval.mock.calls.at(-1)?.[0])).toContain('咖啡')   // material reached the prompt
  })

  it('模型输出危险 SVG → ok:false,不落盘', async () => {
    const stateDir = seedState()
    const { ops, cheapEval } = make({ stateDir })
    cheapEval.mockResolvedValueOnce('<svg onload="alert(1)"><circle r="5"/></svg>')
    const r = await ops.generatePortrait('admin1') as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(existsSync(join(stateDir, 'memory', 'admin1', 'portrait.svg'))).toBe(false)
  })

  it('无任何素材 → ok:false no_profile,不调模型', async () => {
    const stateDir = seedState('')
    const { ops, cheapEval } = make({ stateDir })
    const r = await ops.generatePortrait('admin1') as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toBe('no_profile')
    expect(cheapEval).not.toHaveBeenCalled()
  })

  it('路径不安全的 chatId → ok:false', async () => {
    const { ops } = make({ stateDir: seedState() })
    const r = await ops.generatePortrait('../evil') as { ok: boolean }
    expect(r.ok).toBe(false)
  })
})

describe('resolveCheapEval', () => {
  const own = async () => 'own', fallback = async () => 'fallback'
  const registry = { get: (id: string) => (id === 'codex' ? { provider: { cheapEval: own } } : null), getCheapEval: () => fallback }
  it('follows the chat solo provider, else the registry default', () => {
    expect(resolveCheapEval({ getMode: () => ({ kind: 'solo', provider: 'codex' }), registry }, 'c')).toBe(own)
    expect(resolveCheapEval({ getMode: () => undefined, registry }, 'c')).toBe(fallback)
  })
})

/**
 * memory-llm-ops.ts — the daemon's LLM-backed memory operations (overview
 * synthesis + profile generation), wired with the daemon's OWN provider
 * cheapEval (claude path resolved correctly). Shared by BOTH the WeChat
 * admin-command path (pipeline-deps synthesizeMemory) and the internal-api
 * routes the desktop calls (routes-memory). This is the single place LLM
 * memory ops run — NEVER the compiled CLI sidecar (spec §1).
 */
import type { Db } from '../lib/db'

export interface MemoryLlmOpsDeps {
  stateDir: string
  db: Db
  getMode: (chatId: string) => { kind: string; provider?: string } | undefined
  registry: {
    get(id: string): { provider: { cheapEval?: (p: string) => Promise<string> } } | null | undefined
    getCheapEval(): ((p: string) => Promise<string>) | null
  }
}

export interface MemoryLlmOps {
  synthesize(adminChatId: string): Promise<import('../lib/memory-synthesis').SynthesizeResult>
  generateProfile(adminChatId: string): Promise<import('../lib/memory-synthesis').SynthesizeProfileResult>
  /** CC 手绘小像 — draw the OWNER as a hand-sketch SVG from the profile
   *  material (never CC's own avatar; the page is 「CC 眼中的你」). Output
   *  passes lib/svg-sanitize's reject-only allowlist before touching disk. */
  generatePortrait(adminChatId: string): Promise<{ ok: boolean; error?: string; path?: string }>
}

export function makeMemoryLlmOps(deps: MemoryLlmOpsDeps): MemoryLlmOps {
  // Follow the admin conversation's provider; fall back to the registry's
  // cheapest eval. (Lifted verbatim from pipeline-deps synthesizeMemory.)
  const resolveCheapEval = (adminChatId: string) => {
    const mode = deps.getMode(adminChatId)
    const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
    const cheapEval = (provider ? deps.registry.get(provider)?.provider.cheapEval : null) ?? deps.registry.getCheapEval()
    if (!cheapEval) throw new Error('no LLM provider available for synthesis')
    return cheapEval
  }
  return {
    async synthesize(adminChatId) {
      const { synthesizeOverview } = await import('../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('./life-stores')
      const cheapEval = resolveCheapEval(adminChatId)
      return synthesizeOverview({ stateDir: deps.stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), includeFileSurvey: true })
    },
    async generateProfile(adminChatId) {
      const { synthesizeProfile } = await import('../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('./life-stores')
      const mode = deps.getMode(adminChatId)
      const modelProvider = mode && mode.kind === 'solo' ? (mode.provider ?? 'claude') : 'claude'
      const cheapEval = resolveCheapEval(adminChatId)
      return synthesizeProfile({ stateDir: deps.stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), generatedBy: 'manual', modelProvider })
    },
    async generatePortrait(adminChatId) {
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { safeSvg } = await import('../lib/svg-sanitize')
      // chatId feeds a path join — same shape guard as main.ts's personaFor.
      if (adminChatId.includes('..') || adminChatId.includes('/') || adminChatId.includes('\\')) {
        return { ok: false, error: 'bad_chat_id' }
      }
      const memDir = join(deps.stateDir, 'memory', adminChatId)
      // Material: prefer the structured profile, fall back to the overview,
      // then the raw profile.md. No material → nothing honest to draw from.
      let material = ''
      const profileJson = join(memDir, '_profile.json')
      if (existsSync(profileJson)) {
        try {
          const p = JSON.parse(readFileSync(profileJson, 'utf8')) as { summary?: string; tags?: string[]; insight?: string }
          material = [p.summary, p.insight, (p.tags ?? []).join('、')].filter(Boolean).join('\n')
        } catch { /* fall through to overview */ }
      }
      if (!material) for (const f of ['_overview.md', 'profile.md']) {
        const fp = join(memDir, f)
        if (existsSync(fp)) { material = readFileSync(fp, 'utf8').trim(); if (material) break }
      }
      if (!material) return { ok: false, error: 'no_profile' }

      const cheapEval = resolveCheapEval(adminChatId)
      const raw = await cheapEval(buildPortraitPrompt(material.slice(0, 2000)))
      const m = raw.match(/<svg[\s\S]*<\/svg>/)
      const svg = m ? safeSvg(m[0]) : null
      if (!svg) return { ok: false, error: 'unsafe_svg' }
      const path = join(memDir, 'portrait.svg')
      writeFileSync(path, svg)
      writeFileSync(join(memDir, 'portrait.json'), JSON.stringify({ generated_at: new Date().toISOString() }))
      return { ok: true, path }
    },
  }
}

/** Exported for tests. */
export function buildPortraitPrompt(material: string): string {
  return (
    `你是 CC,一只住在暖纸色世界里的手绘小熊。请根据下面对主人的了解,给**主人**画一幅简笔小像(不是画你自己)。\n` +
    `硬性要求:\n` +
    `- 输出一个 SVG:根元素 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">\n` +
    `- 只允许这些元素:g/path/circle/ellipse/rect/line/polyline/polygon/title\n` +
    `- 属性一律双引号;禁止 style/class/id/href/text/image/use/script/动画\n` +
    `- 手绘感:stroke-width 3~5 的松弛线条,颜色只用 #5a3f2d(主线)、#b0563a(点缀)、#8a5a36、#f5ead8(浅底)、none\n` +
    `- 简笔圆脸人物 + 1~2 个来自主人特质的小道具(比如键盘、咖啡、耳机——从了解里挑)\n` +
    `**只输出 SVG,不要任何解释,不要代码围栏。**\n\n` +
    `对主人的了解:\n${material}`
  )
}

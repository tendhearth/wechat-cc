import { describe, expect, it } from 'vitest'
import { tierEnforcement } from './tier-enforcement'
import { KNOWN_PROVIDER_IDS } from './capability-matrix'
import { TIER_PROFILES, type UserTier } from './user-tier'
import { makeCanUseTool } from './permission-relay'
import { gateTool } from './openai-gate'
import { makeGeminiToolGate } from './gemini-agent-provider'

// 评审 #464:「per-tool」原来只看自报的 perToolCallback,证明不了那家的 gate 真在查档位。
// 这里每家真调一次 gate:访客碰 shell、trusted 碰 admin 专用工具,都必须被拒。
// 下面的 INVOKERS 必须恰好覆盖表里所有 per-tool 的执行者 —— 新接一家标了 perToolCallback 却没在这里写调用,守卫就红。
type Invoke = (tier: UserTier, tool: { name: string; wechat: boolean; input: Record<string, unknown> }) => Promise<boolean>
const deniedAsk = async () => 'deny' as const
const INVOKERS: Record<string, Invoke> = {
  claude: async (tier, t) => {
    const gate = makeCanUseTool({ askUser: deniedAsk, initiatingChatId: () => 'c', adminChatId: () => 'owner', resolveTier: () => tier, log: () => {}, mode: () => 'solo', provider: 'claude', permissionMode: 'strict' })
    const r = await gate(t.wechat ? `mcp__wechat__${t.name}` : t.name, t.input, { signal: new AbortController().signal } as never)
    return r.behavior === 'allow'
  },
  openai: async (tier, t) => gateTool({ toolName: t.name, ...(t.wechat ? { mcpServer: 'wechat' } : {}), input: t.input, tierProfile: TIER_PROFILES[tier], permissionMode: 'strict' }) === 'allow',
  gemini: async (tier, t) => {
    if (!t.wechat) return false   // Gemini 只有 wechat MCP 工具,没有内置 shell(gate 把裸名当 wechat 工具)
    const gate = makeGeminiToolGate({ askUser: deniedAsk, adminFor: () => 'owner', modeFor: () => 'solo', lookupBase: () => ({ askUser: 'per-tool' }) as never })({ chatId: 'c', tierProfile: TIER_PROFILES[tier], permissionMode: 'strict' } as never)
    return (await gate(t.name, t.input)).allow
  },
}

describe('per-tool proof: the gate really consults the tier', () => {
  it('INVOKERS covers exactly the providers the table calls per-tool', () => {
    const perTool = KNOWN_PROVIDER_IDS.filter(p => tierEnforcement(p, 'guest').how === 'per-tool' || tierEnforcement(p, 'trusted').how === 'per-tool').sort()
    expect(Object.keys(INVOKERS).sort()).toEqual(perTool)
  })
  for (const [p, invoke] of Object.entries(INVOKERS)) {
    it(`${p}: guest is refused shell; trusted is refused an admin-only tool; admin may use the admin tool`, async () => {
      expect(await invoke('guest', { name: 'Bash', wechat: false, input: { command: 'ls' } }), `${p} guest shell`).toBe(false)
      expect(await invoke('trusted', { name: 'model_get', wechat: true, input: {} }), `${p} trusted model_get`).toBe(false)
      expect(await invoke('admin', { name: 'model_get', wechat: true, input: {} }), `${p} admin model_get`).toBe(true)
    })
  }
})

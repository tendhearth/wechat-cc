import { describe, expect, it } from 'vitest'
import { decideTool } from './tool-decision'
import { TIER_PROFILES, classifyToolUse, type ToolKind } from './user-tier'

/** 改之前那三份各自的写法(原样抄下来,只为证明收成一处以后每一格都没变)。 */
function oldClaudeOrGemini(tp: (typeof TIER_PROFILES)[keyof typeof TIER_PROFILES], kind: ToolKind, askUser: 'per-tool' | 'never') {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  if (tp.allow.has(kind)) return 'allow'
  return askUser === 'per-tool' ? 'relay' : 'allow'
}
function oldOpenai(tp: (typeof TIER_PROFILES)[keyof typeof TIER_PROFILES], kind: ToolKind, relayAs: 'allow' | 'deny') {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return relayAs
  return 'allow'
}

// 所有档位里出现过的类别,加上 classifyToolUse 能产出的几样(未知工具落成 subagent)
const KINDS = [...new Set([
  ...Object.values(TIER_PROFILES).flatMap(tp => [...tp.allow, ...tp.relay, ...tp.deny]),
  classifyToolUse('Bash', { command: 'rm -rf /' }), classifyToolUse('Read', {}), classifyToolUse('mcp__x__y', {}),
])] as ToolKind[]

describe('decideTool:三家共用的那一条判定(架构终态 C1)', () => {
  it('每个档位 × 每个类别 × 能力表两种 askUser:和原来 Claude / Gemini 那份一格不差', () => {
    for (const tp of Object.values(TIER_PROFILES)) for (const kind of KINDS) for (const ask of ['per-tool', 'never'] as const) {
      expect(decideTool(tp, kind, ask), `${kind}/${ask}`).toBe(oldClaudeOrGemini(tp, kind, ask))
    }
  })
  it('openai 那份(不看能力表,问不了 ⇒ relayAs):一格不差', () => {
    for (const tp of Object.values(TIER_PROFILES)) for (const kind of KINDS) for (const relayAs of ['allow', 'deny'] as const) {
      const v = decideTool(tp, kind)
      expect(v === 'relay' ? relayAs : v, kind).toBe(oldOpenai(tp, kind, relayAs))
    }
  })
  it('档位明说放 ⇒ 不再看能力表(strict 下 admin 读文件不弹卡)', () => {
    expect(decideTool(TIER_PROFILES.admin, 'fs_read', 'per-tool')).toBe('allow')
  })
})

import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wirePlugins } from './wire-plugins'

const ctx = () => ({ stateDir: mkdtempSync(join(tmpdir(), 'wp-')), log: () => {} })

describe('wirePlugins', () => {
  it('没有 internalApi ⇒ 所有 stdio spec 为 null,delegate 表为空', () => {
    const s = wirePlugins({}, ctx())
    expect(s.wechatStdioForClaude).toBeNull()
    expect(s.wechatStdioForCodex).toBeNull()
    expect(s.wechatStdioForAgy).toBeNull()
    expect(s.delegateStdioForClaude).toBeNull()
    expect(Object.keys(s.delegateStdioByProvider)).toEqual([])
    expect(s.knowledgePluginNames).toEqual(Object.keys(s.pluginMcp))
  })
  it('有 internalApi ⇒ 每家 provider 一份 wechat spec;声明 defaultPeer 的家有 delegate spec', () => {
    const s = wirePlugins(
      { internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: join(tmpdir(), 'tok') } },
      ctx(),
    )
    expect(s.wechatStdioForClaude?.env).toMatchObject({ WECHAT_INTERNAL_API: 'http://127.0.0.1:0' })
    expect(s.wechatStdioForCursor).not.toBeNull()
    expect(s.wechatStdioForOpenai).not.toBeNull()
    expect(s.wechatStdioForGemini).not.toBeNull()
    expect(s.wechatStdioForAgy).not.toBeNull()
    // claude 声明 defaultPeer=codex ⇒ 有 delegate spec;表与 ForX 字段一致。
    expect(s.delegateStdioForClaude).not.toBeNull()
    expect(s.delegateStdioForClaude).toBe(s.delegateStdioByProvider.claude ?? null)
    expect(s.delegateStdioForCodex).toBe(s.delegateStdioByProvider.codex ?? null)
    for (const v of Object.values(s.pluginMcpForClaude)) expect(v.type).toBe('stdio')
  })
})

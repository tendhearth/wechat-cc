import { describe, it, expect } from 'vitest'
import { assertGatewayHost, assertProviderSeams, measureLegacy } from './harness'
import { STATE_DIR } from './isolate'
import type { AgentEvent } from '../../../src/core/agent-provider'

describe('harness 护栏', () => {
  it('状态目录是临时目录,不是主人的 ~/.claude/channels/wechat', () => {
    expect(process.env.WECHAT_STATE_DIR).toBe(STATE_DIR)
    expect(STATE_DIR).toContain('reply-once-')
    expect(STATE_DIR).not.toContain('.claude/channels')
  })

  it('只许打主人自建网关', () => {
    expect(() => assertGatewayHost('https://llm.youdamaster.cc/v1')).not.toThrow()
    expect(() => assertGatewayHost('https://api.deepseek.com/v1')).toThrow(/拒跑/)
    expect(() => assertGatewayHost('not a url')).toThrow()
  })

  it('provider 有 makeBuiltins 注入口 ⇒ 不拒跑(第 0 步把它加回来了)', () => {
    expect(() => assertProviderSeams('baseline')).not.toThrow()
  })

  it('provider 没有注入口 ⇒ 拒跑(否则模型调的 Bash 会被真执行)', () => {
    expect(() => assertProviderSeams('baseline', 'function createOpenAiAgentProvider() {}')).toThrow(/拒跑/)
  })
})

describe('measureLegacy — legacy 一轮主人到底收到了什么', () => {
  const t = (text: string): AgentEvent => ({ kind: 'text', text })
  const tool = (name: string): AgentEvent => ({ kind: 'tool_call', server: 'wechat', tool: name })

  it('私聊里调过 reply ⇒ 只算 reply 的文字,旁白不外泄', () => {
    const m = measureLegacy([t('我查一下'), tool('reply'), t('（发完了）')], { replies: ['好的'], texts: ['好的'], voices: [] }, 'dm')
    expect(m.delivered).toEqual(['好的'])
    expect(m.narrationLeaked).toBe(0)
  })

  it('私聊里没调 reply ⇒ FALLBACK 把每段都发了,旁白外泄', () => {
    const m = measureLegacy([t('我查一下'), tool('list_projects'), t('有两个')], { replies: [], texts: [], voices: [] }, 'dm')
    expect(m.delivered).toEqual(['我查一下', '有两个'])
    expect(m.narrationLeaked).toBe(1)
  })

  it('伙伴推送只认 reply:文字全丢 ⇒ 静默', () => {
    const m = measureLegacy([t('这条过期了,不发')], { replies: [], texts: [], voices: [] }, 'tick')
    expect(m.delivered).toEqual([])
    expect(m.silent).toBe(true)
  })

  it('reply_voice 记成语音附件;令牌外泄能看出来', () => {
    const m = measureLegacy([], { replies: ['晚安', 'NO_REPLY'], texts: ['NO_REPLY'], voices: ['晚安'] }, 'dm')
    expect(m.attachments).toEqual(['voice'])
    expect(m.tokenLeaked).toBe(true)
  })
})

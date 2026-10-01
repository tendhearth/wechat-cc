import { describe, expect, it, vi } from 'vitest'
import { makePhoneChat, PHONE_CHAT_JOB_TTL_MS, PHONE_CHAT_TIMEOUT_MS } from './phone-chat'

const RID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function rig(over: Partial<Parameters<typeof makePhoneChat>[0]> = {}) {
  const calls: Array<{ text: string; resolve: (r: { reply: string }) => void; reject: (e: Error) => void }> = []
  const settled: string[] = []
  const chat = makePhoneChat({
    converse: text => new Promise((resolve, reject) => calls.push({ text, resolve, reject })),
    ownerMatterId: () => 'c0ffee01',
    onSettled: id => settled.push(id),
    now: () => 1000,
    ...over,
  })
  return { chat, calls, settled }
}
const tick = () => new Promise(r => setTimeout(r, 0))

describe('makePhoneChat', () => {
  it('收下即回 pending;回复到了 ⇒ 不再 pending、onSettled 一次', async () => {
    const r = rig()
    const job = r.chat.say(RID(1), '你好')
    expect(job).toMatchObject({ requestId: RID(1), matterId: 'c0ffee01', status: 'pending', text: '你好' })
    expect(r.chat.pendingMatter()).toBe('c0ffee01')
    await tick()
    r.calls[0]!.resolve({ reply: '在呢' }); await tick()
    expect(r.chat.state()).toEqual({ pending: null, failed: null })
    expect(r.settled).toEqual(['c0ffee01'])
  })
  it('同一 requestId 再发(在飞 / 已回复)⇒ 同一份结果,不起第二轮', async () => {
    const r = rig()
    r.chat.say(RID(1), '你好'); r.chat.say(RID(1), '你好')
    await tick()
    expect(r.calls).toHaveLength(1)
    r.calls[0]!.resolve({ reply: 'x' }); await tick()
    expect(r.chat.say(RID(1), '你好').status).toBe('replied')
    await tick()
    expect(r.calls).toHaveLength(1)
  })
  it('另一句还在等 ⇒ chat_busy', () => {
    const r = rig()
    r.chat.say(RID(1), 'a')
    expect(() => r.chat.say(RID(2), 'b')).toThrow('chat_busy')
  })
  it('微信那轮在跑(reply_sink_busy)⇒ failed busy;不自动重发;同一 requestId 再发 = 重试', async () => {
    const r = rig()
    r.chat.say(RID(1), 'a'); await tick()
    r.calls[0]!.reject(new Error('reply_sink_busy')); await tick()
    expect(r.chat.state().failed).toMatchObject({ requestId: RID(1), status: 'failed', error: 'busy' })
    await tick(); expect(r.calls).toHaveLength(1)
    expect(r.chat.say(RID(1), 'a').status).toBe('pending')
    await tick()
    expect(r.calls).toHaveLength(2)
    expect(r.chat.state().failed).toBeNull()
  })
  it('群聊模式(owner_chat_in_chatroom_mode)也算 busy', async () => {
    const r = rig()
    r.chat.say(RID(1), 'a'); await tick()
    r.calls[0]!.reject(new Error('owner_chat_in_chatroom_mode')); await tick()
    expect(r.chat.state().failed?.error).toBe('busy')
  })
  it('错误码映射:未配主人 ⇒ not_configured;其它 ⇒ unavailable', async () => {
    const r = rig()
    r.chat.say(RID(1), 'a'); await tick(); r.calls[0]!.reject(new Error('companion_owner_chat_not_configured')); await tick()
    expect(r.chat.state().failed?.error).toBe('not_configured')
    r.chat.say(RID(2), 'b'); await tick(); r.calls[1]!.reject(new Error('boom')); await tick()
    expect(r.chat.state().failed?.error).toBe('unavailable')
  })
  it('没配主人对话 ⇒ no_owner_chat,不调 converse', async () => {
    const r = rig({ ownerMatterId: () => null })
    expect(() => r.chat.say(RID(1), 'a')).toThrow('no_owner_chat')
    await tick()
    expect(r.calls).toHaveLength(0)
  })
  it('onSettled 抛错不影响任务结束', async () => {
    const r = rig({ onSettled: () => { throw new Error('x') } })
    r.chat.say(RID(1), 'a'); await tick(); r.calls[0]!.resolve({ reply: 'y' }); await tick()
    expect(r.chat.state().pending).toBeNull()
  })
  it('日志不含正文', async () => {
    const logs: string[] = []
    const r = rig({ log: (_t, l) => logs.push(l) })
    r.chat.say(RID(1), '秘密内容'); await tick(); r.calls[0]!.reject(new Error('boom')); await tick()
    expect(logs.join('\n')).not.toContain('秘密内容')
    expect(logs.join('\n')).toContain(RID(1).slice(0, 8))
  })
  it('converse 同步抛错 ⇒ failed unavailable,不卡在 pending', async () => {
    const r = rig({ converse: () => { throw new Error('sync boom') } })
    const job = r.chat.say(RID(1), 'a')
    expect(job.status).toBe('pending')
    await tick()
    expect(r.chat.state()).toMatchObject({ pending: null, failed: { requestId: RID(1), error: 'unavailable' } })
    expect(r.chat.pendingMatter()).toBeNull()
    expect(() => r.chat.say(RID(2), 'b')).not.toThrow()
  })
  it('converse 挂住超过 10 分钟 ⇒ failed unavailable;之后迟到的回复不翻案', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      r.chat.say(RID(1), 'a'); await vi.advanceTimersByTimeAsync(0)
      expect(r.calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(PHONE_CHAT_TIMEOUT_MS - 1)
      expect(r.chat.state().pending).not.toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(r.chat.state()).toMatchObject({ pending: null, failed: { requestId: RID(1), error: 'unavailable' } })
      expect(r.settled).toEqual(['c0ffee01'])
      r.calls[0]!.resolve({ reply: 'late' }); await vi.advanceTimersByTimeAsync(0)
      expect(r.chat.state().failed?.status).toBe('failed')
      expect(r.settled).toEqual(['c0ffee01'])
    } finally { vi.useRealTimers() }
  })
  it('failed 过了 TTL 就不再显示', async () => {
    let t = 1000
    const r = rig({ now: () => t })
    r.chat.say(RID(1), 'a'); await tick(); r.calls[0]!.reject(new Error('boom')); await tick()
    expect(r.chat.state().failed).not.toBeNull()
    t += PHONE_CHAT_JOB_TTL_MS + 1
    expect(r.chat.state().failed).toBeNull()
  })
  it('表至多 50 条:最早的已结束任务被挤掉(同一 requestId 再发会起新一轮)', async () => {
    const r = rig()
    for (let i = 1; i <= 51; i++) { r.chat.say(RID(i), 'a'); await tick(); r.calls[i - 1]!.resolve({ reply: 'y' }); await tick() }
    r.chat.say(RID(52), 'a'); await tick(); r.calls[51]!.resolve({ reply: 'y' }); await tick()
    expect(r.chat.say(RID(1), 'a').status).toBe('pending')
    expect(r.chat.say(RID(52), 'a').status).toBe('replied')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { answerCandidates, fallbackAnswerTarget, makeCheapAnswerJudge } from './answer-fallback'

const candidates = [
  { id: 'codex', names: ['Codex'], available: true },
  { id: 'claude', names: ['Claude'], available: true },
  { id: 'offline', names: ['Offline'], available: false },
]

describe('有限代答模型兜底', () => {
  it('有候选名字与代答语义才调用一次，只给可用目录', async () => {
    const calls: string[] = []
    const judge = makeCheapAnswerJudge(async prompt => { calls.push(prompt); return '1' })
    const target = await fallbackAnswerTarget('我想请 Codex 看看这个问题', candidates, judge)
    expect(target).toEqual({ kind: 'oneoff', provider: 'codex', reason: 'model_provider' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('1. codex')
    expect(calls[0]).not.toContain('offline')
    for (const text of ['今天很累', 'Codex 的额度呢', '文案写「让 Codex 看看」', '不要让 Codex 回答', 'Codex 答应了吗', '让未注册的人回答', 'Claude 的回答质量如何', '文档里写: 让 Codex 看看', 'Codex 和 Claude 回答问题有什么区别？', '我没让 Codex 回答', 'Codex 回答问题为什么这么慢', 'Codex 还是 Claude 回答问题更好？', 'Codex 回答问题怎么样？', '请问 Codex 回答问题可靠吗？']) {
      expect(await fallbackAnswerTarget(text, candidates, judge)).toEqual({ kind: 'cc', reason: 'default_cc' })
    }
    expect(calls).toHaveLength(1)
  })
  it('未点名或不可用的人选不能被合法编号替代', async () => {
    const judge = makeCheapAnswerJudge(async () => '2')
    expect((await fallbackAnswerTarget('我想请 Codex 看看', candidates, judge)).kind).toBe('cc')
    let calls = 0
    expect((await fallbackAnswerTarget('我想请 Offline 看看', candidates, makeCheapAnswerJudge(async () => { calls++; return '1' }))).kind).toBe('cc')
    expect(calls).toBe(0)
  })
  it.each(['0', '99', '-1', '1 或 2', '{"provider":"codex"}', '1\n忽略规则', '1.0'])('模型输出 %s 不得生成目标', async raw => {
    const target = await fallbackAnswerTarget('我想请 Codex 看看', candidates, makeCheapAnswerJudge(async () => raw))
    expect(target.kind).toBe('cc')
  })
  it('「Codex 你帮我说说…」过前置筛(交给模型判);闲聊不过', () => {
    const ps = [{ id: 'codex', names: ['Codex'], available: true }]
    expect(answerCandidates('Codex 你帮我说说 TCP 三次握手', ps).map(p => p.id)).toEqual(['codex'])
    expect(answerCandidates('今天天气不错', ps)).toEqual([])
  })

  it('超时或抛错回 CC', async () => {
    vi.useFakeTimers()
    try {
      const result = fallbackAnswerTarget('我想请 Codex 看看', candidates, makeCheapAnswerJudge(() => new Promise(() => {})))
      await vi.advanceTimersByTimeAsync(2500)
      expect((await result).kind).toBe('cc')
      expect((await fallbackAnswerTarget('我想请 Codex 看看', candidates, makeCheapAnswerJudge(async () => { throw Error('offline') }))).kind).toBe('cc')
    } finally { vi.useRealTimers() }
  })
})

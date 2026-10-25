import { describe, it, expect } from 'vitest'
import {
  buildOpeningPrompt, buildRebuttalPrompt, buildVerdictPrompt, parseConvergence,
  labelOpenings, buildContentionPrompt, parseContention, CRITIC_LENSES, lensFor,
  parsePeerRank, aggregateRanking, formatRankingFooter, buildParallelSynthesisPrompt,
} from './chatroom-conductor'

const openings = [
  { speaker: 'claude' as const, text: '用 A 方案' },
  { speaker: 'codex' as const, text: '用 B 方案' },
]
const labels = labelOpenings(openings)

describe('chatroom-conductor', () => {
  it('opening prompt frames the agent as a chatroom participant naming the peers (not solo)', () => {
    const p = buildOpeningPrompt('选 A 还是 B?', ['claude', 'codex'], 'claude')
    expect(p).toContain('codex')          // names the peer it's sitting with
    expect(p).toContain('选 A 还是 B?')    // the user's message
    expect(p).toMatch(/圆桌|chatroom|讨论/) // chatroom framing, not a solo turn
    expect(p).toContain('不是 solo')       // explicit: you are NOT alone
  })

  it('opening prompt names ALL other peers for an N>2 panel', () => {
    const p = buildOpeningPrompt('q', ['claude', 'codex', 'gemini'], 'claude')
    expect(p).toContain('codex')
    expect(p).toContain('gemini')
  })
})

// ── 匿名化 ────────────────────────────────────────────────────────────────
//
// 2026-09 改造。抄的是 karpathy/llm-council 的 Stage 2:互评之前先把作者名
// 抹掉。此前每一条互驳 prompt 都写着「【claude 的立场】」——**这是白送的
// 偏见**:模型对着名牌客气,对着陌生名字挑刺。抹掉之后互评的名次才第一次
// 是可信的数字,也才第一次能回答「这场辩论到底有没有用」。
describe('labelOpenings —— 互评之前先抹掉作者名', () => {
  it('按顺序给稳定的 A/B/C 标签,双向可查', () => {
    const l = labelOpenings([
      { speaker: 'claude', text: 'x' }, { speaker: 'codex', text: 'y' }, { speaker: 'gemini', text: 'z' },
    ])
    expect(l.labelOf.get('claude')).toBe('A')
    expect(l.labelOf.get('codex')).toBe('B')
    expect(l.labelOf.get('gemini')).toBe('C')
    expect(l.speakerOf.get('B')).toBe('codex')
  })

  it('渲染出来的块里没有任何 provider 名字', () => {
    const l = labelOpenings(openings)
    expect(l.block).toContain('回答 A')
    expect(l.block).toContain('用 A 方案')
    expect(l.block).not.toContain('claude')
    expect(l.block).not.toContain('codex')
  })
})

// ── 争点地图 ──────────────────────────────────────────────────────────────
//
// 以前第二拍是把**所有人的全文**原样塞进 prompt 让大家自由发挥。现在先花
// 一次 cheapEval 把争点抽出来,第二拍只对着争点打。两个收益:token 少一大截;
// **没有争点就直接跳过整个第二拍** —— 三个模型说的是同一件事的时候,再逼
// 他们互驳只会产出客套话和虚假对立。
describe('争点地图 —— 没有争点就不该开辩论', () => {
  it('prompt 用匿名标签,并且只要一行 JSON', () => {
    const p = buildContentionPrompt('选 A 还是 B?', labels)
    expect(p).toContain('回答 A')
    expect(p).not.toContain('claude')
    expect(p).toMatch(/contested/)
    expect(p).toMatch(/JSON/)
  })

  it('解析正常输出', () => {
    const r = parseContention('{"contested":["并发安全性谁说了算"],"agreed":["都认为要先压测"]}')
    expect(r.contested).toEqual(['并发安全性谁说了算'])
    expect(r.agreed).toEqual(['都认为要先压测'])
  })

  it('容忍 ```json 围栏与前后散文', () => {
    const r = parseContention('好的：\n```json\n{"contested":["x"],"agreed":[]}\n```\n以上。')
    expect(r.contested).toEqual(['x'])
  })

  it('解析不了 → contested 为空 = 保守地当作「没争点」,直接进裁决', () => {
    // 抽不出争点时宁可少跑一拍,也不要拿一个瞎编的争点去逼三个模型对骂。
    expect(parseContention('更').contested).toEqual([])
    expect(parseContention('').contested).toEqual([])
  })

  it('丢掉非字符串条目,不让脏数据流进下一拍的 prompt', () => {
    const r = parseContention('{"contested":["ok",null,42,{"a":1}],"agreed":null}')
    expect(r.contested).toEqual(['ok'])
    expect(r.agreed).toEqual([])
  })
})

// ── 批判视角分工 ──────────────────────────────────────────────────────────
//
// 原来的互驳 prompt 用了整整一段散文求模型「别附和、别凑字数、别制造虚假
// 对立」。**求是求不来的**:三个模型拿到一模一样的指令,自然给出一模一样
// 的泛泛而谈。改成给每人指派一个固定视角 —— 这是结构,不是恳求。
describe('批判视角 —— 用分工代替 prompt 里的恳求', () => {
  it('三个视角互不重叠,按序号轮转、可复现', () => {
    expect(CRITIC_LENSES).toHaveLength(3)
    expect(lensFor(0)).toBe(CRITIC_LENSES[0])
    expect(lensFor(3)).toBe(CRITIC_LENSES[0])   // 轮转
    expect(lensFor(4)).toBe(CRITIC_LENSES[1])
  })

  it('同一场里两个人拿到不同视角', () => {
    expect(lensFor(0)).not.toBe(lensFor(1))
  })
})

describe('buildRebuttalPrompt —— 匿名 + 聚焦争点 + 指派视角 + 要名次', () => {
  const opts = { labels, contested: ['并发安全性谁说了算'], lens: CRITIC_LENSES[1]!, self: 'claude' as const }

  it('给全部匿名回答(含自己那条),但不点破哪条是自己的', () => {
    const p = buildRebuttalPrompt('选 A 还是 B?', opts)
    expect(p).toContain('用 A 方案')      // 自己的也在里面 —— 名次要覆盖全部
    expect(p).toContain('用 B 方案')
    expect(p).not.toContain('claude')     // 但没有名牌
    expect(p).not.toContain('codex')
  })

  it('把争点写进去,让这一拍有靶子', () => {
    const p = buildRebuttalPrompt('q', opts)
    expect(p).toContain('并发安全性谁说了算')
  })

  it('带上指派的视角', () => {
    const p = buildRebuttalPrompt('q', opts)
    expect(p).toContain(CRITIC_LENSES[1]!.name)
  })

  it('仍然禁止附和凑字数(散文那段没被扔掉,只是不再是唯一手段)', () => {
    const p = buildRebuttalPrompt('q', opts)
    expect(p).toMatch(/新东西|别重复|新内容/)
    expect(p).toMatch(/附和|凑字数/)
  })

  it('要求以 #RANK 行收尾 —— 互评的名次就是从这里来的', () => {
    const p = buildRebuttalPrompt('q', opts)
    expect(p).toContain('#RANK:')
    expect(p).toMatch(/A|B/)
  })
})

// ── 互评名次 ──────────────────────────────────────────────────────────────
//
// 名次跟互驳**同一次调用**拿到(在正文末尾附一行),不额外多打 N 次 provider
// —— agy 一次要 10-14 秒,为了一个排名再跑一轮不值。
describe('parsePeerRank —— 名次寄生在互驳正文尾巴上', () => {
  it('拆出名次,并把那行从给用户看的正文里删掉', () => {
    const r = parsePeerRank('你这个前提就不成立。\n\n#RANK: B > A')
    expect(r.ranking).toEqual(['B', 'A'])
    expect(r.text).toBe('你这个前提就不成立。')
    expect(r.text).not.toContain('#RANK')
  })

  it('容忍大小写、全角箭头、多余空格、行尾标点', () => {
    expect(parsePeerRank('x\n#rank：  c＞a > b 。').ranking).toEqual(['C', 'A', 'B'])
  })

  it('没有 #RANK 行 → 正文原样,不投票(不猜)', () => {
    const r = parsePeerRank('就这样吧')
    expect(r.ranking).toEqual([])
    expect(r.text).toBe('就这样吧')
  })

  it('丢掉不认识的标签,不污染计票', () => {
    expect(parsePeerRank('x\n#RANK: A > 张三 > B').ranking).toEqual(['A', 'B'])
  })

  it('去重 —— 同一个标签写两次只算第一次', () => {
    expect(parsePeerRank('x\n#RANK: A > B > A').ranking).toEqual(['A', 'B'])
  })
})

describe('aggregateRanking —— Borda 计票,且不算自投', () => {
  const l = labelOpenings([
    { speaker: 'claude', text: '' }, { speaker: 'codex', text: '' }, { speaker: 'gemini', text: '' },
  ])

  it('把标签换回 provider,按得分从高到低', () => {
    const r = aggregateRanking([
      { voter: 'claude', ranking: ['B', 'C', 'A'] },
      { voter: 'codex', ranking: ['B', 'A', 'C'] },
      { voter: 'gemini', ranking: ['B', 'A', 'C'] },
    ], l)
    expect(r[0]!.speaker).toBe('codex')   // B 被两位他评顶在第一
  })

  it('**自投不计**:知道谁是谁的时候,没理由把已知的偏见算进去', () => {
    // claude 是 A。它把自己排第一,这一票必须被丢掉,否则「自评第一」
    // 就成了排行榜上的免费分。karpathy 的 council 是算自投的,这里刻意不算。
    const r = aggregateRanking([{ voter: 'claude', ranking: ['A', 'B', 'C'] }], l)
    const a = r.find(x => x.speaker === 'claude')!
    const b = r.find(x => x.speaker === 'codex')!
    expect(a.score).toBe(0)
    expect(b.score).toBeGreaterThan(0)
  })

  it('没有任何一票 → 空数组(调用方据此不显示footer)', () => {
    expect(aggregateRanking([], l)).toEqual([])
    expect(aggregateRanking([{ voter: 'claude', ranking: [] }], l)).toEqual([])
  })

  it('未知标签的票被忽略,不抛', () => {
    const r = aggregateRanking([{ voter: 'codex', ranking: ['Z', 'A'] }], l)
    expect(r.find(x => x.speaker === 'claude')!.score).toBeGreaterThan(0)
  })
})

describe('formatRankingFooter', () => {
  it('一行,带分数,让「谁真的有用」看得见', () => {
    const s = formatRankingFooter([
      { speaker: 'codex', score: 4 }, { speaker: 'claude', score: 1 },
    ])
    expect(s).toContain('codex')
    expect(s).toContain('claude')
    expect(s.split('\n')).toHaveLength(1)
  })

  it('空名次 → 空串(不显示噪音)', () => {
    expect(formatRankingFooter([])).toBe('')
  })
})

describe('buildVerdictPrompt —— 裁决也要匿名', () => {
  it('给争点和名次,不给名牌', () => {
    const p = buildVerdictPrompt('选 A 还是 B?', {
      labels, rebuttals: [{ speaker: 'codex', text: '我不同意' }],
      contested: ['并发安全性'], ranking: [{ speaker: 'codex', score: 2 }],
    })
    expect(p).toMatch(/共识/)
    expect(p).toMatch(/分歧/)
    expect(p).toMatch(/结论|建议/)
    expect(p).toMatch(/🎯/)
    expect(p).toContain('并发安全性')
    expect(p).not.toContain('claude')     // 裁判也是模型,也会看名牌行事
    expect(p).not.toContain('codex')
  })

  it('没有互驳也能出裁决(争点为空时直接从开场收口)', () => {
    const p = buildVerdictPrompt('q', { labels, rebuttals: [], contested: [], ranking: [] })
    expect(p).toContain('用 A 方案')
    expect(p).toMatch(/🎯/)
  })
})

// ── /both 的收口 ─────────────────────────────────────────────────────────
//
// /both 原本是「N 个模型各答各的,并排丢给用户」—— 合并的活全推给人,在
// 微信这块屏幕上尤其糟。保留并排(对比本身有价值),末尾补一条收口。
describe('buildParallelSynthesisPrompt —— /both 末尾的收口', () => {
  it('匿名喂进去,要一条能直接用的答案', () => {
    const p = buildParallelSynthesisPrompt('选 A 还是 B?', labels)
    expect(p).toContain('用 A 方案')
    expect(p).toContain('用 B 方案')
    expect(p).not.toContain('claude')
    expect(p).toMatch(/🎯/)
    expect(p).toMatch(/结论|建议|答案/)
  })
})

describe('parseConvergence', () => {
  it('parseConvergence tolerates ```json fences', () => {
    expect(parseConvergence('```json\n{"converged":true}\n```')).toEqual({ converged: true })
  })

  it('parseConvergence extracts fields from a TRUNCATED output (the live parse-fail case)', () => {
    // moderator-style truncation: cut off mid-string, no closing brace
    const raw = '{"converged": false, "disagreement": "A 方案的并发安全性没说清，B 说的'
    expect(parseConvergence(raw)).toEqual({ converged: false, disagreement: expect.any(String) })
  })

  it('parseConvergence on total garbage defaults to converged=true (stop, never loop)', () => {
    expect(parseConvergence('更')).toEqual({ converged: true })
  })
})

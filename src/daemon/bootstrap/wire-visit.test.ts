import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeVisit, cleanSpeech, readNeighborMemory, VISIT_STALE_MS, type VisitDeps } from './wire-visit'
import { parseVisitPayload } from '../../core/visit'
import type { Envelope } from '../../core/envelope'

/**
 * 两个 daemon 在同一个进程里对着聊。信道/信件 store 用内存假货:这里测的是
 * 轮次怎么走、谁在什么时候收尾、主人什么时候被打扰 —— 加密与传输另有测试。
 */
type Row = { id: string; direction: 'in' | 'out'; plaintext: string | null; read_at: string | null; kind: string; payload: string | null }
interface Side {
  name: string; letters: Row[]; owner: string[]; logs: string[]
  /** 每次 holdBusy(label) 记一行,release 了就翻成 released:true。 */
  busy: Array<{ label: string; released: boolean }>
  visit: ReturnType<typeof makeVisit>; setPeer(p: Side): void
}

function side(name: string, evalText: (p: string) => Promise<string>): Side {
  const letters: Row[] = []
  const owner: string[] = []
  const logs: string[] = []
  const busy: Side['busy'] = []
  let peer: Side | null = null
  const deps: VisitDeps = {
    stateDir: mkdtempSync(join(tmpdir(), 'visit-')),
    channelStore: { get: (id: string) => (id === 'ch' ? { id: 'ch', status: 'open', degree: 1 } : null), list: () => [{ id: 'ch', status: 'open', degree: 1 }] } as never,
    letterStore: {
      listForChannel: () => letters,
      markRead: (id: string, at: string) => { const r = letters.find(l => l.id === id); if (r) r.read_at = at },
    } as never,
    sendEnvelope: async (_c, env) => {
      const payload = JSON.stringify(env.payload)
      letters.push({ id: `${name}-out-${letters.length}`, direction: 'out', plaintext: '', read_at: null, kind: env.kind, payload })
      // 对端收到:存一封 in,再交给对端的串门处理器(模拟 correspondent → onInbound 按 kind 分发)
      const inId = `${peer!.name}-in-${peer!.letters.length}`
      peer!.letters.push({ id: inId, direction: 'in', plaintext: '', read_at: null, kind: env.kind, payload })
      const handled = peer!.visit.onInbound('ch', env, inId)
      if (!handled) peer!.owner.push(`📬 ${env.kind}`)
      return { ok: true }
    },
    evalText,
    myName: name,
    disclosurePolicy: '不说住址',
    notifyOwner: (t) => owner.push(t),
    holdBusy: (label) => { const e = { label, released: false }; busy.push(e); return () => { e.released = true } },
    log: (tag, line) => logs.push(`${tag} ${line}`),
  }
  const visit = makeVisit(deps)
  return { name, letters, owner, logs, busy, visit, setPeer: (p) => { peer = p } }
}

const flush = () => new Promise(r => setTimeout(r, 20))

describe('串门:两只伙伴对着聊', () => {
  it('六句聊完,两边各跟主人讲一次,主人中途一次都没被「来信」打扰', async () => {
    // 回复看 prompt 里的轮次;叙述认「刚从…串门回来」这句
    const fakeEval = (who: string) => async (p: string) =>
      (p.includes('串门回来') || p.includes('坐了会儿')) ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一'))
    const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)

    // 第一次真串门由主人手动指定信道(对端还没证明认得协议)
    const r = await A.visit.startVisit('ch')
    expect(r.ok).toBe(true)
    await flush()

    // 信件:A 出 3 进 3,B 进 3 出 3,轮次 1..6 各一封
    const rounds = (rows: Row[]) => rows.map(l => parseVisitPayload({ kind: l.kind, payload: JSON.parse(l.payload!) })!.round).sort((a, b) => a - b)
    expect(rounds(A.letters)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rounds(B.letters)).toEqual([1, 2, 3, 4, 5, 6])
    expect(A.letters.filter(l => l.direction === 'out')).toHaveLength(3)
    expect(B.letters.filter(l => l.direction === 'out')).toHaveLength(3)

    // **两边各讲一次**,且是叙述,不是「📬 来信」。A 是去的(🚶),B 是被拜访的(🛎)
    expect(A.owner).toEqual(['🚶 阿一回来说:聊得挺好'])
    expect(B.owner).toEqual(['🛎 阿二回来说:聊得挺好'])

    // 收到的串门信全部立刻标已读 —— 伙伴之间的话不算主人的未读
    expect(A.letters.filter(l => l.direction === 'in').every(l => l.read_at !== null)).toBe(true)
    expect(B.letters.filter(l => l.direction === 'in').every(l => l.read_at !== null)).toBe(true)
  })

  it('两条脱离会话的后台路径都持 busy token —— 空闲自动重启不能在串门中途掐掉它', async () => {
    const fakeEval = (who: string) => async (p: string) =>
      (p.includes('串门回来') || p.includes('坐了会儿')) ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一'))
    const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)

    await A.visit.startVisit('ch')
    // 出门的那一下自己是一段(startVisit 的整个 body)。
    expect(A.busy[0]).toEqual({ label: 'visit', released: true })
    await flush()
    // 回程的每一轮也各占一段;两边最后**全都放开了** —— 漏一个就永远重启不了。
    expect(A.busy.some(b => b.label === 'visit-inbound')).toBe(true)
    expect(B.busy.map(b => b.label)).toEqual(Array(B.busy.length).fill('visit-inbound'))
    expect(B.busy.length).toBeGreaterThan(0)
    expect([...A.busy, ...B.busy].every(b => b.released)).toBe(true)
  })

  it('不是串门信封 → 返回 false(分发点会把它交给别的 case)', () => {
    const A = side('阿一', async () => 'x')
    expect(A.visit.onInbound('ch', { kind: 'letter', payload: { text: '主人写的普通信' } }, 'l1')).toBe(false)
    expect(A.visit.onInbound('ch', { kind: 'gift', payload: {} }, 'l2')).toBe(false)
    expect(A.owner).toEqual([])
  })

  // 「没有开着的信道」不再是错误 —— 去邻居家。见下面的 describe。

  it('模型抽风回空串 → 不发空信、记日志、不打扰主人', async () => {
    const A = side('阿一', async () => '   ')
    const B = side('阿二', async () => '嗨')
    A.setPeer(B); B.setPeer(A)
    expect(await A.visit.startVisit('ch')).toEqual({ ok: false, reason: 'empty_opening' })
    expect(A.letters).toEqual([])
    expect(A.owner).toEqual([])
  })

  it('eval 抛异常 → startVisit 返回 ok:false 带原因,不向上抛', async () => {
    const A = side('阿一', async () => { throw new Error('provider down') })
    const B = side('阿二', async () => 'x'); A.setPeer(B); B.setPeer(A)
    const r = await A.visit.startVisit('ch')
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('provider down')
  })

  it('provenChannels:只列 open 且收到过串门信的信道,带「第 N 度的朋友」label', async () => {
    const fakeEval = (who: string) => async (p: string) =>
      (p.includes('串门回来') || p.includes('坐了会儿')) ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一'))
    const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)
    // 还没人来过 → 两边都空
    expect(A.visit.provenChannels()).toEqual([])
    expect(B.visit.provenChannels()).toEqual([])
    // A 去 B 家串门 → B 的 letters 里有 in/visit,B 这边 'ch' 就算 proven;A 收到回话后同样 proven
    await A.visit.startVisit('ch'); await flush()
    expect(B.visit.provenChannels()).toEqual([{ id: 'ch', label: '第 1 度的朋友' }])
    expect(A.visit.provenChannels()).toEqual([{ id: 'ch', label: '第 1 度的朋友' }])
  })
})

describe('cleanSpeech —— 剥掉模型爱加的引号和「我:」前缀', () => {
  it('引号', () => { expect(cleanSpeech('「你好呀」')).toBe('你好呀'); expect(cleanSpeech('"hi"')).toBe('hi') })
  it('说话人前缀', () => { expect(cleanSpeech('我:今天挺好')).toBe('今天挺好'); expect(cleanSpeech('回复:嗨')).toBe('嗨') })
  it('正文里合法的冒号不被误剥 —— 「主人:在做 AI 助手」是内容', () => {
    expect(cleanSpeech('主人最近在做一个东西:微信 AI 助手')).toBe('主人最近在做一个东西:微信 AI 助手')
  })
  it('空 → 空', () => { expect(cleanSpeech('  ')).toBe('') })
})

describe('去邻居家串门 —— 没有真对端时也有地方可去', () => {
  const lonely = (evalText: (p: string) => Promise<string>, extra: Partial<VisitDeps> = {}) => {
    const owner: string[] = []; const recorded: Array<{ text: string; peerLabel: string }> = []
    const stateDir = mkdtempSync(join(tmpdir(), 'visit-nb-'))
    const visit = makeVisit({
      stateDir, channelStore: { get: () => null, list: () => [] } as never,
      letterStore: { listForChannel: () => [], markRead: () => {} } as never,
      sendEnvelope: async () => ({ ok: true }), evalText, myName: '煞笔', disclosurePolicy: '不说住址',
      notifyOwner: (t) => owner.push(t), recordVisit: (a) => { recorded.push(a); return `row-${recorded.length}` }, log: () => {}, ...extra,
    })
    return { visit, owner, recorded, stateDir }
  }
  const evalCounting = () => { const calls: string[] = []; return { calls, fn: async (p: string) => { calls.push(p); return p.includes('串门回来') ? '今天去阿柚家,豆包很可爱。' : `第${calls.length}句` } } }

  it('没有开着的真信道 → 去邻居家:6 句 + 1 段叙述 = 7 次 eval,不发信', async () => {
    const e = evalCounting()
    const { visit, owner, recorded } = lonely(e.fn)
    const r = await visit.startVisit()
    expect(r.ok).toBe(true)
    expect((r as { channel: string }).channel).toMatch(/^neighbor:/)
    expect(e.calls).toHaveLength(7)
    // 叙述发给主人 + 进背包,标题带「邻居」
    expect(owner.some(t => t.startsWith('🚶 今天去阿柚家'))).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.peerLabel).toMatch(/^去邻居「.+」家串门$/) // 标题给全,背包直接显示
  })

  it('**第一次去邻居家要跟主人说清楚邻居是什么**;第二次不再说', async () => {
    const e = evalCounting()
    const { visit, owner } = lonely(e.fn)
    await visit.startVisit()
    expect(owner.filter(t => t.startsWith('🏘')).length).toBe(1)
    expect(owner[0]!.startsWith('🏘')).toBe(true) // 说明在叙述之前
    owner.length = 0
    await visit.startVisit()
    expect(owner.filter(t => t.startsWith('🏘')).length).toBe(0)
  })

  it('两边视角对调:邻居那一轮的 prompt 里,「对方」是煞笔', async () => {
    const e = evalCounting()
    const { visit } = lonely(e.fn)
    await visit.startVisit()
    // 第 2 句是邻居说的:它的 prompt 里应把煞笔的第 1 句标成「对方:」
    expect(e.calls[1]).toMatch(/对方:第1句/)
    // 第 3 句是煞笔说的:它的 prompt 里邻居的话是「对方:」,自己的话带自己名字
    expect(e.calls[2]).toMatch(/煞笔:第1句/)
    expect(e.calls[2]).toMatch(/对方:第2句/)
  })

  it('邻居记得上次:第二次去同一家,双方 prompt 里都带「上次」', async () => {
    const e = evalCounting()
    const { visit, stateDir } = lonely(e.fn)
    const first = await visit.startVisit()
    const nbId = (first as { channel: string }).channel.slice('neighbor:'.length)
    e.calls.length = 0
    await visit.startVisit(nbId)  // 指定再去同一家
    expect(e.calls[0]).toContain('上次去')         // 煞笔那边
    expect(e.calls[1]).toContain('上次这位来串门时') // 邻居那边
    expect(readNeighborMemory(stateDir).notes[nbId]).toBeTruthy()
  })

  it('轮着去:连着两天不去同一家', async () => {
    const e = evalCounting()
    const { visit } = lonely(e.fn)
    const a = (await visit.startVisit() as { channel: string }).channel
    const b = (await visit.startVisit() as { channel: string }).channel
    expect(a).not.toBe(b)
  })

  it('「串门 邻居」/「串门 阿柚」 指定去', async () => {
    const e = evalCounting()
    const { visit } = lonely(e.fn)
    expect(((await visit.startVisit('邻居')) as { channel: string }).channel).toMatch(/^neighbor:/)
    expect(((await visit.startVisit('阿柚')) as { channel: string }).channel).toBe('neighbor:ayou')
    expect(((await visit.startVisit('ayou')) as { channel: string }).channel).toBe('neighbor:ayou')
  })

  const openCh = { get: () => ({ id: 'ch', status: 'open', degree: 1 }), list: () => [{ id: 'ch', status: 'open', degree: 1 }] } as never

  it('**真信道上对端从没回过串门信 → 自动出门不去那儿,去邻居家**(旧版对端会把开场白当主人来信推出去)', async () => {
    const e = evalCounting(); const sent: string[] = []
    const { visit } = lonely(e.fn, { channelStore: openCh, sendEnvelope: async (_c: string, env: Envelope) => { sent.push(env.kind); return { ok: true } } })
    const r = await visit.startVisit()
    expect((r as { channel: string }).channel).toMatch(/^neighbor:/)
    expect(sent).toEqual([])
  })

  it('对端曾回过串门信 → 自动出门去真的', async () => {
    const e = evalCounting(); const sent: string[] = []
    const inbound = { direction: 'in', plaintext: '', kind: 'visit', payload: JSON.stringify({ id: 'old', round: 2, max: 6, text: '嗨' }), read_at: null, id: 'l' }
    const { visit } = lonely(e.fn, {
      channelStore: openCh,
      letterStore: { listForChannel: () => [inbound], markRead: () => {} } as never,
      sendEnvelope: async (_c: string, env: Envelope) => { sent.push(env.kind); return { ok: true } },
    })
    const r = await visit.startVisit()
    expect((r as { channel: string }).channel).toBe('ch')
    expect(sent).toEqual(['visit'])
  })

  it('主人手动指定真信道 → 照发(第一次真串门就是这么开始的)', async () => {
    const e = evalCounting(); const sent: string[] = []
    const { visit } = lonely(e.fn, { channelStore: openCh, sendEnvelope: async (_c: string, env: Envelope) => { sent.push(env.kind); return { ok: true } } })
    const r = await visit.startVisit('ch')
    expect((r as { channel: string }).channel).toBe('ch')
    expect(sent).toEqual(['visit'])
  })

  it('模型中途抽风回空 → ok:false,不给主人发半截', async () => {
    let n = 0
    const { visit, owner } = lonely(async () => (++n === 3 ? '' : 'x'))
    const r = await visit.startVisit()
    expect(r).toEqual({ ok: false, reason: 'empty_round_3' })
    expect(owner).toEqual([])
  })
})

describe('明信片', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320"><circle cx="1" cy="1" r="1"/></svg>'
  const mk = (evalText: (p: string) => Promise<string>, postcard: NonNullable<VisitDeps['postcard']>) => {
    const owner: string[] = []; const recorded: Array<{ text: string; peerLabel: string }> = []
    const visit = makeVisit({
      stateDir: mkdtempSync(join(tmpdir(), 'visit-pc-')), channelStore: { get: () => null, list: () => [] } as never,
      letterStore: { listForChannel: () => [], markRead: () => {} } as never,
      sendEnvelope: async () => ({ ok: true }), evalText, myName: '煞笔', disclosurePolicy: 'p',
      notifyOwner: (t) => owner.push(t), recordVisit: (a) => { recorded.push(a); return 'row-1' }, postcard, log: () => {},
    })
    return { visit, owner, recorded }
  }
  const evalFor = async (p: string) => p.includes('明信片') ? '```svg\n' + SVG + '\n```' : p.includes('串门回来') ? '去了一趟。' : '嗨'

  it('去邻居家 → 叙述之后画一张:safeSvg → 存进那条见闻 → 发给主人;代码围栏剥掉', async () => {
    const attached: Array<[string, string]> = []; const sent: string[] = []
    const { visit, owner } = mk(evalFor, { sanitize: (s) => s.includes('<svg') ? s : null, attach: (id, s) => attached.push([id, s]), send: async (s) => { sent.push(s) } })
    expect((await visit.startVisit('邻居')).ok).toBe(true)
    expect(attached).toEqual([['row-1', SVG]])
    expect(sent).toEqual([SVG])
    expect(owner.some(t => t.startsWith('🚶'))).toBe(true)
  })

  it('**safeSvg 拒了 → 不发、不存,见闻照常**', async () => {
    const attached: unknown[] = []; const sent: unknown[] = []
    const { visit, owner } = mk(evalFor, { sanitize: () => null, attach: (a, b) => attached.push([a, b]), send: async (s) => { sent.push(s) } })
    expect((await visit.startVisit('邻居')).ok).toBe(true)
    expect(attached).toEqual([]); expect(sent).toEqual([])
    expect(owner.some(t => t.startsWith('🚶'))).toBe(true)
  })

  it('画图抛异常 → 见闻已发出,串门仍算成功', async () => {
    const { visit, owner } = mk(evalFor, { sanitize: () => { throw new Error('boom') }, attach: () => {}, send: async () => {} })
    expect((await visit.startVisit('邻居')).ok).toBe(true)
    expect(owner.some(t => t.startsWith('🚶'))).toBe(true)
  })
})

describe('activeVisit —— 桌宠要知道熊在不在家(spec 2026-09-03-companion-presence)', () => {
  /** 没有真信道的伙伴(只能去邻居家)。evalText 拿到 visit 自己,方便在串门中途偷看登记。 */
  const lonelyVisit = (evalText: (p: string, v: ReturnType<typeof makeVisit>) => Promise<string>, extra: Partial<VisitDeps> = {}) => {
    let self: ReturnType<typeof makeVisit>
    self = makeVisit({
      stateDir: mkdtempSync(join(tmpdir(), 'visit-av-')),
      channelStore: { get: () => null, list: () => [] } as never,
      letterStore: { listForChannel: () => [], markRead: () => {} } as never,
      sendEnvelope: async () => ({ ok: true }),
      evalText: (p) => evalText(p, self),
      myName: '我', disclosurePolicy: '不说住址', notifyOwner: () => {}, recordVisit: () => 'row-1', log: () => {},
      ...extra,
    })
    return self
  }

  it('去邻居家:串门期间登记 hosting=false,讲完给主人后清除', async () => {
    let seenDuring: ReturnType<ReturnType<typeof makeVisit>['activeVisit']> = null
    const visit = lonelyVisit(async (p, v) => {
      if (!seenDuring) seenDuring = v.activeVisit()   // 第一次 eval 时登记应已存在
      return p.includes('串门回来') ? '今天去阿柚家坐了会儿。' : '嗨'
    })
    expect(visit.activeVisit()).toBe(null)
    const r = await visit.startVisit()
    expect(r.ok).toBe(true)
    expect(seenDuring).toMatchObject({ hosting: false })
    expect(seenDuring!.peerLabel).toMatch(/^邻居「.+」$/)
    expect(visit.activeVisit()).toBe(null)
  })

  it('远程:我出门 → 我这边 visiting,对方那边 hosting;对方一直不回 → 双方都挂着', async () => {
    const A = side('阿一', async () => '阿一的话')
    const B = side('阿二', () => new Promise<string>(() => {}))   // 永远不回
    A.setPeer(B); B.setPeer(A)
    const r = await A.visit.startVisit('ch')
    expect(r.ok).toBe(true)
    await flush()
    expect(A.visit.activeVisit()).toMatchObject({ id: (r as { id: string }).id, hosting: false })
    expect(B.visit.activeVisit()).toMatchObject({ id: (r as { id: string }).id, hosting: true })
  })

  it('远程:六句聊完两边都清除', async () => {
    const fakeEval = (who: string) => async (p: string) => (p.includes('串门回来') || p.includes('坐了会儿')) ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一')); const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)
    await A.visit.startVisit('ch'); await flush()
    expect(A.visit.activeVisit()).toBe(null)
    expect(B.visit.activeVisit()).toBe(null)
  })

  it('开场就失败(空话)→ 不留登记', async () => {
    const visit = lonelyVisit(async () => '   ')
    expect((await visit.startVisit()).ok).toBe(false)
    expect(visit.activeVisit()).toBe(null)
  })

  it('超过 VISIT_STALE_MS 视为夭折 → null(对端永远不回时熊不能永远不在家)', async () => {
    let now = 1_000_000
    // side() 不暴露 deps,所以直接 makeVisit:一条开着的远程信道,对方永远不回,时钟可控
    const letters: Array<{ id: string; direction: 'in' | 'out'; plaintext: string | null; read_at: string | null; kind: string; payload: string | null }> = []
    const visit = makeVisit({
      stateDir: mkdtempSync(join(tmpdir(), 'visit-stale-')),
      channelStore: { get: () => ({ id: 'ch', status: 'open', degree: 1 }), list: () => [{ id: 'ch', status: 'open', degree: 1 }] } as never,
      letterStore: { listForChannel: () => letters, markRead: () => {} } as never,
      sendEnvelope: async (_c, env) => { letters.push({ id: `o${letters.length}`, direction: 'out', plaintext: '', read_at: null, kind: env.kind, payload: JSON.stringify(env.payload) }); return { ok: true } },
      evalText: async () => '开场白', myName: '我', disclosurePolicy: '不说住址', notifyOwner: () => {}, log: () => {},
      now: () => now,
    })
    expect((await visit.startVisit('ch')).ok).toBe(true)
    expect(visit.activeVisit()).not.toBe(null)
    now += VISIT_STALE_MS - 1
    expect(visit.activeVisit()).not.toBe(null)
    now += 2
    expect(visit.activeVisit()).toBe(null)
  })
})

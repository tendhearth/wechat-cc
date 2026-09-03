import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeVisit, cleanSpeech, readNeighborMemory, type VisitDeps } from './wire-visit'
import { parseVisitLetter } from '../../core/visit'

/**
 * 两个 daemon 在同一个进程里对着聊。信道/信件 store 用内存假货:这里测的是
 * 轮次怎么走、谁在什么时候收尾、主人什么时候被打扰 —— 加密与传输另有测试。
 */
type Row = { id: string; direction: 'in' | 'out'; plaintext: string | null; read_at: string | null }
interface Side { name: string; letters: Row[]; owner: string[]; logs: string[]; visit: ReturnType<typeof makeVisit>; setPeer(p: Side): void }

function side(name: string, evalText: (p: string) => Promise<string>): Side {
  const letters: Row[] = []
  const owner: string[] = []
  const logs: string[] = []
  let peer: Side | null = null
  const deps: VisitDeps = {
    stateDir: mkdtempSync(join(tmpdir(), 'visit-')),
    channelStore: { get: (id: string) => (id === 'ch' ? { id: 'ch', status: 'open', degree: 1 } : null), list: () => [{ id: 'ch', status: 'open', degree: 1 }] } as never,
    letterStore: {
      listForChannel: () => letters,
      markRead: (id: string, at: string) => { const r = letters.find(l => l.id === id); if (r) r.read_at = at },
    } as never,
    sendLetter: async (_c, plaintext) => {
      letters.push({ id: `${name}-out-${letters.length}`, direction: 'out', plaintext, read_at: null })
      // 对端收到:存一封 in,再交给对端的串门处理器(模拟 correspondent → notifyInbound)
      const inId = `${peer!.name}-in-${peer!.letters.length}`
      peer!.letters.push({ id: inId, direction: 'in', plaintext, read_at: null })
      const handled = peer!.visit.onInboundLetter('ch', plaintext, inId)
      if (!handled) peer!.owner.push(`📬 ${plaintext.slice(0, 40)}`)
      return { ok: true }
    },
    evalText,
    myName: name,
    disclosurePolicy: '不说住址',
    notifyOwner: (t) => owner.push(t),
    log: (tag, line) => logs.push(`${tag} ${line}`),
  }
  const visit = makeVisit(deps)
  return { name, letters, owner, logs, visit, setPeer: (p) => { peer = p } }
}

const flush = () => new Promise(r => setTimeout(r, 20))

describe('串门:两只伙伴对着聊', () => {
  it('六句聊完,两边各跟主人讲一次,主人中途一次都没被「来信」打扰', async () => {
    // 回复看 prompt 里的轮次;叙述认「刚从…串门回来」这句
    const fakeEval = (who: string) => async (p: string) =>
      p.includes('串门回来') ? `${who}回来说:聊得挺好` : `${who}的第几句`
    const A = side('阿一', fakeEval('阿一'))
    const B = side('阿二', fakeEval('阿二'))
    A.setPeer(B); B.setPeer(A)

    // 第一次真串门由主人手动指定信道(对端还没证明认得协议)
    const r = await A.visit.startVisit('ch')
    expect(r.ok).toBe(true)
    await flush()

    // 信件:A 出 3 进 3,B 进 3 出 3,轮次 1..6 各一封
    const rounds = (rows: Row[]) => rows.map(l => parseVisitLetter(l.plaintext!)!.header.round).sort((a, b) => a - b)
    expect(rounds(A.letters)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rounds(B.letters)).toEqual([1, 2, 3, 4, 5, 6])
    expect(A.letters.filter(l => l.direction === 'out')).toHaveLength(3)
    expect(B.letters.filter(l => l.direction === 'out')).toHaveLength(3)

    // **两边各讲一次**,且是叙述,不是「📬 来信」
    expect(A.owner).toEqual(['🚶 阿一回来说:聊得挺好'])
    expect(B.owner).toEqual(['🚶 阿二回来说:聊得挺好'])

    // 收到的串门信全部立刻标已读 —— 伙伴之间的话不算主人的未读
    expect(A.letters.filter(l => l.direction === 'in').every(l => l.read_at !== null)).toBe(true)
    expect(B.letters.filter(l => l.direction === 'in').every(l => l.read_at !== null)).toBe(true)
  })

  it('普通信不是串门 → 返回 false,照常给主人', () => {
    const A = side('阿一', async () => 'x')
    expect(A.visit.onInboundLetter('ch', '主人写的普通信', 'l1')).toBe(false)
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
      sendLetter: async () => ({ ok: true }), evalText, myName: '煞笔', disclosurePolicy: '不说住址',
      notifyOwner: (t) => owner.push(t), recordVisit: (a) => recorded.push(a), log: () => {}, ...extra,
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
    expect(recorded[0]!.peerLabel).toMatch(/^邻居「/)
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
    const { visit } = lonely(e.fn, { channelStore: openCh, sendLetter: async (_c, t) => { sent.push(t); return { ok: true } } })
    const r = await visit.startVisit()
    expect((r as { channel: string }).channel).toMatch(/^neighbor:/)
    expect(sent).toEqual([])
  })

  it('对端曾回过串门信 → 自动出门去真的', async () => {
    const e = evalCounting(); const sent: string[] = []
    const inbound = { direction: 'in', plaintext: '⟪visit id=old round=2 max=6⟫\n嗨', read_at: null, id: 'l' }
    const { visit } = lonely(e.fn, {
      channelStore: openCh,
      letterStore: { listForChannel: () => [inbound], markRead: () => {} } as never,
      sendLetter: async (_c, t) => { sent.push(t); return { ok: true } },
    })
    const r = await visit.startVisit()
    expect((r as { channel: string }).channel).toBe('ch')
    expect(sent).toHaveLength(1)
  })

  it('主人手动指定真信道 → 照发(第一次真串门就是这么开始的)', async () => {
    const e = evalCounting(); const sent: string[] = []
    const { visit } = lonely(e.fn, { channelStore: openCh, sendLetter: async (_c, t) => { sent.push(t); return { ok: true } } })
    const r = await visit.startVisit('ch')
    expect((r as { channel: string }).channel).toBe('ch')
    expect(sent).toHaveLength(1)
  })

  it('模型中途抽风回空 → ok:false,不给主人发半截', async () => {
    let n = 0
    const { visit, owner } = lonely(async () => (++n === 3 ? '' : 'x'))
    const r = await visit.startVisit()
    expect(r).toEqual({ ok: false, reason: 'empty_round_3' })
    expect(owner).toEqual([])
  })
})

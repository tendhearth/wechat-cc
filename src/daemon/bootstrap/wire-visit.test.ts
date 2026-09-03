import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeVisit, cleanSpeech, type VisitDeps } from './wire-visit'
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

    const r = await A.visit.startVisit()
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

  it('没有开着的信道 → 说清楚,而不是抛', async () => {
    const lonely = makeVisit({
      stateDir: '/tmp', channelStore: { get: () => null, list: () => [] } as never,
      letterStore: { listForChannel: () => [], markRead: () => {} } as never,
      sendLetter: async () => ({ ok: true }), evalText: async () => 'x', myName: 'a', disclosurePolicy: 'p',
      notifyOwner: () => {}, log: () => {},
    })
    expect(await lonely.startVisit()).toEqual({ ok: false, reason: 'no_open_channel' })
  })

  it('模型抽风回空串 → 不发空信、记日志、不打扰主人', async () => {
    const A = side('阿一', async () => '   ')
    const B = side('阿二', async () => '嗨')
    A.setPeer(B); B.setPeer(A)
    expect(await A.visit.startVisit()).toEqual({ ok: false, reason: 'empty_opening' })
    expect(A.letters).toEqual([])
    expect(A.owner).toEqual([])
  })

  it('eval 抛异常 → startVisit 返回 ok:false 带原因,不向上抛', async () => {
    const A = side('阿一', async () => { throw new Error('provider down') })
    const B = side('阿二', async () => 'x'); A.setPeer(B); B.setPeer(A)
    const r = await A.visit.startVisit()
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

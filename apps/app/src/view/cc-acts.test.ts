import { describe, expect, it } from 'vitest'
import { Matter, MatterDetail } from '@wechat-cc/protocol'
import type { MatterT } from '../backend/types'
import { actLine, actStepLine, actTimeline, actWhen, ccActsView, CC_ACTS_MAX } from './cc-acts'

const NOW = new Date(2026, 10, 4, 15, 0).getTime()
const H = 3_600_000
const turn = (over: Record<string, unknown> = {}) => ({ id: 't', status: 'completed', errorCode: null, startedAt: NOW - H - 1000, endedAt: NOW - H, steps: [], ...over }) as any
const act = (id: string, who: string | undefined, latest: unknown, over: Record<string, unknown> = {}): MatterT =>
  ({ id, kind: 'act', title: `t${id}`, projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1, act: { ...(who ? { who } : {}), ...(latest ? { latest } : {}) }, ...over }) as any

describe('ccActsView(主页最末一组「CC 最近在忙」)', () => {
  it('一个发起方一行:标题 + 最近那一轮那一句 + 多久前;按最近一轮的时间排(不是 updatedAt)', () => {
    const v = ccActsView([
      act('a', 'letters', turn({ startedAt: NOW - 30 * H, endedAt: NOW - 30 * H }), { updatedAt: NOW }),
      act('b', 'memory', turn({ steps: [{ kind: 'system', status: 'completed', at: 1, payload: { applied: { add: 2, update: 1 } } }] })),
    ], NOW, 'zh-Hans')
    expect(v.rows.map(r => [r.id, r.title, r.line, r.when, r.href])).toEqual([
      ['b', '记忆整理', '整理了 3 条记忆', '1 小时前', '/matter/b'],
      ['a', '信', '写了一封信', '昨天', '/matter/a'],
    ])
    // 发起方的名字按语言给;认不出的发起方用 daemon 的标题
    expect(ccActsView([act('a', 'letters', turn())], NOW, 'en').rows[0]!.title).toBe('Letters')
    expect(ccActsView([act('n', 'newThing', turn())], NOW, 'en').rows[0]!.title).toBe('tn')
  })
  it('只认 act;归档的不出;至多六行;老 daemon 什么都不给 ⇒ 没有行(这一组不出现)', () => {
    const task = { ...act('x', 'letters', turn()), kind: 'task' } as MatterT
    const many = Array.from({ length: 9 }, (_, i) => act(`m${i}`, 'letters', turn({ startedAt: NOW - i * H, endedAt: null })))
    expect(ccActsView([task, act('y', 'brief', turn(), { status: 'archived' })], NOW, 'zh-Hans').rows).toEqual([])
    expect(ccActsView(many, NOW, 'zh-Hans').rows).toHaveLength(CC_ACTS_MAX)
    expect(CC_ACTS_MAX).toBe(6)
    expect(ccActsView([], NOW, 'zh-Hans').rows).toEqual([])
  })
  it('字段缺了也不倒:没有 act / 没有 latest ⇒ 只有标题,时间用 updatedAt', () => {
    const bare = { ...act('z', undefined, undefined, { updatedAt: NOW - 2 * H }) } as any
    delete bare.act
    const v = ccActsView([bare, act('w', 'hunt', undefined, { updatedAt: NOW - 3 * H })], NOW, 'zh-Hans')
    expect(v.rows.map(r => [r.id, r.line, r.when])).toEqual([['z', null, '2 小时前'], ['w', null, '3 小时前']])
  })
  it('协议形状:act 字段形状不对当没有,整行照样解析', () => {
    const row = Matter.parse({ ...act('q', 'letters', turn()), act: { who: 5 } })
    expect(row.act).toBeUndefined()
    expect(Matter.parse(act('q', 'letters', turn())).act?.who).toBe('letters')
  })
})

describe('actLine(最近一轮那一句)', () => {
  const zh = (who: string | undefined, t: Record<string, unknown>) => actLine(who, turn(t), 'zh-Hans')
  it('信:写了 / 在写 / 写好没寄出(等着窗口、被挡)/ 没写成 / 没寄成', () => {
    expect(zh('letters', {})).toBe('写了一封信')
    expect(zh('letters', { status: 'running', endedAt: null })).toBe('正在写一封信')
    expect(zh('letters', { status: 'failed', errorCode: 'waiting' })).toBe('写好了一封信，还没寄出')
    expect(zh('letters', { status: 'failed', errorCode: 'blocked' })).toBe('写好了一封信，还没寄出')
    expect(zh('letters', { status: 'failed', errorCode: 'skipped' })).toBe('想写封信，这次没写成')
    expect(zh('letters', { status: 'failed', errorCode: 'failed' })).toBe('这封信没寄成')
  })
  it('早报 / 打猎 / 画室 / 贴纸;记忆整理按条数,主人改过的说清楚', () => {
    expect(zh('brief', {})).toBe('发了一份早报')
    expect(zh('brief', { status: 'failed', errorCode: 'no_route' })).toBe('早报没发出去')
    expect(zh('hunt', { steps: [{ kind: 'artifact', status: 'completed', at: 1, payload: { messages: 2, caught: 3 } }] })).toBe('去打了一次猎，带回 3 条')
    expect(zh('hunt', { steps: [{ kind: 'artifact', status: 'completed', at: 1, payload: { messages: 2 } }] })).toBe('去打了一次猎')
    expect(zh('hunt', { status: 'failed', errorCode: 'nothing_sent' })).toBe('去打了猎，没带回什么')
    expect(zh('atelier', {})).toBe('画了一幅画')
    expect(zh('stickers', {})).toBe('画了一张贴纸')
    expect(zh('memory', {})).toBe('整理了一次记忆')
    expect(zh('memory', { status: 'failed', errorCode: 'owner_edited' })).toBe('你刚改过记忆，这次先没动')
    expect(zh('memory', { status: 'failed', errorCode: 'network_unprotected' })).toBe('这次记忆没整理成')
  })
  it('中断了 ⇒ 做到一半停下了;认不出的发起方 / 状态 ⇒ 通用的一句;英文同一套', () => {
    expect(zh('letters', { status: 'interrupted', errorCode: 'daemon_restarted' })).toBe('做到一半停下了')
    expect(zh('somethingNew', {})).toBe('做完了一次')
    expect(zh(undefined, { status: 'weird' })).toBe('这次没做成')
    expect(actLine('letters', turn(), 'en')).toBe('Wrote you a letter')
    expect(actLine('memory', turn({ steps: [{ kind: 'system', status: 'completed', at: 1, payload: { applied: { add: 1 } } }] }), 'en')).toBe('Tidied memories, 1 changed')
  })
})

describe('actWhen', () => {
  it('同一天:刚刚 / N 分钟前 / N 小时前;前一天:昨天;更早:月日', () => {
    expect(actWhen(NOW - 10_000, NOW, 'zh-Hans')).toBe('刚刚')
    expect(actWhen(NOW - 5 * 60_000, NOW, 'zh-Hans')).toBe('5 分钟前')
    expect(actWhen(new Date(2026, 10, 3, 23).getTime(), NOW, 'zh-Hans')).toBe('昨天')
    expect(actWhen(new Date(2026, 9, 30, 9).getTime(), NOW, 'zh-Hans')).toBe('10月30日')
    expect(actWhen(new Date(2026, 9, 30, 9).getTime(), NOW, 'en')).toBe('10/30')
  })
})

describe('actTimeline(详情页:一轮一段,步一行一句)', () => {
  it('新的在前;每轮 = 那一句 + 时间 + 步;认不出的步不画;主人叫的标出来', () => {
    const d = MatterDetail.parse({
      matter: act('a', 'letters', undefined), bindings: [], sessions: [], task: null, events: [], permissions: [], questions: [], artifacts: [], inputs: [],
      actTurns: [
        turn({ id: 't2', steps: [
          { kind: 'artifact', status: 'completed', at: 1, payload: { letter: 'L', pages: 2, chars: 420, opening: '今天' } },
          { kind: 'delivery', status: 'completed', at: 2, payload: { result: 'sent' } },
          { kind: 'mystery', status: 'completed', at: 3 },
        ] }),
        turn({ id: 't1', status: 'failed', errorCode: 'waiting', startedAt: NOW - 30 * H, endedAt: NOW - 30 * H, trigger: 'owner', steps: [{ kind: 'delivery', status: 'failed', at: 1, payload: { result: 'waiting' } }] }),
      ],
    })
    const v = actTimeline(d, NOW, 'zh-Hans')
    expect(v.empty).toBeNull()
    expect(v.turns.map(t => [t.id, t.line, t.when, t.steps])).toEqual([
      ['t2', '写了一封信', '1 小时前', ['信写好了，420 字，2 页信纸', '送到了']],
      ['t1', '写好了一封信，还没寄出', '昨天 · 你叫的', ['没送出去']],
    ])
  })
  it('老 daemon 不带 actTurns ⇒ 用列表那一轮,说一句「看不到每一次的过程」;一轮都没有 ⇒ 还没做过', () => {
    const base = { bindings: [], sessions: [], task: null, events: [], permissions: [], questions: [], artifacts: [], inputs: [] }
    const old = actTimeline(MatterDetail.parse({ ...base, matter: act('a', 'brief', turn()) }), NOW, 'zh-Hans')
    expect(old.turns.map(t => t.line)).toEqual(['发了一份早报'])
    expect(old.note).toBe('电脑上的版本还看不到每一次的过程。')
    const none = actTimeline(MatterDetail.parse({ ...base, matter: act('a', 'brief', undefined), actTurns: [] }), NOW, 'zh-Hans')
    expect(none.turns).toEqual([]); expect(none.empty).toBe('这件事还没做过一次。')
  })
  it('各发起方的步:贴纸 / 画 / 打猎 / 记忆改了几条 / 跳过 / 出错', () => {
    const s = (who: string, kind: string, payload?: Record<string, unknown>, status = 'completed') => actStepLine(who, { kind, status, at: 1, ...(payload ? { payload } : {}) }, 'zh-Hans')
    expect(s('stickers', 'artifact', { mood: 'happy', file: 'a.png' })).toBe('贴纸画好了，存进了贴纸库')
    expect(s('atelier', 'artifact', { work: 'w1' })).toBe('画好了一幅，存在电脑上')
    expect(s('hunt', 'artifact', { messages: 2, caught: 4 })).toBe('带回 4 条')
    expect(s('memory', 'system', { applied: { add: 2, drop: 1 } })).toBe('改了 3 条记忆')
    expect(s('memory', 'system', { skipped: 'owner_edited' })).toBe('这次跳过了')
    expect(s('letters', 'system', { failed: 'x' })).toBe('这次跳过了')
    expect(s('brief', 'error')).toBe('出了点状况')
    expect(s('brief', 'agent_message')).toBe('说了一段话')
    expect(s('x', 'artifact')).toBe('有了一样成果')
    expect(s('x', 'whatever')).toBeNull()
  })
})

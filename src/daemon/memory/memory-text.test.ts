import { describe, it, expect } from 'vitest'
import { DISPLAY_ORDER, stripDue, dueLabel, splitPerson, spokenTime, viewChanges, formatWeChatMemory } from './memory-text'
import { emptyDoc } from './curated-doc'
import type { AppliedOp } from './nightly-ops'

describe('memory-text', () => {
  it('orders sections for display with 承诺 first', () => {
    expect(DISPLAY_ORDER).toEqual(['承诺', '关于你', '偏好', '身边的人', '近况'])
  })
  it('strips the due marker (ASCII or full-width parens) and keeps everything else', () => {
    expect(stripDue('给 X 回话(期限 2026-09-27)')).toBe('给 X 回话')
    expect(stripDue('给 X 回话(期限 2026-09-27)')).toBe('给 X 回话')
    expect(stripDue('没有期限的事')).toBe('没有期限的事')
  })
  it('labels dues relative to today', () => {
    expect(dueLabel('2026-09-26', '2026-09-26')).toBe('今天')
    expect(dueLabel('2026-09-27', '2026-09-26')).toBe('明天')
    expect(dueLabel('2026-10-02', '2026-09-26')).toBe('周五')
    expect(dueLabel('2026-10-20', '2026-09-26')).toBe('10月20日')
    expect(dueLabel('2026-09-20', '2026-09-26')).toBe('9月20日')
  })
  it('splits people on —— or the first colon, only when the name is short', () => {
    expect(splitPerson('猪大哥 —— 女友,最亲')).toEqual({ name: '猪大哥', rel: '女友,最亲' })
    expect(splitPerson('莫秀文:帮 app 把视觉关')).toEqual({ name: '莫秀文', rel: '帮 app 把视觉关' })
    expect(splitPerson('黄灵希: 事务搭档')).toEqual({ name: '黄灵希', rel: '事务搭档' })
    expect(splitPerson('一个很长很长很长很长的名字的人:说明')).toBeNull()
    expect(splitPerson('没有分隔的一句话')).toBeNull()
  })
  it('speaks times in the owner timezone', () => {
    const now = Date.parse('2026-09-26T02:00:00Z')   // 上海 10:00
    expect(spokenTime(Date.parse('2026-09-25T20:05:00Z'), 'Asia/Shanghai', now)).toBe('今天凌晨 4 点')
    expect(spokenTime(Date.parse('2026-09-25T13:00:00Z'), 'Asia/Shanghai', now)).toBe('昨天晚上 9 点')
    expect(spokenTime(Date.parse('2026-09-20T07:00:00Z'), 'Asia/Shanghai', now)).toBe('9月20日下午 3 点')
  })
  it('labels and orders changes: notable first, expire dropped', () => {
    const ops: AppliedOp[] = [
      { kind: 'add', id: 'a1', section: '关于你', text: '养了只猫' },
      { kind: 'update', id: 'b1', section: '偏好', text: '回复更直接', before: '回复直接', reversal: false },
      { kind: 'expire', id: 'c0', section: '近况', text: '旧近况', reason: 'recent_stale' },
      { kind: 'remove', id: 'd1', section: '近况', text: '在搬家', reason: '之后没再提' },
      { kind: 'add', id: 'a2', section: '承诺', text: '周五回话' },
      { kind: 'update', id: 'b2', section: '偏好', text: '先上线', before: '先打磨', reversal: true },
    ]
    expect(viewChanges(ops)).toEqual([
      { kind: 'add', label: '新记下', section: '承诺', text: '周五回话' },
      { kind: 'update', label: '改了', section: '偏好', text: '先上线', before: '先打磨' },
      { kind: 'remove', label: '删了', section: '近况', text: '在搬家', reason: '之后没再提' },
      { kind: 'add', label: '记下', section: '关于你', text: '养了只猫' },
      { kind: 'update', label: '改了', section: '偏好', text: '回复更直接', before: '回复直接' },
    ])
  })
  it('formats the WeChat letter', () => {
    const d = emptyDoc()
    d.sections['承诺'] = [{ id: 'a1', text: '周五回话(期限 2026-09-27)', seen: '2026-09-26' }]
    d.sections['关于你'] = [{ id: 'a2', text: '全栈 / 产品型开发者', seen: '2026-09-26' }]
    d.sections['身边的人'] = [{ id: 'a3', text: '猪大哥 —— 女友,最亲', seen: '2026-09-26' }]
    const changes = viewChanges([{ kind: 'add', id: 'a1', section: '承诺', text: '周五回话(期限 2026-09-27)' }])
    expect(formatWeChatMemory({ doc: d, whenLabel: '今天凌晨 4 点', changes, failures: 0, today: '2026-09-26' })).toBe([
      '这是我眼中的你 🌙',
      '今天凌晨 4 点整理的,改了 1 处。',
      '',
      '【昨晚】',
      '· 新记下:周五回话',
      '',
      '【承诺】',
      '· 周五回话(明天)',
      '',
      '【关于你】',
      '· 全栈 / 产品型开发者',
      '',
      '【身边的人】',
      '· 猪大哥 —— 女友,最亲',
      '',
      '不对的地方直接跟我说。在「随身 CC」点一下我,能看到更好看的版本。',
    ].join('\n'))
  })
  it('says there is nothing new, caps 昨晚 at 3, and puts the failure warning first', () => {
    const d = emptyDoc()
    d.sections['偏好'] = [{ id: 'b1', text: '回复直接', seen: '2026-09-26' }]
    const quiet = formatWeChatMemory({ doc: d, whenLabel: '昨天凌晨 4 点', changes: [], failures: 0, today: '2026-09-26' })
    expect(quiet.split('\n').slice(0, 3)).toEqual(['这是我眼中的你 🌙', '昨天凌晨 4 点整理的,最近没有新变化。', ''])
    expect(quiet).not.toContain('【昨晚】')
    const many = viewChanges(['一', '二', '三', '四'].map((t, i) => ({ kind: 'add' as const, id: `x${i}`, section: '偏好' as const, text: t })))
    const busy = formatWeChatMemory({ doc: d, whenLabel: null, changes: many, failures: 0, today: '2026-09-26' })
    expect(busy).toContain('· 记下:三\n· 还有 1 处')
    expect(busy.split('\n')[1]).toBe('改了 4 处。')
    expect(formatWeChatMemory({ doc: d, whenLabel: null, changes: [], failures: 3, today: '2026-09-26' }).split('\n')[0])
      .toBe('⚠️ 最近 3 次整理都没成功,下面可能是旧的。')
  })
})

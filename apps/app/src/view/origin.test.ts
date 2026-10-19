import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Matter, MATTER_ORIGINS as PROTOCOL_ORIGINS } from '@wechat-cc/protocol'
import { t } from '../i18n'
import { MATTER_ORIGINS, matterOrigin, originKey } from './origin'
import { togetherView } from './together'

const matter = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'task', title: 'T ' + id, projectPath: null, status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1, ...extra })

describe('出生地(2026-10-19)', () => {
  it('跟协议同一组取值;认不出的值、空的、原型链上的名字都当不知道', () => {
    expect([...MATTER_ORIGINS]).toEqual([...PROTOCOL_ORIGINS])
    for (const o of MATTER_ORIGINS) expect(matterOrigin(o)).toBe(o)
    for (const v of [undefined, null, '', 'phone', 'toString', 1]) expect(matterOrigin(v)).toBeNull()
  })

  it('读屏念的那句话:两种语言都有,中文跟桌面 / 手机网页一字不差', () => {
    expect(MATTER_ORIGINS.map(o => t('zh-Hans', originKey(o)))).toEqual(['从微信来的', '从电脑来的', '从手机 App 来的', '从浏览器来的', '从终端来的', 'CC 自己起的'])
    for (const o of MATTER_ORIGINS) expect(t('en', originKey(o))).toMatch(/\S/)
  })

  it('协议:老 daemon 不带 ⇒ 没有;认不出的新值不让整行解析失败', () => {
    expect(Matter.parse(matter('a')).origin).toBeUndefined()
    expect(Matter.parse(matter('b', { origin: 'web' })).origin).toBe('web')
    expect(Matter.parse(matter('c', { origin: 'smart-fridge' })).origin).toBeUndefined()
  })

  it('「一起做」每行带出生地;老的事是 null(不画)', () => {
    const rows = togetherView([Matter.parse(matter('a', { origin: 'cli' })), Matter.parse(matter('b'))] as never, [], { tasks: [] } as never)
    expect(rows.map(r => [r.id, r.origin])).toEqual([['a', 'cli'], ['b', null]])
  })

  it('每个字形都有 1x/2x/3x,画法组件认全了每一种(没有原生依赖,按 ink 着色)', () => {
    const root = join(__dirname, '../../assets/origins')
    for (const o of MATTER_ORIGINS) for (const s of ['', '@2x', '@3x']) expect(existsSync(join(root, `${o}${s}.png`)), `${o}${s}.png`).toBe(true)
    const source = readFileSync(join(__dirname, '../ui/OriginMark.tsx'), 'utf8')
    for (const o of MATTER_ORIGINS) expect(source).toContain(`${o}: require('../../assets/origins/${o}.png')`)
    expect(source).toContain('tintColor: c.ink')
    expect(source).toContain('accessibilityLabel={t(lang, originKey(o))}')
    expect(source).toMatch(/if \(!o\) return null/)
    expect(source).not.toMatch(/react-native-svg/)
  })
})

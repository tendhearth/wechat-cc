import { describe, it, expect } from 'vitest'
import { handoffBlock, handoffErrorDot, handoffErrorText, handoffSheetLines, HANDOFF_RECHECK } from './handoff'

const NOW = 1_000_000
const offer = { state: 'offer' as const, from: 'claude', to: 'codex', kind: 'quota' as const, resetAt: NOW + 40 * 60_000 }

describe('handoffBlock(进展页底部那一块)', () => {
  it('没有这一块 ⇒ none', () => {
    expect(handoffBlock(undefined, 'zh-Hans', NOW)).toEqual({ kind: 'none' })
  })
  it('offer ⇒ 灰字说谁额度用完、约几分钟恢复 + 唯一的强调按钮「交给 X 继续」', () => {
    expect(handoffBlock(offer, 'zh-Hans', NOW)).toEqual({ kind: 'offer', note: 'Claude Code 的额度已用完，约 40 分钟后恢复', action: '交给 Codex 继续' })
    expect(handoffBlock(offer, 'en', NOW)).toEqual({ kind: 'offer', note: 'Claude Code is out of quota. It resets in about 40 min', action: 'Hand to Codex' })
  })
  it('限流说限流;剩不到一分钟也说约 1 分钟(不说 0)', () => {
    expect(handoffBlock({ ...offer, kind: 'rate_limit', resetAt: NOW + 5_000 }, 'zh-Hans', NOW)).toMatchObject({ note: 'Claude Code 暂时被限流，约 1 分钟后恢复' })
    expect(handoffBlock({ ...offer, resetAt: NOW - 5_000 }, 'zh-Hans', NOW)).toMatchObject({ note: 'Claude Code 的额度已用完，约 1 分钟后恢复' })
  })
  it('none ⇒ 只有灰字:谁用完 + 现在没人能接;没有按钮', () => {
    const b = handoffBlock({ state: 'none', from: 'codex', kind: 'quota', resetAt: NOW + 61_000 }, 'zh-Hans', NOW)
    expect(b).toEqual({ kind: 'note', lines: ['Codex 的额度已用完，约 2 分钟后恢复', '现在没有能接手的执行者，等额度恢复后再接着说'] })
  })
  it('handed ⇒ 说交给谁了 + 打开那件事', () => {
    expect(handoffBlock({ state: 'handed', from: 'claude', to: 'codex', matterId: 'deadbeef' }, 'zh-Hans', NOW)).toEqual({ kind: 'handed', note: '已经交给 Codex 继续', open: '打开那件事', matterId: 'deadbeef' })
  })
  it('不认识的执行者名字原样(不假定是 Claude)', () => {
    expect(handoffBlock({ ...offer, to: 'gemini' }, 'zh-Hans', NOW)).toMatchObject({ action: '交给 gemini 继续' })
  })
})

describe('handoffSheetLines(确认卡)', () => {
  it('四行:为什么 / 在哪、原来那件不动 / 接手的看不到之前的对话 / 会用谁的额度', () => {
    expect(handoffSheetLines(offer, 'zh-Hans', NOW)).toEqual([
      'Claude Code 的额度已用完，约 40 分钟后恢复。',
      '会在你电脑上同一个文件夹里，让 Codex 新开一件事接着做；原来这件留着不动。',
      'Codex 看不到 Claude Code 之前的对话，只拿到这件事的标题和「接着原来的要求做」。',
      '会用掉 Codex 的额度。',
    ])
  })
})

describe('handoffErrorText / Dot / RECHECK', () => {
  it.each([
    ['handoff_changed', '情况刚变了，再看一眼。', 'warn'],
    ['busy', '情况刚变了，再看一眼。', 'warn'],
    ['session_busy', 'CC 正在这个文件夹里做别的事，做完后才能接着做', 'warn'],
    ['provider_missing', '电脑上没装这个执行者', 'bad'],
    ['uncertain', '不确定电脑收到没有。再点一次不会重复。', 'unknown'],
    ['offline', '没有送到电脑上，请稍后再试。', 'bad'],
    ['unavailable', '没有送到电脑上，请稍后再试。', 'bad'],
    ['folder_missing', '电脑上找不到这个项目的文件夹了。', 'bad'],
    ['quota', '情况刚变了，再看一眼。', 'warn'],
    ['unknown', '这次没能交出去，请再试一次。', 'bad'],
  ] as const)('%s ⇒ %s', (code, text, dot) => {
    expect(handoffErrorText(code, 'zh-Hans')).toBe(text)
    expect(handoffErrorDot(code)).toBe(dot)
  })
  it('电脑那边状态变了的几种失败要重读详情', () => {
    for (const c of ['handoff_changed', 'busy', 'quota', 'session_busy', 'folder_missing']) expect(HANDOFF_RECHECK.has(c), c).toBe(true)
    expect(HANDOFF_RECHECK.has('uncertain')).toBe(false)
  })
})

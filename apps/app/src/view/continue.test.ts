import { describe, it, expect } from 'vitest'
import type { SessionContinueT } from '../backend/types'
import { CONTINUE_RECHECK, continueBlock, continueConfirmLabel, continueErrorDot, continueErrorText, continueSheetLines, nativeStartLines, providerName } from './continue'

// spec 2026-10-01-tendhearth-continue-sessions §4.4 / §4.5 / §5
const P = (o: Partial<SessionContinueT> = {}): SessionContinueT => ({ state: 'ready', provider: 'claude', project: 'portfolio', mode: 'native_resume', matterId: null, ...o })

describe('continueBlock:会话读页底部那一块', () => {
  it('还在问 ⇒ 不画(不先画一个可能用不了的按钮);问不到 ⇒ 灰字 + 再试', () => {
    expect(continueBlock('loading', 'zh-Hans')).toEqual({ kind: 'none' })
    expect(continueBlock('failed', 'zh-Hans')).toEqual({ kind: 'note', text: '现在确认不了能不能接着做', retry: true })
  })
  it('ready ⇒「接着做」;managed ⇒「打开这件事」', () => {
    expect(continueBlock(P(), 'zh-Hans')).toEqual({ kind: 'continue', label: '接着做' })
    expect(continueBlock(P({ provider: 'codex', mode: 'fresh_context' }), 'en')).toEqual({ kind: 'continue', label: 'Continue here' })
    expect(continueBlock(P({ state: 'managed', mode: null, matterId: 'deadbeef' }), 'en')).toEqual({ kind: 'open', label: 'Open this task' })
  })
  it.each([
    ['busy_session', '这个会话正在电脑上跑，停下后才能接着做'],
    ['busy_folder', 'CC 正在这个文件夹里做别的事，做完后才能接着做'],
    ['provider_missing', '电脑上没装 Claude Code'],
    ['folder_missing', '电脑上找不到这个会话的文件夹了'],
    ['quota', '这个执行者的额度已用完。等额度恢复后再试。'],
    ['empty', '这个会话里没有能带过来的内容'],
  ] as const)('%s ⇒ 一行灰字、没有按钮', (state, text) => {
    expect(continueBlock(P({ state, mode: null }), 'zh-Hans')).toEqual({ kind: 'note', text, retry: false })
  })
  it('没装执行者:名字取自预览(Codex 就说 Codex)', () => {
    expect(continueBlock(P({ state: 'provider_missing', provider: 'codex', mode: null }), 'en')).toEqual({ kind: 'note', text: 'Codex isn’t installed on your computer', retry: false })
  })
})

describe('continueSheetLines / continueConfirmLabel:确认卡(spec D3)', () => {
  it('Claude Code 恢复原会话:在哪、用谁、记得之前的话、会用额度、先让原来那个停下(CC 看不见终端里的它)', () => {
    expect(continueSheetLines(P(), 'zh-Hans')).toEqual([
      '会在你的电脑上用 Claude Code 接着做，文件夹是 portfolio。',
      '接着原来的会话，它记得之前说过的话。',
      '会用掉 Claude Code 的额度。',
      '先让电脑上原来那个 Claude Code 停下。CC 没法替你确认它停了。',
    ])
    expect(continueConfirmLabel(P(), 'zh-Hans')).toBe('已经停了，接着做')
    expect(continueConfirmLabel(P(), 'en')).toBe('It’s stopped — continue')
  })
  it('Codex(CC 看得见它在不在跑):新开一轮;如实说「没看到在跑」,按钮就是「接着做」', () => {
    expect(continueSheetLines(P({ provider: 'codex', mode: 'fresh_context', project: 'trip' }), 'en')).toEqual([
      'It runs on your computer with Codex, in the folder trip.',
      'The original session can’t be resumed, so it starts a new round and brings the earlier conversation along.',
      'This uses your Codex quota.',
      'CC didn’t see the original Codex running. If you have it open somewhere, stop it first.',
    ])
    expect(continueConfirmLabel(P({ provider: 'codex' }), 'zh-Hans')).toBe('接着做')
  })
  it('没有目录名 ⇒ 写「未知」,不留空', () => {
    expect(continueSheetLines(P({ project: null }), 'zh-Hans')[0]).toBe('会在你的电脑上用 Claude Code 接着做，文件夹是 （未知）。')
  })
})

describe('continueErrorText / continueErrorDot / CONTINUE_RECHECK:提交失败', () => {
  it.each([
    ['session_busy', '这个会话正在电脑上跑，停下后才能接着做', 'warn'],
    ['folder_busy', 'CC 正在这个文件夹里做别的事，做完后才能接着做', 'warn'],
    ['provider_missing', '电脑上没装 Codex', 'bad'],
    ['folder_missing', '电脑上找不到这个会话的文件夹了', 'bad'],
    ['quota', '这个执行者的额度已用完。等额度恢复后再试。', 'warn'],
    ['session_changed', '这个会话刚有新动静，再看一眼再接。', 'warn'],
    ['session_empty', '这个会话里没有能接着做的内容。', 'bad'],
    ['uncertain', '不确定电脑收到没有。再点一次不会重复。', 'unknown'],
    ['revoked', '这台手机已不再配对', 'bad'],
    ['offline', '没有送到电脑上，请稍后再试。', 'bad'],
    ['unavailable', '没有送到电脑上，请稍后再试。', 'bad'],
    ['unknown', '这次没能接上，请再试一次。', 'bad'],
  ])('%s ⇒ 「%s」,点 %s', (code, text, dot) => {
    expect(continueErrorText(code, 'codex', 'zh-Hans')).toBe(text)
    expect(continueErrorDot(code)).toBe(dot)
  })
  it('电脑那边答了的失败不说「没送到」(裁决 R5)', () => {
    for (const code of ['session_changed', 'session_empty', 'unknown', 'stale', 'invalid', 'not_found']) {
      expect(continueErrorText(code, 'claude', 'zh-Hans'), code).not.toContain('没有送到')
      expect(continueErrorText(code, 'claude', 'en'), code).not.toContain('didn’t reach')
    }
  })
  it('不知道是哪个执行者 ⇒ 说「这个执行者」,不假定是 Claude', () => {
    expect(continueErrorText('provider_missing', null, 'zh-Hans')).toBe('电脑上没装这个执行者')
  })
  it('状态类失败之后重问一次预览(按钮 / 灰字跟着变);网络类不重问', () => {
    expect([...CONTINUE_RECHECK].sort()).toEqual(['folder_busy', 'folder_missing', 'provider_missing', 'quota', 'session_busy', 'session_changed', 'session_empty'])
  })
})

describe('nativeStartLines / providerName', () => {
  it('第一句会怎样 + 先让原来那个停下(Claude Code 照 D3 说 CC 没法确认;Codex 说没看到在跑)', () => {
    expect(nativeStartLines({ mode: 'native_resume', providerId: 'claude' }, 'zh-Hans')).toEqual(['你发的第一句会接着电脑上原来的 Claude Code 会话。', '先让电脑上原来那个 Claude Code 停下。CC 没法替你确认它停了。'])
    expect(nativeStartLines({ mode: 'native_resume', providerId: 'codex' }, 'zh-Hans')).toEqual(['你发的第一句会接着电脑上原来的 Codex 会话。', 'CC 没看到原来那个 Codex 在跑；要是你在别处开着它，先让它停下。'])
    expect(nativeStartLines({ mode: 'fresh_context', providerId: 'claude' }, 'en')[0]).toBe('Your first message starts a new round with the earlier conversation attached.')
  })
  it('只认 claude / codex,别的原样', () => {
    expect(providerName('claude', 'en')).toBe('Claude Code')
    expect(providerName('codex', 'zh-Hans')).toBe('Codex')
    expect(providerName('cursor', 'en')).toBe('cursor')
  })
})

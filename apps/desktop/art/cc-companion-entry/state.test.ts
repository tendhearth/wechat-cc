import { describe, expect, it } from 'vitest'
import { createState } from './state.js'

describe('companion entry scoped preview', () => {
  it('retains personal and task drafts independently', () => {
    const s = createState()
    s.setDraft('home', '今天有点累')
    s.select('login')
    s.setDraft('login', '补过期处理')
    s.select('home')
    expect(s.scopes.home!.draft).toBe('今天有点累')
    expect(s.scopes.login!.draft).toBe('补过期处理')
  })
  it('binds delayed replies to the submitted task even after navigation', () => {
    const s = createState()
    s.setDraft('login', '请检查')
    const sent = s.submit('login')!
    s.select('talk')
    s.reply(sent.scope, '核对完成')
    expect(s.scopes.login!.messages.at(-1)?.text).toBe('核对完成')
    expect(s.scopes.talk!.messages).toEqual([])
    expect(s.active).toBe('talk')
  })
  it('keeps same-title tasks and attachments isolated by ID', () => {
    const s = createState()
    s.addFiles('website', ['需求.pdf'])
    s.setDraft('website', '新版')
    expect(s.tasks.website.title).toBe(s.tasks.slides.title)
    expect(s.scopes.slides!.files).toEqual([])
    expect(s.scopes.slides!.draft).toBe('')
    expect(s.submit('website')?.files).toEqual(['需求.pdf'])
    expect(s.scopes.website!.files).toEqual([])
  })
  it('rejects unknown scopes and empty submissions', () => {
    const s = createState()
    expect(() => s.select('missing')).toThrow()
    expect(s.submit('home')).toBeNull()
    s.setDraft('home', '  ')
    expect(s.submit('home')).toBeNull()
  })
  it('pauses only the selected task and retains the submitted message', () => {
    const s = createState()
    s.setDraft('login', '继续')
    s.submit('login')
    s.togglePause('login')
    expect(s.scopes.login!.paused).toBe(true)
    expect(s.scopes.website!.paused).toBe(false)
    expect(s.scopes.login!.messages[0]!.text).toBe('继续')
  })
  it('does not clear a new draft when an earlier reply arrives', () => {
    const s = createState()
    s.setDraft('login', '第一句')
    s.submit('login')
    s.setDraft('login', '下一句还没写完')
    s.reply('login', '已收到')
    expect(s.scopes.login!.draft).toBe('下一句还没写完')
  })
})

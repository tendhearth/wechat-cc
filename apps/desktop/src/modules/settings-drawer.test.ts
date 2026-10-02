import { beforeEach, describe, it, expect, vi } from 'vitest'

// No jsdom in this project — hand-stub the tiny DOM surface wireSettingsDrawer
// touches so we can exercise the toggle click handler and its revert-on-failure.

/** A fake toggle element that records aria-pressed + the `.on` class. */
function fakeToggle(id: string) {
  const attrs: Record<string, string> = { 'aria-pressed': 'false' }
  let on = false
  let clickHandler: null | (() => unknown) = null
  return {
    id,
    dataset: {} as Record<string, string>,
    getAttribute: (k: string) => attrs[k] ?? null,
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    removeAttribute: (k: string) => { delete attrs[k] },
    classList: { toggle: (_c: string, force?: boolean) => { on = force ?? !on } },
    addEventListener: (ev: string, fn: () => unknown) => { if (ev === 'click') clickHandler = fn },
    // test accessors
    _click: async () => { if (clickHandler) await clickHandler() },
    _state: () => ({ pressed: attrs['aria-pressed'], on }),
  }
}

function installDom(toggles: ReturnType<typeof fakeToggle>[], byId: Record<string, unknown> = {}) {
  globalThis.document = {
    getElementById: (id: string) => byId[id] ?? null,
    addEventListener: () => {},
    querySelectorAll: (sel: string) => (sel.includes('[data-toggle]') ? toggles : []),
  } as unknown as Document
}

describe('settings-drawer toggle — 持久化失败回滚', () => {
  it('onToggleChange 返回 false → 开关回滚(不撒谎);返回 true → 保持', async () => {
    const t = fakeToggle('guard-toggle')
    installDom([t])
    let succeed = false
    const onToggleChange = vi.fn(async () => succeed)
    const { wireSettingsDrawer } = await import('./settings-drawer.js')
    wireSettingsDrawer({ onToggleChange })

    // 失败:点开 → 乐观翻到 on → 持久化失败 → 回滚
    succeed = false
    await t._click()
    expect(onToggleChange).toHaveBeenCalledWith('guard-toggle', true)
    expect(t._state()).toEqual({ pressed: 'false', on: false })   // 回滚了

    // 成功:再点 → 翻到 on → 持久化成功 → 保持
    succeed = true
    await t._click()
    expect(t._state()).toEqual({ pressed: 'true', on: true })
  })
})

// 2026-09-29(取代 Codex #116 的一半):开关保存期间显示「保存中」、成功「已保存」、失败「没保存上,已恢复」,
// 保存期间再点不重复提交。
describe('settings-drawer toggle — 保存反馈与防重复点击', () => {
  // wireSettingsDrawer 每次加载只接一次线(listenersAttached);每条用例换一份新模块。
  beforeEach(() => { vi.resetModules() })
  const feedbackEl = () => ({ textContent: '', dataset: {} as Record<string, string> })
  it('保存中 → 已保存;保存期间按钮 disabled + aria-busy,再点不重复提交', async () => {
    const t = fakeToggle('guard-toggle'), fb = feedbackEl()
    installDom([t], { 'guard-toggle-feedback': fb })
    let release!: (v: boolean) => void
    const onToggleChange = vi.fn(() => new Promise<boolean>(r => { release = r }))
    const { wireSettingsDrawer } = await import('./settings-drawer.js')
    wireSettingsDrawer({ onToggleChange })
    const first = t._click()
    expect(fb.textContent).toBe('保存中…')
    expect(t.getAttribute('aria-busy')).toBe('true')
    expect(t.getAttribute('disabled')).toBe('')
    await t._click()
    expect(onToggleChange).toHaveBeenCalledTimes(1)
    release(true); await first
    expect(fb.textContent).toBe('已保存'); expect(fb.dataset.state).toBe('saved')
    expect(t.getAttribute('aria-busy')).toBeNull(); expect(t.getAttribute('disabled')).toBeNull()
    expect(t._state()).toEqual({ pressed: 'true', on: true })
  })
  it('失败 ⇒ 回滚并说没保存上;抛错同样', async () => {
    const t = fakeToggle('guard-toggle'), fb = feedbackEl()
    installDom([t], { 'guard-toggle-feedback': fb })
    const onToggleChange = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('x'))
    const { wireSettingsDrawer } = await import('./settings-drawer.js')
    wireSettingsDrawer({ onToggleChange })
    await t._click()
    expect(fb.textContent).toBe('没保存上,已恢复原来的设置'); expect(fb.dataset.state).toBe('error')
    expect(t._state()).toEqual({ pressed: 'false', on: false })
    await t._click()
    expect(fb.dataset.state).toBe('error'); expect(t.getAttribute('disabled')).toBeNull()
  })
  it('页面上没有反馈位 ⇒ 照常工作,不抛', async () => {
    const t = fakeToggle('guard-toggle')
    installDom([t])
    const { wireSettingsDrawer } = await import('./settings-drawer.js')
    wireSettingsDrawer({ onToggleChange: async () => true })
    await t._click()
    expect(t._state()).toEqual({ pressed: 'true', on: true })
  })
})

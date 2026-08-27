import { describe, it, expect, vi } from 'vitest'

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
    classList: { toggle: (_c: string, force?: boolean) => { on = force ?? !on } },
    addEventListener: (ev: string, fn: () => unknown) => { if (ev === 'click') clickHandler = fn },
    // test accessors
    _click: async () => { if (clickHandler) await clickHandler() },
    _state: () => ({ pressed: attrs['aria-pressed'], on }),
  }
}

function installDom(toggles: ReturnType<typeof fakeToggle>[]) {
  globalThis.document = {
    getElementById: () => null,
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

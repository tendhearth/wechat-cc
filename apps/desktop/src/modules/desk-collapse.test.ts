import { describe, expect, it, vi } from 'vitest'
import { isDeskCollapseShortcut, readDeskCollapsed, writeDeskCollapsed } from './desk-collapse.js'

describe('desk collapse preference', () => {
  it('opens by default and stores both choices under the same key', () => {
    const entries = new Map<string, string>()
    const host = { localStorage: { getItem: entries.get.bind(entries), setItem: entries.set.bind(entries) } } as unknown as Window
    expect(readDeskCollapsed(host)).toBe(false)
    writeDeskCollapsed(host, true)
    expect(entries.get('wechat-cc:desk-left-collapsed')).toBe('true')
    expect(readDeskCollapsed(host)).toBe(true)
    writeDeskCollapsed(host, false)
    expect(readDeskCollapsed(host)).toBe(false)
  })

  it('survives denied access and a denied write', () => {
    const denied = () => { throw new Error('Storage denied') }
    const host = { get localStorage() { return denied() } } as unknown as Window
    expect(readDeskCollapsed(host)).toBe(false)
    expect(() => writeDeskCollapsed(host, true)).not.toThrow()
    const setItem = vi.fn(denied)
    expect(() => writeDeskCollapsed({ localStorage: { setItem } } as unknown as Window, true)).not.toThrow()
    expect(setItem).toHaveBeenCalledWith('wechat-cc:desk-left-collapsed', 'true')
  })
})

function shortcut(override: Partial<KeyboardEvent>) {
  return { key: 'b', metaKey: false, ctrlKey: false, ...override } as KeyboardEvent
}

describe('desk collapse shortcut', () => {
  it('uses Command on macOS and Control elsewhere', () => {
    expect(isDeskCollapseShortcut(shortcut({ metaKey: true }), true)).toBe(true)
    expect(isDeskCollapseShortcut(shortcut({ ctrlKey: true }), false)).toBe(true)
    expect(isDeskCollapseShortcut(shortcut({ ctrlKey: true }), true)).toBe(false)
    expect(isDeskCollapseShortcut(shortcut({ metaKey: true }), false)).toBe(false)
  })

  it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }, { altKey: true }, { key: '\\' }, { key: 'a' }, { defaultPrevented: true }, { ctrlKey: true }])(
    'ignores composition and other keys or modifiers (%j)', override => {
      expect(isDeskCollapseShortcut(shortcut({ metaKey: true, ...override }), true)).toBe(false)
    },
  )
})

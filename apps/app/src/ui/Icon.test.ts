// @vitest-environment happy-dom
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, mount } from './native-motion.test-support'
vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
const { Icon } = await import('./Icon')
import type { IconName } from './Icon'
afterEach(cleanup)

it('resolves every native icon to a bundled high-resolution RGBA PNG and keeps the label on its enclosing control', async () => {
  const names: IconName[] = ['arrowUp', 'mic', 'stop', 'close', 'help', 'check', 'chevronDown', 'chevronRight', 'refresh', 'info', 'alert', 'clock', 'pause', 'back', 'settings', 'monitor', 'plus', 'search', 'more', 'shield', 'book', 'mail', 'folder', 'calendar', 'terminal', 'device', 'link', 'image', 'camera', 'done', 'message', 'restore', 'edit', 'unlink']
  const ui = await mount(createElement('div', null, names.map(name => createElement(Icon, { key: name, name, testID: name, size: 18 }))))
  for (const name of names) {
    const icon = ui.byId(name), png = readFileSync(icon.getAttribute('src')!)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]]).toEqual([96, 96, 6])
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('aria-label')).toBeNull()
    expect(ui.style(name).width).toBe(18)
    expect(ui.style(name).tintColor).toBeTruthy()
  }
})

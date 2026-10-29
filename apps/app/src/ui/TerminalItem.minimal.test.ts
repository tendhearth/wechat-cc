// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import { withLang } from '../state/providers.test-support'
import type { TerminalRow } from '../view/terminal'
import { cleanup, mount } from './native-motion.test-support'
import { TerminalItem } from './TerminalItem'

vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)

const row = (over: Partial<TerminalRow> = {}): TerminalRow => ({
  id: 'terminal-1', project: 'portfolio', source: 'Codex', agent: 'codex', status: 'waiting', stale: false,
  summary: null, ago: '5 min', pendingText: 'Bash: npm run deploy', actionable: true, hash: 'hash', nowText: null, live: true, ...over,
})

describe.each(['en', 'zh-Hans'] as const)('minimal terminal row (%s)', lang => {
  it('keeps the operation and review intent on the single accessible navigation control', async () => {
    const onOpen = vi.fn(), value = row()
    const ui = await mount(withLang(lang, createElement(TerminalItem, { row: value, onOpen })))
    const control = ui.byId('terminal-open-terminal-1')
    const label = control.getAttribute('aria-label')!
    expect(label).toContain(value.pendingText)
    expect(label).toContain(value.project)
    expect(label).toContain(value.source)
    expect(label).toContain(t(lang, 'terminal.status.waiting'))
    expect(label).toContain(t(lang, 'terminal.review'))
    expect(control.textContent).toContain(value.pendingText)
    expect(control.textContent).not.toContain(t(lang, 'terminal.review'))
    expect(ui.byId('terminal-review-terminal-1')).not.toBeNull()
    await act(() => control.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('keeps computer-only waiting instructions visible and in the accessible label', async () => {
    const value = row({ actionable: false, hash: null })
    const ui = await mount(withLang(lang, createElement(TerminalItem, { row: value, onOpen: () => {} })))
    const instruction = t(lang, 'terminal.askedLocally')
    expect(ui.byId('terminal-local-terminal-1').textContent).toBe(instruction)
    expect(ui.byId('terminal-open-terminal-1').getAttribute('aria-label')).toContain(instruction)
    expect(ui.byId('terminal-review-terminal-1')).toBeNull()
  })

  it('makes stale evidence explicit without presenting the cached running step as current work', async () => {
    const value = row({ status: 'running', stale: true, pendingText: null, actionable: false, nowText: 'Run old command' })
    const ui = await mount(withLang(lang, createElement(TerminalItem, { row: value, onOpen: () => {} })))
    const control = ui.byId('terminal-open-terminal-1'), stale = t(lang, 'terminal.stale.hint')
    expect(control.textContent).toContain(stale)
    expect(control.textContent).toContain(value.ago)
    expect(control.getAttribute('aria-label')).toContain(stale)
    expect(control.getAttribute('aria-label')).toContain(t(lang, 'terminal.status.running'))
    expect(control.textContent).not.toContain(value.nowText)
    expect(ui.byId('terminal-now-terminal-1')).toBeNull()
  })
})

// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import { t } from '../i18n'
import { withProviders } from '../state/providers.test-support'
import type { HomeRow } from '../view/home'
import { MatterRow } from './MatterRow'
import { cleanup, mount } from './native-motion.test-support'

vi.mock('react-native', async () => (await import('./native-motion.test-support')).nativeBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)

const row = (over: Partial<HomeRow> = {}): HomeRow => ({
  id: 'x1', source: 'terminal', href: '/terminal/x1', title: 'Bash: npm run deploy', caption: 'portfolio · 5 min', detail: null, note: null,
  status: 'waiting', pendingRequestId: null, agents: ['codex'], origin: null, updatedAt: 1, ...over,
})

describe.each(['en', 'zh-Hans'] as const)('一种行 MatterRow(%s)', lang => {
  const render = (r: HomeRow, onOpen = () => {}) => mount(withProviders(createElement(MatterRow, { row: r, onOpen }), { backend: makeDemoBackend({ lang }), lang }))

  it('一个可点的控件:读屏念标题、状态词、caption;点了打开', async () => {
    const onOpen = vi.fn(), r = row()
    const ui = await render(r, onOpen)
    const control = ui.byId('row-terminal-x1')
    const label = control.getAttribute('aria-label')!
    expect(label).toContain(r.title)
    expect(label).toContain(t(lang, 'status.waiting'))
    expect(label).toContain(r.caption!)
    expect(control.textContent).toContain(r.title)
    expect(control.textContent).toContain(r.caption!)
    await act(() => control.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('终端自己在问 ⇒ 提醒单独一行、也在读屏标签里', async () => {
    const note = t(lang, 'terminal.askedLocally')
    const ui = await render(row({ note }))
    expect(ui.byId('row-note-x1').textContent).toBe(note)
    expect(ui.byId('row-terminal-x1').getAttribute('aria-label')).toContain(note)
  })

  it('没有 caption / detail / note ⇒ 不画空行', async () => {
    const ui = await render(row({ source: 'matter', status: 'working', caption: null }))
    expect(ui.byId('row-matter-x1')).not.toBeNull()
    expect(ui.byId('row-note-x1')).toBeNull()
    expect(ui.byId('row-detail-x1')).toBeNull()
  })
})

describe('图标与色调只来自状态表', () => {
  it('源码里没有手写的 状态 ⇒ 图标 映射', () => {
    const src = readFileSync(join(__dirname, 'MatterRow.tsx'), 'utf8')
    expect(src).toContain('STATUS_TABLE')
    expect(src).not.toMatch(/status === '(waiting|done|failed|replied)' \?/)
  })
})

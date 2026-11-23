// @vitest-environment happy-dom
import { terminalPermission } from './terminal'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDemoBackend } from '../backend/demo'
import type { Backend, CliSessionRowT } from '../backend/types'
import Matter from '../app/matter/[id]/index'
import { withProviders } from '../state/providers.test-support'
import { TerminalPermission } from '../ui/TerminalPermission'
import { cleanup, mount } from '../ui/native-motion.test-support'

const route = vi.hoisted(() => ({ id: 'a1b2c3d4' }))
vi.mock('react-native', async () => {
  const { forwardRef } = await import('react')
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID }: any, ref) => createElement('textarea', {
    ref, value, 'data-testid': testID, onInput: (event: any) => onChangeText(event.currentTarget.value),
  }))
  const Text = ({ selectable, accessible, ...props }: any) => createElement('span', {
    'data-selectable': selectable, 'aria-hidden': accessible === false || undefined,
  }, createElement(native.Text, props))
  return { ...native, ScrollView: native.View, KeyboardAvoidingView: native.View, Text, TextInput, ActivityIndicator: () => null, Linking: { openURL: vi.fn() } }
})
vi.mock('react-native-safe-area-context', async () => ({ SafeAreaProvider: ({ children }: any) => children, SafeAreaView: (await import('../ui/native-motion.test-support')).View }))
vi.mock('expo-router', async () => ({
  ...await (await import('../ui/native-motion.test-support')).routerBoundary(),
  useLocalSearchParams: () => ({ id: route.id }),
  useRouter: () => ({ canGoBack: () => true, back() {}, replace() {}, push() {} }), Redirect: () => null,
}))
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
afterEach(cleanup)
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

/** 一件 kind='terminal' 的事(M4c):同一个详情页 /matter/<id>,按 kind 画终端那一份 —— 会话 id 从 cli 绑定来。 */
describe('终端会话的那件事 → 终端详情', () => {
  it('kind=terminal ⇒ 画终端详情(状态 / 看着它跑 / 说一句,按绑定的会话 id 拉);别的种类照旧', async () => {
    const demo = makeDemoBackend({ lang: 'en' })
    const base = await demo.matter('a1b2c3d4', 'en')
    const row: CliSessionRowT = {
      session_id: 'sess-42', code: 'sess-4', source: 'claude', displayName: 'Claude', status: 'idle', stale: false, project: 'blog', machine: null,
      last_summary: 'Ready', last_event_at: Date.now(), last_prompt_at: null, created_at: 1, pending: null, matter_id: 'feedf00d',
    }
    const activity = vi.fn(async () => [{ kind: 'step' as const, text: '运行 npm test', at: null }])
    const backend: Backend = {
      ...demo,
      matter: async (id, l) => (id === 'feedf00d'
        ? { ...base, matter: { ...base.matter, id, kind: 'terminal', title: 'blog' }, bindings: [{ matterId: id, surface: 'cli', surfaceKey: 'sess-42', lastSeenAt: 1 }] }
        : demo.matter(id, l)),
      cliSessions: async () => [row],
      cliActivity: activity,
    }
    route.id = 'feedf00d'
    const ui = await mount(withProviders(createElement(Matter), { backend, lang: 'en' }))
    await flush(); await flush()
    expect(ui.byId('terminal-detail-status')).not.toBeNull()
    expect(ui.byId('terminal-say-input')).not.toBeNull()
    expect(activity).toHaveBeenCalledWith('sess-42')
  })
  it.each([
    { tool: 'Bash', summary: 'printf first\r\nWorking directory: /sample\r\nprintf last…', kind: 'command',
      action: 'Claude Code wants to run a command', truncated: true, actionable: true },
    { tool: 'Bash', summary: 'printf %s ' + 'x'.repeat(190), kind: 'command',
      action: 'Claude Code wants to run a command', truncated: true, actionable: true },
    { tool: 'Bash', summary: 'printf %s ' + 'x'.repeat(189), kind: 'command',
      action: 'Claude Code wants to run a command', truncated: false, actionable: true },
    { tool: 'Edit', summary: '{"file_path":"notes.txt","old_string":"…', kind: 'text',
      action: 'Claude Code wants to use “Edit”', truncated: true, actionable: false },
    { tool: 'Edit', summary: '{"file_path":"/sample/blog/notes.txt","old_string":"Draft","new_string":"Ready"}', kind: 'edit',
      action: 'Claude Code wants to edit a file', truncated: false, actionable: true },
    { tool: 'Bash', summary: null, kind: null,
      action: 'Claude Code wants to use “Bash”', truncated: false, actionable: true },
  ])('shows the pending operation and its controls through the terminal matter route ($tool / $kind)', async ({
    tool, summary, kind, action, truncated, actionable,
  }) => {
    const demo = makeDemoBackend({ lang: 'en' })
    const base = await demo.matter('a1b2c3d4', 'en')
    const [fixture] = await demo.cliSessions()
    if (!fixture) throw Error('missing terminal fixture')
    const id = 'feedf00d', projectPath = '/sample/blog'
    const backend: Backend = {
      ...demo,
      matter: async () => ({ ...base, matter: { ...base.matter, id, projectPath, kind: 'terminal' },
        bindings: [{ matterId: id, surface: 'cli', surfaceKey: fixture.session_id, lastSeenAt: 1 }] }),
      cliSessions: async () => [{ ...fixture, status: 'waiting', displayName: 'Claude Code', project: 'blog',
        pending: { tool, summary, since: 1, hash: actionable ? 'demo' : null, actionable } }],
      cliActivity: async () => [],
    }
    route.id = id
    const ui = await mount(withProviders(createElement(Matter), { backend, lang: 'en' }))
    await flush(); await flush()
    expect(ui.byId('terminal-detail-pending-actor')?.textContent === action).toBe(true)
    const warning = ui.byId('terminal-detail-pending-truncated')
    expect(Boolean(warning)).toBe(truncated)
    if (warning) expect(warning.textContent === 'This may be incomplete. See the full details in the terminal.').toBe(true)
    expect(Boolean(ui.byId('terminal-detail-allow'))).toBe(actionable)
    expect(Boolean(ui.byId('terminal-detail-local'))).toBe(!actionable)
    expect(Boolean(ui.byId('terminal-detail-pending'))).toBe(kind !== null)
    if (kind) {
      expect(ui.byId('terminal-detail-pending').contains(ui.byId(`approval-operation-${kind}`))).toBe(true)
      if (kind === 'edit') {
        const edit = ui.byId('approval-operation-edit')
        expect(['notes.txt', '− Draft', '+ Ready'].every(value => edit.textContent?.includes(value))).toBe(true)
      } else expect(ui.byId('approval-operation-source')?.textContent === summary).toBe(true)
      expect(ui.byId('approval-operation-cwd')?.textContent === `Project folder ${projectPath}`).toBe(true)
      expect(ui.byId('approval-operation-label').getAttribute('aria-label')?.endsWith(`Project folder ${projectPath}`)).toBe(true)
    }
    expect(ui.byId('approval-operation-more')).toBeNull()
    expect(ui.byId('approval-exact-source')).toBeNull()
    if (summary && !truncated) {
      const entry = ui.byId('approval-view-exact')
      expect(entry.tagName).toBe('BUTTON')
      expect(entry.getAttribute('aria-label')).toBe('See the full original')
      await act(() => entry.click())
      const original = ui.byId('approval-exact-source')
      expect(original.textContent === summary).toBe(true)
      expect(original.getAttribute('role')).toBe('text')
      expect(original.closest('[data-selectable="true"]')).not.toBeNull()
      expect(original.closest('[aria-hidden="true"]')).toBeNull()
      expect(ui.byId('approval-exact-cwd')?.textContent === `Project folder ${projectPath}`).toBe(true)
    } else {
      expect(ui.byId('approval-view-exact')).toBeNull()
    }
  })

})


describe('wire terminal approvals', () => {
  it.each([true, false])('shows the right disclosure for a truncated preview (summary truncated: %s)', async truncated => {
    const display = { body: { kind: 'command' as const, command: 'sample preview' }, truncated: true }
    const summary = 'sample original'
    const ui = await mount(withProviders(createElement(TerminalPermission, {
      pending: { tool: 'Bash', summary, display, truncated }, source: 'Claude', projectPath: '/sample', scroll: { current: null },
    }), { backend: makeDemoBackend({ lang: 'en' }), lang: 'en' }))
    const warning = ui.byId('terminal-detail-pending-truncated')
    expect(warning.textContent).toBe(truncated
      ? 'This may be incomplete. See the full details in the terminal.'
      : 'This preview is incomplete. See the full original below.')
    if (truncated) expect(ui.byId('approval-view-exact')).toBeNull()
    else {
      await act(() => ui.byId('approval-view-exact').click())
      expect(ui.byId('approval-exact-source').textContent === summary).toBe(true)
    }
  })

  it.each([true, false, undefined])('uses the summary truncation flag %s independently from structured approval', truncated => {
    const summary = 'x'.repeat(200)
    const command = 'printf "example"\r\nprintf "next"\n'
    const cwd = 'C:\\project\\work'
    const pending = { tool: 'Bash', summary, display: { body: { kind: 'command' as const, command } }, cwd, truncated }
    const result = terminalPermission(pending, 'Codex', 'zh-Hans')
    expect(result.summaryTruncated).toBe(truncated ?? true)
    expect(result.hasFullSource).toBe(!(truncated ?? true))
    expect(result.raw === ((truncated ?? true) ? summary : command) && result.cwd === cwd && result.display?.body.kind === 'command' &&
      result.display.body.command === command).toBe(true)
    const cut = terminalPermission({ ...pending, truncated: false, display: { ...pending.display, truncated: true } }, 'Codex', 'zh-Hans')
    expect(cut.display?.truncated).toBe(true)
    expect(cut.summaryTruncated).toBe(false)
    expect(cut.hasFullSource && cut.raw === summary).toBe(true)
    const fallback = terminalPermission({ ...pending, display: { body: { kind: 'command' } } } as typeof pending, 'Codex', 'zh-Hans')
    expect(fallback.display?.body.kind === 'command' && fallback.raw === summary).toBe(true)
    expect(fallback.summaryTruncated).toBe(truncated ?? true)
    expect(fallback.hasFullSource).toBe(!(truncated ?? true))
  })
})

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
    const activity = vi.fn(async () => [
      { kind: 'you' as const, text: 'README', at: null },
      { kind: 'step' as const, text: '运行 npm test', at: null },
    ])
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
    expect(ui.byId('direct-title').textContent).toBe('blog')
    expect(ui.byId('direct-project').textContent).toBe('Claude · terminal session')
    expect(ui.byId('terminal-detail-meta').textContent).toBe('Claude · just now')
    expect(ui.byId('terminal-activity-you-0').textContent).toBe('You:README')
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
    expect(ui.byId('terminal-detail-agent')).toBeNull()
    expect(ui.byId('terminal-detail-pending-actor')?.textContent?.startsWith(`${action} · `)).toBe(true)
    const warning = ui.byId('terminal-detail-pending-truncated')
    expect(Boolean(warning)).toBe(truncated)
    if (warning) expect(warning.textContent === 'This is incomplete. See the full details in the terminal.').toBe(true)
    expect(Boolean(ui.byId('terminal-detail-allow'))).toBe(actionable)
    expect(Boolean(ui.byId('terminal-detail-local'))).toBe(!actionable)
    expect(Boolean(ui.byId('terminal-detail-pending'))).toBe(kind !== null)
    if (kind) {
      expect(ui.byId('terminal-detail-pending').contains(ui.byId(`approval-operation-${kind}`))).toBe(true)
      if (kind === 'edit') {
        const edit = ui.byId('approval-operation-edit')
        expect(['notes.txt', '− Draft', '+ Ready'].every(value => edit.textContent?.includes(value))).toBe(true)
      } else expect(ui.byId('approval-operation-source')?.textContent === summary.replaceAll('\r', '\\r')).toBe(true)
      const panel = ui.byId(`approval-operation-${kind}`)
      expect(panel.previousElementSibling?.textContent).toBe('Summary')
      expect(panel.nextElementSibling?.textContent).toBe('The summary may collapse line breaks and repeated spaces.')
      expect(ui.byId('approval-operation-cwd')?.textContent === `Project folder ${projectPath}`).toBe(true)
      expect(ui.byId('approval-operation-label').getAttribute('aria-label')?.endsWith(`Project folder ${projectPath}`)).toBe(true)
    }
    expect(ui.byId('approval-operation-more')).toBeNull()
    expect(ui.byId('approval-exact-source')).toBeNull()
    if (summary && !truncated) {
      const entry = ui.byId('terminal-view-summary')
      expect(entry.tagName).toBe('BUTTON')
      expect(entry.getAttribute('aria-label')).toBe('See summary')
      await act(() => entry.click())
      expect(ui.container.textContent?.includes('The summary may collapse line breaks and repeated spaces.')).toBe(true)
      const original = ui.byId('terminal-summary-source')
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
    expect(warning.textContent).toBe('This is incomplete. See the full details in the terminal.')
    expect(ui.byId('approval-view-exact')).toBeNull()
    if (truncated) expect(ui.byId('terminal-view-summary')).toBeNull()
    else {
      await act(() => ui.byId('terminal-view-summary').click())
      expect(ui.byId('terminal-summary-source').textContent === summary).toBe(true)
    }
  })

  it.each([true, false, undefined])('uses the summary truncation flag %s only when structured approval is unavailable', truncated => {
    const summary = 'x'.repeat(200)
    const command = 'printf "example"\r\nprintf "next"\n'
    const cwd = 'C:\\project\\work'
    const pending = { tool: 'Bash', summary, display: { body: { kind: 'command' as const, command } }, cwd, truncated }
    const result = terminalPermission(pending, 'Codex', 'zh-Hans')
    expect(result.summaryTruncated).toBe(truncated ?? true)
    expect(result.summaryOnly).toBe(false)
    expect(result.raw === command && result.cwd === cwd && result.display?.body.kind === 'command' &&
      result.display.body.command === command).toBe(true)
    const cut = terminalPermission({ ...pending, truncated: false, display: { ...pending.display, truncated: true } }, 'Codex', 'zh-Hans')
    expect(cut.display?.truncated).toBe(true)
    expect(cut.summaryTruncated).toBe(false)
    expect(cut.summaryOnly).toBe(false)
    expect(cut.raw === undefined && cut.summary === summary && cut.received === command).toBe(true)
    const fallback = terminalPermission({ ...pending, display: { body: { kind: 'command' } } } as typeof pending, 'Codex', 'zh-Hans')
    expect(fallback.display?.body.kind === 'command' && fallback.display.body.command === summary).toBe(true)
    expect(fallback.summaryTruncated).toBe(truncated ?? true)
    expect(fallback.summaryOnly).toBe(true)
    expect(fallback.raw === undefined && fallback.summary === ((truncated ?? true) ? '' : summary)).toBe(true)
  })
})


it.each([false, true])('opens every received command line with a cut summary (preview cut: %s)', async truncated => {
  const command = Array.from({ length: 12 }, (_, i) => `printf "sample  line number ${i}"`).join('\n')
  expect(command.length).toBeGreaterThan(200)
  const ui = await mount(withProviders(createElement(TerminalPermission, {
    pending: { tool: 'Bash', summary: 'shortened…', truncated: true, display: { body: { kind: 'command', command }, truncated } },
    source: 'Claude', projectPath: '/sample', scroll: { current: null },
  }), { backend: makeDemoBackend({ lang: 'en' }), lang: 'en' }))
  expect(ui.byId('approval-operation-source').textContent === command.split('\n').slice(0, 8).join('\n')).toBe(true)
  const entry = ui.byId('approval-view-exact')
  const more = ui.byId('approval-operation-more')
  expect(more.getAttribute('aria-label')).toBe(truncated ? 'Expand received content' : '4 more lines · See all')
  expect(Boolean(ui.byId('terminal-detail-pending-truncated'))).toBe(truncated)
  if (truncated) expect(entry).toBeNull()
  else expect(entry.getAttribute('aria-label')).toBe('See the full original')
  await act(() => more.click())
  expect(ui.byId(truncated ? 'terminal-received-source' : 'approval-exact-source').textContent === command).toBe(true)
})

it.each([
  ['final newline removed', 'abc\n', 'abc', 'This fragment ends with one fewer line break.'],
  ['final newline removed below the fold', 'abc\n'.repeat(13), 'abc\n'.repeat(12) + 'abc', 'This fragment ends with one fewer line break.'],
  ['final newline added', 'abc', 'abc\n', 'This fragment ends with one more line break.'],
  ['tabs replaced', '\tabc', '    abc', null],
  ['trailing spaces', 'abc  ', 'abc ', null],
  ['CRLF changed to LF', 'abc\r\ndef\r\n', 'abc\ndef\n', null],
  ['mixed edit', 'old\nkeep  \nstable', 'new\nextra\nkeep \nstable', null],
])('warns about whitespace edits and preserves exact edit inputs (%s)', async (_, before, after, marker) => {
  const ui = await mount(withProviders(createElement(TerminalPermission, {
    pending: { tool: 'Edit', summary: 'collapsed…', truncated: true,
      display: { body: { kind: 'edit', path: 'sample', changes: [{ before, after }] } } },
    source: 'Claude', projectPath: '/sample', scroll: { current: null },
  }), { backend: makeDemoBackend({ lang: 'en' }), lang: 'en' }))
  const change = ui.byId('approval-edit-0')
  expect(change.textContent?.includes('This change includes differences in line breaks or whitespace that this preview cannot show.')).toBe(true)
  expect(change.textContent?.includes(marker ?? 'This fragment ends with one')).toBe(marker !== null)
  await act(() => ui.byId('approval-view-exact').click())
  expect(ui.byId('approval-exact-source').textContent === `sample\nBefore: ${JSON.stringify(before)}\nAfter: ${JSON.stringify(after)}`).toBe(true)
})

it.each([true, false])('shows the ending of an inserted fragment (final newline: %s)', async endsWithNewline => {
  const lang = 'zh-Hans'
  const ui = await mount(withProviders(createElement(TerminalPermission, {
    pending: { tool: 'Edit', summary: null, display: {
      body: { kind: 'edit', path: 'sample', changes: [{ before: '', after: endsWithNewline ? 'sample\n' : 'sample' }] },
    } },
    source: 'Claude', projectPath: '/sample', scroll: { current: null },
  }), { backend: makeDemoBackend({ lang }), lang }))
  expect(ui.byId('approval-edit-0').textContent?.includes(endsWithNewline ? '这一段末尾有换行' : '这一段末尾没有换行')).toBe(true)
})

it.each(['Bash', 'Edit'] as const)('marks unsafe characters in the %s preview and its full source', async tool => {
  const value = '中文🙂\n\t\r\x1b\u202e\u200b'
  const marks = ['\\r', '\\x1b', '\\u{202E}', '\\u{200B}']
  const body = tool === 'Bash' ? { kind: 'command' as const, command: value }
    : { kind: 'edit' as const, path: value, changes: [{ before: value, after: 'sample' }] }
  const ui = await mount(withProviders(createElement(TerminalPermission, {
    pending: { tool, summary: null, display: { body } }, source: 'Claude', projectPath: '/sample', scroll: { current: null },
  }), { backend: makeDemoBackend({ lang: 'en' }), lang: 'en' }))
  const panel = ui.byId(`approval-operation-${body.kind}`)
  const visibleMarks = (node: Element) => [...node.querySelectorAll('[data-testid="approval-invisible"]')].map(mark => mark.textContent)
  expect(visibleMarks(panel)).toEqual(tool === 'Bash' ? marks : [...marks, ...marks])
  expect(panel.textContent?.includes('中文🙂')).toBe(true)
  for (const mark of marks) expect(ui.byId('approval-operation-label').getAttribute('aria-label')?.includes('Invisible character ' + mark)).toBe(true)
  expect(ui.byId('approval-invisible-notice')?.textContent).toBe('This content contains invisible characters, marked above or in the expanded text.')
  await act(() => ui.byId('approval-view-exact').click())
  const original = ui.byId('approval-exact-source')
  expect(visibleMarks(original)).toEqual(tool === 'Bash' ? marks : [...marks, ...marks])
  for (const mark of marks) expect(original.getAttribute('aria-label')?.includes('Invisible character ' + mark)).toBe(true)
})

it('identifies a short untruncated legacy command as a summary before any expansion', async () => {
  const ui = await mount(withProviders(createElement(TerminalPermission, {
    pending: { tool: 'Bash', summary: 'echo first echo second', truncated: false },
    source: 'Claude', projectPath: '/sample', scroll: { current: null },
  }), { backend: makeDemoBackend({ lang: 'en' }), lang: 'en' }))
  expect(ui.byId('terminal-summary-label')?.textContent).toBe('Summary')
  expect(ui.byId('terminal-summary-whitespace')?.textContent).toBe('The summary may collapse line breaks and repeated spaces.')
  expect(ui.byId('terminal-detail-pending-truncated')).toBeNull()
  expect(ui.byId('terminal-summary-source')).toBeNull()
})

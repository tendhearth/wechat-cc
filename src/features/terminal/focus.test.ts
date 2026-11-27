import { expect, it, vi } from 'vitest'
import { terminalFocusPlan } from './focus-plan'
import { makeTerminalFocus } from './focus'

const uuid = '12345678-1234-1212-abcd-123456789abc'
const app = (id: string, path?: string) => ({ command: '/usr/bin/open', args: ['-b', id, ...(path ? [path] : [])] })
const tty = '/dev/ttys004'
const terminal = { bundle_id: 'com.apple.Terminal', tty }

it.each([
  ['old session', null, [], undefined],
  ['unknown terminal', { term_program: 'other' }, [], undefined],
  ['Warp', { bundle_id: 'dev.warp.Warp-Stable' }, [], app('dev.warp.Warp-Stable')],
  ['VS Code', { bundle_id: 'com.microsoft.VSCode' }, [], app('com.microsoft.VSCode', '/my repo')],
  ['Cursor', { bundle_id: 'com.todesktop.230313mzl4w4u92' }, [], app('com.todesktop.230313mzl4w4u92', '/my repo')],
  ['other app', { bundle_id: 'org.example.Terminal' }, [], app('org.example.Terminal')],
  ['tmux', { term_program: 'Apple_Terminal', tmux: '/tmp/tmux-501/default,123,0', tmux_pane: '%90', tty }, [
    { command: 'tmux', args: ['-S', '/tmp/tmux-501/default', 'select-window', '-t', '%90'] },
    { command: 'tmux', args: ['-S', '/tmp/tmux-501/default', 'select-pane', '-t', '%90'] },
  ], app('com.apple.Terminal')],
  ['WezTerm', { wezterm_pane: '99', wezterm_socket: '/tmp/wez.sock' }, [
    { command: 'wezterm', args: ['cli', 'activate-pane', '--pane-id', '99'], env: { WEZTERM_UNIX_SOCKET: '/tmp/wez.sock' } },
  ], app('com.github.wez.wezterm')],
  ['kitty', { kitty_window_id: '9', kitty_socket: 'unix:/tmp/kitty.sock' }, [
    { command: 'kitten', args: ['@', '--to', 'unix:/tmp/kitty.sock', 'focus-window', '--match', 'id:9'] },
  ], app('net.kovidgoyal.kitty')],
  ['kitty without a local socket', { kitty_window_id: '9' }, [], app('net.kovidgoyal.kitty')],
  ['Ghostty without a tty', { term_program: 'ghostty' }, [], app('com.mitchellh.ghostty')],
  ['invalid args', { bundle_id: '-bad', tmux: '/tmp/s,1,0', tmux_pane: '%1; x', iterm_session_id: `${uuid}"` }, [], undefined],
])('%s plans only documented argv', (_name, position, select, activate) => {
  const plan = terminalFocusPlan(position, '/my repo')
  expect(plan.select).toEqual(select)
  expect(plan.activate).toEqual(activate)
})

it.each([
  [{ iterm_session_id: `w0t1p0:${uuid}` }, 'com.googlecode.iterm2', [uuid, 'unique id', 'select targetTab', 'select targetSession', 'select targetWindow', 'activate']],
  [terminal, 'com.apple.Terminal', [tty, 'set selected of targetTab to true', 'set index of targetWindow to 1', 'activate']],
  [{ term_program: 'ghostty', tty }, 'com.mitchellh.ghostty', [tty, 'focus targetTerminal']],
] as const)('matches the locator and raises the exact tab or pane in AppleScript', (position, bundle, statements) => {
  const plan = terminalFocusPlan(position)
  expect(plan).toMatchObject({ selectsApp: true, activate: app(bundle), select: [{ command: '/usr/bin/osascript', expect: 'focused' }] })
  const [flag, script] = plan.select[0]!.args
  expect(flag).toBe('-e')
  expect(script).toContain(`tell application id "${bundle}"`)
  for (const statement of statements) expect(script).toContain(statement)
  expect(script).toContain('return "missing"')
})

const current = { machine: 'here', origin_agent: null, cwd: '/work', terminal_json: JSON.stringify(terminal) }
it.each([
  [current, { ok: true, stdout: 'focused\n' }, { ok: true, method: 'exact' }, 1],
  [current, { ok: false, stderr: 'AppleEvents (-1743)' }, { ok: true, method: 'app', reason: 'automation_denied' }, 2],
  [current, { ok: true, stdout: 'missing\n' }, { ok: true, method: 'app', reason: 'not_found' }, 2],
  [{ ...current, machine: 'away' }, { ok: true }, { ok: false, method: 'none', reason: 'other_machine' }, 0],
  [{ ...current, origin_agent: 'paired-peer' }, { ok: true }, { ok: false, method: 'none', reason: 'other_machine' }, 0],
  [{ ...current, terminal_json: null }, { ok: true }, { ok: false, method: 'none', reason: 'no_location' }, 0],
  [null, { ok: true }, { ok: false, method: 'none', reason: 'not_found' }, 0],
] as const)('executes only for a local session and reports exact vs fallback', async (session, first, result, calls) => {
  const run = vi.fn().mockResolvedValueOnce(first).mockResolvedValue({ ok: true })
  const focus = makeTerminalFocus({ platform: 'darwin', machine: 'here', lookup: () => session, run })
  await expect(focus.focus('session')).resolves.toEqual(result)
  expect(run).toHaveBeenCalledTimes(calls)
  if (calls) expect(run.mock.calls[0]?.[1]).toBe(8000)
  if (calls === 2) expect(run).toHaveBeenLastCalledWith(app(terminal.bundle_id), 1500)
})

it('uses a verified directory only for editor activation and surfaces failure', async () => {
  const editor = 'com.microsoft.VSCode'
  const run = vi.fn().mockRejectedValue(Error('unavailable'))
  const isDirectory = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
  const focus = makeTerminalFocus({
    platform: 'darwin', machine: 'here', lookup: () => ({ ...current, terminal_json: JSON.stringify({ bundle_id: editor }) }),
    run, isDirectory,
  })
  await expect(focus.focus('session')).resolves.toMatchObject({ method: 'none', reason: 'app_unavailable' })
  expect(run).toHaveBeenLastCalledWith(app(editor, '/work'), 1500)
  await focus.focus('session')
  expect(run).toHaveBeenLastCalledWith(app(editor), 1500)
})

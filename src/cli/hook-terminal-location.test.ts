import { expect, it, vi } from 'vitest'
import { hookTerminalLocation } from './hook'
import { hookTerminalEnvironment } from './hook-terminal-location'
import { CliEventRequest } from '@wechat-cc/protocol/desktop-api'

const id = '12AB5678-1234-1234-1234-123456789abc'
const env = {
  __CFBundleIdentifier: 'com.googlecode.iterm2', TERM_PROGRAM: 'iTerm.app',
  ITERM_SESSION_ID: `w1t2p3:${id}`, TERM_SESSION_ID: 'w1t2p3:term-id',
  TMUX: '/tmp/tmux-501/default,10,1', TMUX_PANE: '%12',
  WEZTERM_PANE: '13', WEZTERM_UNIX_SOCKET: '/tmp/wez.socket',
  KITTY_WINDOW_ID: '14', KITTY_LISTEN_ON: 'unix:/tmp/kitty.socket',
}

it.each(['linux', 'win32'] as const)('omits location on %s', async platform => {
  const probe = vi.fn()
  expect(await hookTerminalLocation({ env, platform, probe })).toBeUndefined()
  expect(probe).not.toHaveBeenCalled()
})

it('takes only validated values from the environment without a process probe for exact identifiers', async () => {
  const probe = vi.fn()
  expect(await hookTerminalLocation({ env, platform: 'darwin', probe })).toEqual({
    bundle_id: env.__CFBundleIdentifier, term_program: env.TERM_PROGRAM, iterm_session_id: env.ITERM_SESSION_ID,
    term_session_id: env.TERM_SESSION_ID, tmux: env.TMUX, tmux_pane: env.TMUX_PANE,
    wezterm_pane: env.WEZTERM_PANE, wezterm_socket: env.WEZTERM_UNIX_SOCKET,
    kitty_window_id: env.KITTY_WINDOW_ID, kitty_socket: env.KITTY_LISTEN_ON,
  })
  expect(probe).not.toHaveBeenCalled()
  expect(hookTerminalEnvironment({ ...env, TMUX_PANE: '%12\n', TMUX: 'bad', TERM_PROGRAM: 'x'.repeat(51),
    __CFBundleIdentifier: '-a', TERM_SESSION_ID: '"', ITERM_SESSION_ID: `w1t2p3:${id}"`, KITTY_LISTEN_ON: 'tcp:host:42',
  }, 'darwin')).toEqual({ wezterm_pane: '13', wezterm_socket: '/tmp/wez.socket', kitty_window_id: '14' })
})

it('walks past a detached parent for Terminal.app and only accepts a tty device', async () => {
  const probe = vi.fn().mockResolvedValueOnce('90 ??\n').mockResolvedValueOnce('7 ttys004\n')
  const options = { env: { TERM_PROGRAM: 'Apple_Terminal' }, platform: 'darwin' as const, ppid: 101, probe }
  expect(await hookTerminalLocation(options)).toEqual({ term_program: 'Apple_Terminal', tty: '/dev/ttys004' })
  expect(probe.mock.calls.map(call => call[0])).toEqual([101, 90])
  expect(probe.mock.calls.every(call => call[1] > 0 && call[1] <= 35)).toBe(true)
})

it('bounds an unresponsive probe and still emits the app identity', async () => {
  vi.useFakeTimers()
  try {
    const env = { TERM_PROGRAM: 'ghostty' }
    const pending = hookTerminalLocation({ env, platform: 'darwin', ppid: 42, probe: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(35)
    await expect(pending).resolves.toEqual({ term_program: 'ghostty' })
  } finally { vi.useRealTimers() }
})

it('allows old hooks and ignores invalid location fields without dropping the event', () => {
  const event = { source: 'claude', kind: 'prompt', session_id: 'old', cwd: '/work' }
  expect(CliEventRequest.parse(event)).toEqual(event)
  expect(CliEventRequest.parse({ ...event, terminal: { tty: '/dev/ttys02', bundle_id: '"', secret: 'ignored' } }))
    .toEqual({ ...event, terminal: { tty: '/dev/ttys02' } })
})

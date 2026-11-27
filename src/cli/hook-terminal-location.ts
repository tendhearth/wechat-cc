import { terminalBundle, terminalLocation } from '../../packages/protocol/src/terminal-location'

export function hookTerminalEnvironment(env = process.env, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'darwin') return undefined
  return terminalLocation({
    bundle_id: env.__CFBundleIdentifier,
    term_program: env.TERM_PROGRAM,
    iterm_session_id: env.ITERM_SESSION_ID,
    term_session_id: env.TERM_SESSION_ID,
    tmux: env.TMUX,
    tmux_pane: env.TMUX_PANE,
    wezterm_pane: env.WEZTERM_PANE,
    wezterm_socket: env.WEZTERM_UNIX_SOCKET,
    kitty_window_id: env.KITTY_WINDOW_ID,
    kitty_socket: env.KITTY_LISTEN_ON,
  })
}

// A tmux pane's tty belongs to tmux, not the enclosing app tab.
export function needsTerminalTty(location: NonNullable<ReturnType<typeof hookTerminalEnvironment>>): boolean {
  if (location.tmux && location.tmux_pane) return false
  const bundle = terminalBundle(location)
  return bundle === 'com.apple.Terminal' || bundle === 'com.mitchellh.ghostty'
}

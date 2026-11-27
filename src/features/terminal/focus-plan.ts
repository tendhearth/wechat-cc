import { terminalBundle, terminalLocation } from '@wechat-cc/protocol'

export interface FocusCommand {
  command: string
  args: string[]
  env?: Record<string, string>
  /** AppleScript returns a marker only if it actually found the pane or tab. */
  expect?: string
}
export interface FocusPlan {
  select: FocusCommand[]
  activate?: FocusCommand
  /** The selection command already brings the application to the foreground. */
  selectsApp?: true
}

const osascript = (script: string): FocusCommand => ({ command: '/usr/bin/osascript', args: ['-e', script], expect: 'focused' })
const app = (bundle: string, directory?: string): FocusCommand => ({
  command: '/usr/bin/open', args: ['-b', bundle, ...(directory ? [directory] : [])],
})

export function terminalFocusPlan(raw: unknown, directory?: string): FocusPlan {
  const location = terminalLocation(raw)
  if (!location) return { select: [] }
  const bundle = terminalBundle(location)
  const editor = bundle === 'com.microsoft.VSCode' || bundle === 'com.todesktop.230313mzl4w4u92'
  const activate = bundle ? app(bundle, editor && directory?.startsWith('/') && !directory.includes('\0') ? directory : undefined) : undefined
  const select: FocusCommand[] = []
  if (location.tmux && location.tmux_pane) {
    const socket = location.tmux.split(',')[0]!
    for (const action of ['select-window', 'select-pane']) {
      select.push({ command: 'tmux', args: ['-S', socket, action, '-t', location.tmux_pane] })
    }
  }
  const plan = { select, activate }
  if (bundle === 'com.googlecode.iterm2' && location.iterm_session_id) {
    const id = location.iterm_session_id.split(':').at(-1)!
    select.push(osascript(`tell application id "com.googlecode.iterm2"
  repeat with targetWindow in windows
    repeat with targetTab in tabs of targetWindow
      repeat with targetSession in sessions of targetTab
        if unique id of targetSession is "${id}" then
          select targetTab
          select targetSession
          select targetWindow
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing"`))
    return { ...plan, selectsApp: true }
  }
  if (bundle === 'com.apple.Terminal' && location.tty && !select.length) {
    select.push(osascript(`tell application id "com.apple.Terminal"
  repeat with targetWindow in windows
    repeat with targetTab in tabs of targetWindow
      if tty of targetTab is "${location.tty}" then
        set selected of targetTab to true
        set index of targetWindow to 1
        activate
        return "focused"
      end if
    end repeat
  end repeat
end tell
return "missing"`))
    return { ...plan, selectsApp: true }
  }
  if (bundle === 'com.mitchellh.ghostty' && location.tty && !select.length) {
    select.push(osascript(`tell application id "com.mitchellh.ghostty"
  repeat with targetTerminal in terminals
    if tty of targetTerminal is "${location.tty}" then
      focus targetTerminal
      return "focused"
    end if
  end repeat
end tell
return "missing"`))
    return { ...plan, selectsApp: true }
  }
  if (bundle === 'com.github.wez.wezterm' && location.wezterm_pane) {
    select.push({
      command: 'wezterm',
      args: ['cli', 'activate-pane', '--pane-id', location.wezterm_pane],
      ...(location.wezterm_socket ? { env: { WEZTERM_UNIX_SOCKET: location.wezterm_socket } } : {}),
    })
  }
  if (bundle === 'net.kovidgoyal.kitty' && location.kitty_window_id && location.kitty_socket) {
    select.push({ command: 'kitten', args: ['@', '--to', location.kitty_socket, 'focus-window', '--match', `id:${location.kitty_window_id}`] })
  }
  return plan
}

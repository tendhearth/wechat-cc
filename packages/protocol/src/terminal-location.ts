import z from 'zod'

const field = (pattern: RegExp, max: number) =>
  z.string().max(max).regex(pattern).refine(value => !/[\r\n]/.test(value)).optional().catch(undefined)
const uuid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
const socket = '/[A-Za-z0-9_./ -]+'

export const TerminalLocationSchema = z.object({
  bundle_id: field(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 200),
  term_program: field(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 50),
  iterm_session_id: field(new RegExp(`^(?:w\\d+t\\d+p\\d+:)?${uuid}$`), 80),
  term_session_id: field(/^[A-Za-z0-9][A-Za-z0-9_:-]*$/, 100),
  tmux: field(new RegExp(`^${socket},[0-9]{1,10},[0-9]{1,10}$`), 256),
  tmux_pane: field(/^%[0-9]{1,10}$/, 11),
  wezterm_pane: field(/^[0-9]{1,10}$/, 10),
  wezterm_socket: field(new RegExp(`^${socket}$`), 256),
  kitty_window_id: field(/^[0-9]{1,10}$/, 10),
  kitty_socket: field(new RegExp(`^unix:${socket}$`), 256),
  tty: field(/^\/dev\/ttys[0-9]{1,8}$/, 17),
})

export type TerminalLocation = z.infer<typeof TerminalLocationSchema>

export function terminalLocation(value: unknown): TerminalLocation | undefined {
  const result = TerminalLocationSchema.safeParse(value)
  if (!result.success) return undefined
  const location = result.data
  for (const key of Object.keys(location) as Array<keyof TerminalLocation>) {
    if (location[key] === undefined) delete location[key]
  }
  return Object.keys(location).length ? location : undefined
}

export const terminalLocationWire = z.unknown().transform(terminalLocation).optional()

export function terminalBundle(location: TerminalLocation): string | undefined {
  if (location.bundle_id) return location.bundle_id
  switch (location.term_program) {
    case 'Apple_Terminal': return 'com.apple.Terminal'
    case 'iTerm.app': return 'com.googlecode.iterm2'
    case 'ghostty': return 'com.mitchellh.ghostty'
    case 'WezTerm': return 'com.github.wez.wezterm'
    case 'kitty': return 'net.kovidgoyal.kitty'
    case 'WarpTerminal': return 'dev.warp.Warp-Stable'
  }
  if (location.iterm_session_id) return 'com.googlecode.iterm2'
  if (location.wezterm_pane) return 'com.github.wez.wezterm'
  if (location.kitty_window_id) return 'net.kovidgoyal.kitty'
  return undefined
}

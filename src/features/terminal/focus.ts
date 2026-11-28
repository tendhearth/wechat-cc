import { execFile } from 'node:child_process'
import { statSync, accessSync, constants } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { terminalLocation, type TerminalLocation } from '@wechat-cc/protocol'
import type { CliFocusResult } from '@wechat-cc/protocol/desktop-api'
import type { CliSessionRow } from '../../ports/cli-session'
import { terminalFocusPlan, type FocusCommand } from './focus-plan'

type FocusSession = Pick<CliSessionRow, 'machine' | 'cwd' | 'terminal_json' | 'origin_agent'>
interface FocusDeps {
  lookup: (id: string) => FocusSession | null
  run?: (command: FocusCommand, timeout: number) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>
  platform?: NodeJS.Platform
  machine?: string
  isDirectory?: (path: string) => boolean
}

const bundledTools: Record<string, string> = {
  wezterm: 'WezTerm.app/Contents/MacOS/wezterm',
  kitten: 'kitty.app/Contents/MacOS/kitten',
}
function executable(command: string): string {
  if (isAbsolute(command)) return command
  const bundle = bundledTools[command]
  const paths = bundle ? [join('/Applications', bundle), join(homedir(), 'Applications', bundle)] : []
  paths.push(join('/opt/homebrew/bin', command), join('/usr/local/bin', command), join('/opt/local/bin', command))
  for (const candidate of paths) {
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* Try the next installation. */ }
  }
  return command
}

const runCommand: NonNullable<FocusDeps['run']> = ({ command, args, env }, timeout) => new Promise(resolve => {
  execFile(executable(command), args, {
    timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }))
})

function locationOf(session: FocusSession): TerminalLocation | undefined {
  try { return session.terminal_json ? terminalLocation(JSON.parse(session.terminal_json)) : undefined }
  catch { return undefined }
}

const isDirectory = (path: string) => isAbsolute(path) && (statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false)

export function makeTerminalFocus(deps: FocusDeps) {
  const machine = deps.machine ?? hostname()
  const supported = (deps.platform ?? process.platform) === 'darwin'
  const local = (session: FocusSession) => session.machine === machine && !session.origin_agent
  const run = deps.run ?? runCommand
  const none = (reason: NonNullable<CliFocusResult['reason']>): CliFocusResult => ({ ok: false, method: 'none', reason })
  const execute = async (command: FocusCommand) => {
    try { return await run(command, command.expect ? 8_000 : 1_500) }
    catch { return { ok: false } }
  }

  return {
    metadata(id: string) {
      const session = deps.lookup(id)
      const terminal = session && locationOf(session)
      if (!terminal) return {}
      const plan = terminalFocusPlan(terminal)
      const canFocus = supported && local(session) && (plan.select.length > 0 || !!plan.activate)
      return { terminal, ...(canFocus ? { can_focus: true as const } : {}) }
    },
    async focus(id: string): Promise<CliFocusResult> {
      const session = deps.lookup(id)
      if (!session) return none('not_found')
      if (!local(session)) return none('other_machine')
      const terminal = locationOf(session)
      if (!supported || !terminal) return none('no_location')
      const plan = terminalFocusPlan(terminal, session.cwd)
      const directory = plan.activate?.args[2]
      if (directory) {
        let exists = false
        try { exists = (deps.isDirectory ?? isDirectory)(directory) }
        catch { /* An unavailable directory still permits opening the app. */ }
        if (!exists) plan.activate?.args.pop()
      }
      let reason: CliFocusResult['reason']
      for (const command of plan.select) {
        const result = await execute(command)
        if (result.ok && (!command.expect || result.stdout?.trim() === command.expect)) continue
        reason = command.expect && /(?:^|\D)-1743(?:\D|$)/.test(result.stderr ?? '') ? 'automation_denied' : 'not_found'
        break
      }
      const selected = !reason && plan.select.length > 0
      if (selected && (plan.selectsApp || !plan.activate)) return { ok: true, method: 'exact' }
      if (!plan.activate) return none(reason ?? 'no_location')
      if (!(await execute(plan.activate)).ok) return none(reason === 'automation_denied' ? reason : 'app_unavailable')
      return { ok: true, method: selected ? 'exact' : 'app', ...(reason ? { reason } : {}) }
    },
  }
}

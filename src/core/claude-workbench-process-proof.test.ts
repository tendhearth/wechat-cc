import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const os = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => os)
import { ownClaudeWorkbenchProcess } from './claude-workbench-process'

const root = 41001, descendant = 41002
const before = `74461 62372 62358 ?E 501 Thu Oct 8 12:08:11 2026\n400 1 400 S -2 Mon Oct 5 03:33:00 2026\n${root} 40000 ${root} S 501 Thu Oct  8 11:00:00 2026\n${descendant} ${root} ${descendant} S 501 Thu Oct  8 11:00:01 2026`
const zombie = `${descendant} 1 ${descendant} Z 501 Thu Oct  8 11:00:01 2026`
const denied = () => Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
const absent = () => Object.assign(new Error('No such process'), { code: 'ESRCH' })

afterEach(() => vi.restoreAllMocks())

// OS-boundary faults model the observed Darwin Z + EPERM response. The actual
// owner still freezes, captures ancestry, signals and decides the close result.
function closingWith(rows: string | Error, options: { deniedKill?: boolean; pidProbeSucceeds?: boolean; deniedStop?: boolean; prepareRows?: string } = {}) {
  let closing = false
  const child = Object.assign(new EventEmitter(), { pid: root, stdin: { end() {} }, stderr: new EventEmitter() })
  os.spawn.mockReturnValue(child)
  os.execFileSync.mockImplementation(() => {
    if (!closing) return options.prepareRows ?? before
    if (rows instanceof Error) throw rows
    return rows
  })
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (signal === 'SIGSTOP' && target === -descendant && options.deniedStop) throw denied()
    if (signal === 'SIGKILL') {
      closing = true; child.emit('exit', null, 'SIGKILL')
      if (target === -descendant && options.deniedKill) throw denied()
      return true
    }
    if (!closing || signal !== 0) return true
    if (Math.abs(target) === root) throw absent()
    if (target === descendant && options.pidProbeSucceeds) return true
    throw denied()
  })
  const owner = ownClaudeWorkbenchProcess(undefined)
  owner.spawn({ command: 'fixture', args: [], cwd: '/tmp', env: {}, signal: new AbortController().signal })
  const deadline = Date.now() + 100
  try { owner.prepareClose(deadline) } catch (error) { return Promise.reject(error) }
  return owner.close(deadline)
}

describe('Claude owned close proof under Darwin EPERM', () => {
  it('confirms a captured zombie despite denied group probes and a successful PID probe', async () => {
    await expect(closingWith(zombie, { pidProbeSucceeds: true })).resolves.toBeUndefined()
  })
  it('confirms captured zombies when SIGKILL itself returns EPERM', async () => {
    await expect(closingWith(zombie, { deniedKill: true })).resolves.toBeUndefined()
  })
  it('captures an already-zombie descendant when SIGSTOP returns EPERM', async () => {
    await expect(closingWith(zombie, { deniedStop: true, prepareRows: before.replace(`${descendant} S`, `${descendant} Z`) })).resolves.toBeUndefined()
  })
  it('rejects denied SIGSTOP for an owned live descendant', async () => {
    await expect(closingWith(zombie, { deniedStop: true })).rejects.toThrow()
  })
  it('rejects denied SIGSTOP with a foreign member in the descendant group', async () => {
    await expect(closingWith(zombie, { deniedStop: true, prepareRows: before.replace(`${descendant} S`, `${descendant} Z`) + `\n41003 1 ${descendant} Z 501 Thu Oct 8 11:00:02 2026` })).rejects.toThrow()
  })
  it.each([
    ['live process', zombie.replace(' Z ', ' S ')],
    ['unknown process state', zombie.replace(' Z ', ' ?E ')],
    ['mixed zombie and live group', `${zombie}\n41003 1 ${descendant} S 501 Thu Oct  8 11:00:02 2026`],
    ['foreign zombie in group', `${zombie}\n41003 1 ${descendant} Z 501 Thu Oct  8 11:00:02 2026`],
    ['changed owner', zombie.replace('501', '502')],
    ['recycled PID', zombie.replace('11:00:01', '11:01:02')],
    ['moved process group', zombie.replace(`${descendant} Z`, '42000 Z')],
    ['missing row with denied probe', `${root} 1 ${root} Z 501 Thu Oct  8 11:00:00 2026`],
    ['empty table', ''],
    ['malformed row', `${zombie}\ninvalid`],
    ['duplicate PID', `${zombie}\n${zombie}`],
    ['unavailable table', new Error('ps unavailable')],
  ])('does not confirm close with %s', async (_name, rows) => {
    await expect(closingWith(rows)).rejects.toThrow()
  })
})

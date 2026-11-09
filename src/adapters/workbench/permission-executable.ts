import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const PERMISSION_SYSTEM_DIRS: ReadonlySet<string> = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin'])
const NATIVE_MAGIC = new Set(['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
export interface PermissionExecutable { path: string; identity: string[]; sha256: string }
/** Adapter-owned execution contract: direct spawn, exact environment, no shell
 * profiles, functions, aliases or dynamic loader variables. Never client input. */
export interface PermissionExecutionEnvironment { kind: 'direct'; env: { PATH: string } }
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs].map(String)
const writable = (path: string) => { try { accessSync(path, constants.W_OK); return true } catch { return false } }

/** No ambient daemon PATH guess. An adapter may supply a PATH only when it is
 * the actual execution environment; boolean CLI bridges currently cannot do
 * that, so they are one-shot only, including absolute names: shell functions
 * can even shadow /bin/ls. Windows waits for protected ACL verification. */
export function inspectPermissionExecutable(head: string, cwd: string, environment?: PermissionExecutionEnvironment): PermissionExecutable | null {
  if (process.platform === 'win32' || environment?.kind !== 'direct' || !environment.env || typeof environment.env.PATH !== 'string' || Object.keys(environment.env).some(k => k !== 'PATH')) return null
  const executionPath = environment.env.PATH
  let candidate: string | undefined
  if (isAbsolute(head)) candidate = head
  else {
    if (head.includes('/') || head.includes('\\') || !executionPath || executionPath.length > 4096) return null
    const directories = executionPath.split(':').map(p => resolve(cwd, p || '.'))
    // A writable search directory could acquire a new command between lookup
    // and execution, even if today's lookup falls through to /bin.
    if (directories.some(p => !PERMISSION_SYSTEM_DIRS.has(p))) return null
    for (const directory of directories) {
      const path = join(directory, head)
      try { accessSync(path, constants.X_OK); candidate = path; break } catch { /* shell lookup continues */ }
    }
  }
  if (!candidate || !PERMISSION_SYSTEM_DIRS.has(dirname(resolve(candidate)))) return null
  try {
    const path = realpathSync.native(candidate)
    if (!PERMISSION_SYSTEM_DIRS.has(dirname(path))) return null
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const info = statSync(parent)
      if (info.uid !== 0 || writable(parent)) return null
      if (parent === dirname(parent)) break
    }
    const before = statSync(path, { bigint: true })
    if (!before.isFile() || before.uid !== 0n || before.size > 32n * 1024n * 1024n || writable(path)) return null
    accessSync(path, constants.X_OK)
    const bytes = readFileSync(path), after = statSync(path, { bigint: true })
    if (!NATIVE_MAGIC.has(bytes.subarray(0, 4).toString('hex')) || identity(before).join(':') !== identity(after).join(':')) return null
    return { path, identity: identity(after), sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch { return null }
}

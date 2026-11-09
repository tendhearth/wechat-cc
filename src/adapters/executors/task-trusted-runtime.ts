import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { findOnPath } from '../../lib/util'
import { readAnchoredFile } from '../workbench/anchored-fs'
import { TASK_UPTIME_PRELOAD, TASK_SUBPROCESS_PRELOAD } from './task-uptime'

const fingerprint = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex')
let runtime: { root: string; preload: string; files: Map<string, string>; key: string } | undefined
const owned: string[] = []
process.once('exit', () => { for (const root of owned) try { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }) } catch { /* OS temp cleanup after a crash. */ } })
/** This directory is outside workspace-write roots, including the task's TMPDIR.
 * chmod is defense in depth, NOT same-UID isolation: the OS sandbox is the write
 * boundary. Never pass this environment to any unsandboxed host process. */
export function trustedTaskRuntime(workspace: string): { preload: string; bin: string } {
  const binaries: [string, string][] = []
  if (process.platform !== 'win32') for (const name of ['bun', 'node']) {
    const binary = findOnPath(name)
    if (binary) binaries.push([name, realpathSync(binary)])
  }
  const key = JSON.stringify(binaries)
  // Never rewrite a bundle used by active tasks. A toolchain upgrade gets a
  // fresh immutable directory; all old bundles stay readable until CC exits.
  if (!runtime || runtime.key !== key) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-trusted-runtime-')))
    const contents = TASK_UPTIME_PRELOAD + TASK_SUBPROCESS_PRELOAD
    const preload = `uptime-${fingerprint(contents)}.cjs`, files = new Map([[preload, contents]])
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    for (const [name, binary] of binaries) {
      files.set(name, `#!/bin/sh\nexec ${quote(binary)} --require ${quote(join(root, preload))} "$@"\n`)
    }
    try {
      for (const [name, value] of files) writeFileSync(join(root, name), value, { flag: 'wx', mode: name === preload ? 0o400 : 0o500 })
      chmodSync(root, 0o500)
      runtime = { root, preload, files, key }
      owned.push(root)
    } catch (error) { rmSync(root, { recursive: true, force: true }); throw error }
  }
  const rel = relative(workspace, runtime.root)
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw Error('invalid_task_environment')
  const errors = { path: 'invalid_task_environment', size: 'invalid_task_environment', changed: 'invalid_task_environment' }
  for (const [name, contents] of runtime.files) {
    if (fingerprint(readAnchoredFile(runtime.root, name, 16 * 1024, errors)) !== fingerprint(contents)) throw Error('invalid_task_environment')
  }
  return { preload: join(runtime.root, runtime.preload), bin: runtime.root }
}

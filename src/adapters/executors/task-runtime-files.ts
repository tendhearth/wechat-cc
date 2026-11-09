import { closeSync, constants, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readAnchoredFile, verifyChain } from '../workbench/anchored-fs'

/** Reserve once; a repository-supplied or modified preload/shim is never run. */
export function taskRuntimeFile(root: string, parts: string[], contents: string, mode = 0o600, refresh = false): string {
  verifyChain(root, parts.slice(0, -1), 'invalid_task_environment', { leafDirectory: true })
  const path = join(root, ...parts)
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { writeSync(fd, contents) } finally { closeSync(fd) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw Error('invalid_task_environment') }
  const errors = { path: 'invalid_task_environment', size: 'invalid_task_environment', changed: 'invalid_task_environment' }
  if (readAnchoredFile(root, parts.join('/'), 16 * 1024, errors).toString() !== contents) {
    if (!refresh) throw Error('invalid_task_environment')
    // Task startup holds its workspace reservation. Replace only the directory
    // entry with a fresh CC-owned inode; never truncate a possible hardlink.
    const temporary = join(root, ...parts.slice(0, -1), `.runtime-${randomUUID()}`)
    let reserved = false
    try {
      verifyChain(root, parts.slice(0, -1), 'invalid_task_environment', { leafDirectory: true })
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
      reserved = true
      try { writeSync(fd, contents) } finally { closeSync(fd) }
      verifyChain(root, parts, 'invalid_task_environment')
      renameSync(temporary, path); reserved = false
      if (readAnchoredFile(root, parts.join('/'), 16 * 1024, errors).toString() !== contents) throw Error('invalid_task_environment')
    } finally { if (reserved) unlinkSync(temporary) }
  }
  return path
}

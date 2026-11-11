import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { taskRuntimeFile } from './task-runtime-files'
it.skipIf(process.platform === 'win32')('refreshes an owned runtime shim after a runtime upgrade', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-runtime-shim-')))
  try {
    mkdirSync(join(root, 'bin'))
    const path = taskRuntimeFile(root, ['bin', 'runtime'], '#!/bin/sh\necho first\n', 0o700)
    expect(execFileSync(path, [], { encoding: 'utf8' }).trim()).toBe('first')
    taskRuntimeFile(root, ['bin', 'runtime'], '#!/bin/sh\necho upgraded\n', 0o700, true)
    expect(execFileSync(path, [], { encoding: 'utf8' }).trim()).toBe('upgraded')
  } finally { removeTempDir(root) }
})
it('never refreshes through an external symlink', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-runtime-link-')))
  try {
    mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'outside'), 'keep')
    symlinkSync(join(root, 'outside'), join(root, 'bin/runtime'), 'file')
    expect(() => taskRuntimeFile(root, ['bin', 'runtime'], 'replace', 0o700, true)).toThrow('invalid_task_environment')
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('keep')
  } finally { removeTempDir(root) }
})

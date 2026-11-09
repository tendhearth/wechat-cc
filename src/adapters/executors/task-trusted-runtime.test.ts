import { execFileSync } from 'node:child_process'
import * as util from '../../lib/util'
import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { trustedTaskRuntime } from './task-trusted-runtime'
import { removeTempDir } from '../../lib/test-temp'

it('refuses changed shim fingerprints and any workspace containing the trusted runtime',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-runtime-fingerprint-')))
  try {
    const runtime=trustedTaskRuntime(root),original=readFileSync(runtime.preload)
    expect(basename(runtime.preload)).toBe(`uptime-${createHash('sha256').update(original).digest('hex')}.cjs`)
    // Simulate host-side corruption. A sandbox task cannot perform these writes.
    chmodSync(runtime.preload,0o600)
    try {
      writeFileSync(runtime.preload,'untrusted replacement')
      expect(()=>trustedTaskRuntime(root)).toThrow('invalid_task_environment')
    } finally { writeFileSync(runtime.preload,original);chmodSync(runtime.preload,0o400) }
    expect(trustedTaskRuntime(root)).toEqual(runtime)
    expect(()=>trustedTaskRuntime(dirname(runtime.bin))).toThrow('invalid_task_environment')
  } finally {removeTempDir(root)}
})

it.skipIf(process.platform==='win32')('refreshes immutable wrappers after a host runtime upgrade and retains active bundles',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-runtime-upgrade-'))),workspace=join(root,'task')
  mkdirSync(workspace)
  const first=join(root,'node-v1'),second=join(root,'node-v2'),entry=join(root,'node')
  writeFileSync(first,'#!/bin/sh\nprintf first\n',{mode:0o700});writeFileSync(second,'#!/bin/sh\nprintf second\n',{mode:0o700})
  symlinkSync(first,entry)
  const lookup=vi.spyOn(util,'findOnPath').mockImplementation(name=>name==='node'?entry:null)
  try {
    const old=trustedTaskRuntime(workspace)
    expect(readFileSync(join(old.bin,'node'),'utf8')).toContain(first)
    unlinkSync(entry);symlinkSync(second,entry);unlinkSync(first)
    const next=trustedTaskRuntime(workspace)
    expect(next.bin).not.toBe(old.bin)
    expect(readFileSync(old.preload).length).toBeGreaterThan(0)
    expect(execFileSync(join(next.bin,'node'),[],{encoding:'utf8'})).toBe('second')
    expect(trustedTaskRuntime(workspace)).toEqual(next)
  } finally {lookup.mockRestore();removeTempDir(root)}
})

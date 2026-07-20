import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCursorStore } from './mailbox-cursor-store'

describe('makeCursorStore', () => {
  it('persists a per-relay cursor across a fresh store instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxc-'))
    makeCursorStore(dir).set('r', 5)
    expect(makeCursorStore(dir).get('r')).toBe(5)
  })

  it('an unknown relay reads as 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbxc-'))
    expect(makeCursorStore(dir).get('never-seen')).toBe(0)
  })

  it('writes the cursor file with mode 0600', () => {
    if (process.platform === 'win32') return  // chmod semantics differ on Windows
    const dir = mkdtempSync(join(tmpdir(), 'mbxc-'))
    makeCursorStore(dir).set('r', 1)
    const st = statSync(join(dir, 'mailbox-cursors.json'))
    expect(st.mode & 0o777).toBe(0o600)
  })
})

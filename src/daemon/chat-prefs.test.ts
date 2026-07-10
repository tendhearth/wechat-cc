import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeChatPrefs } from './chat-prefs'

describe('chat-prefs', () => {
  it('returns {} for an unknown chat (split undefined ⇒ caller treats as ON)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      expect(makeChatPrefs(dir).get('nobody')).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('set() patches, persists write-through, and get() round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      const prefs = makeChatPrefs(dir)
      expect(prefs.set('c1', { split: false })).toEqual({ split: false })
      expect(prefs.get('c1')).toEqual({ split: false })
      // write-through: a FRESH instance reads it back from disk
      expect(makeChatPrefs(dir).get('c1')).toEqual({ split: false })
      expect(readFileSync(join(dir, 'chat_prefs.json'), 'utf8')).toContain('c1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('survives a corrupt value (falls back to {})', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      const prefs = makeChatPrefs(dir)
      prefs.set('c1', { split: true })
      // corrupt via the injectable raw store seam
      const prefs2 = makeChatPrefs(dir, { store: { get: () => 'not json', set: () => {}, delete: () => {}, all: () => ({}), flush: async () => {} } })
      expect(prefs2.get('c1')).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('list() is empty on a fresh store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      expect(makeChatPrefs(dir).list()).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('list() contains chat ids after set()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      const prefs = makeChatPrefs(dir)
      prefs.set('c1', { split: false })
      prefs.set('c2', { care: 'high' })
      expect(prefs.list().sort()).toEqual(['c1', 'c2'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('care round-trips and merges alongside split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
    try {
      const prefs = makeChatPrefs(dir)
      prefs.set('c1', { split: false })
      prefs.set('c1', { care: 'high' })
      expect(prefs.get('c1')).toEqual({ split: false, care: 'high' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

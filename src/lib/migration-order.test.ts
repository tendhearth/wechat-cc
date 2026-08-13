import { expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { migrations } from './db'

// Why this test exists — issue #79.
//
// PRAGMA user_version is just a count. It records how many migrations ran,
// never which ones, so position IS the contract: v21 means whatever the array's
// 21st entry was when that database last upgraded. db.ts says so at the top
// ("NEVER reorder; NEVER edit a published migration in place"), but nothing
// enforced it.
//
// The customer-review branch (45a52114) was cut from a tree ending at v18 and
// numbered its three migrations v19/v20/v21, unaware mainline had already
// published v19-v25. Merging renumbered them to v26-v28 — a reorder from the
// perspective of any database that had run the branch build, which then read
// its own "21" against the new meaning and crashed on boot with
// `no such table: social_relay`. Nobody noticed until a user upgraded.
//
// This guard pins the schema each released version produces. A branch cut from
// a stale base, an insertion, a swap, or an in-place edit of a published
// migration all change one of these fingerprints and fail here — in CI, on the
// branch, instead of on a user's machine after release.
//
// It fingerprints the RESULTING SCHEMA rather than the function source on
// purpose: rewording a comment inside a migration is harmless and must not
// trip the guard (v1-v21 genuinely differ that way between desktop-v1.3.2 and
// today), while any change to what a migration builds is exactly what we want
// to catch.

/**
 * Canonical text of the schema produced by applying migrations 1..n.
 *
 * Normalisation earns its keep here. Identifier quoting is NOT stable across
 * SQLite builds: `ALTER TABLE ... RENAME TO` (v27 rebuilds the customer-review
 * tables that way) rewrites the stored CREATE statement, and different
 * versions quote the rewritten identifiers differently. bun links the system
 * libsqlite3 on macOS and its own build on Linux/Windows, so an un-normalised
 * hash agrees locally and disagrees in CI — which is exactly what happened on
 * the first attempt at this test. Stripping quotes and collapsing whitespace
 * leaves the parts we actually care about (columns, types, CHECK constraints,
 * indexes) fully covered.
 */
function canonicalSchema(n: number): string {
  const db = new Database(':memory:')
  try {
    for (let i = 0; i < n; i++) migrations[i]!(db)
    const rows = db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all()
    return rows
      .map(r => `${r.type} ${r.name} ${(r.sql ?? '').replace(/["`\[\]]/g, '').replace(/\s+/g, ' ').trim()}`)
      .join('\n')
  } finally {
    db.close()
  }
}

function fingerprint(n: number): string {
  return createHash('sha256').update(canonicalSchema(n)).digest('hex').slice(0, 16)
}

// Locked at v1.3.8 (2026-08-13). To add a migration: append it to the array,
// append its fingerprint here, and change nothing above. If an existing line
// has to change, you are editing published history — stop, and append instead.
const RELEASED: Record<number, string> = {
  18: '6a64b74e2bfb1af9',
  19: 'a315df0189d11928',
  20: '5c628ee5656bad9a',
  21: '77a63fa40373b821',
  25: '9a92ded4cc2a112e',
  28: '2be8a269c7c5d8e9',
}

it('every released migration still produces the schema it was published with', () => {
  const drifted: string[] = []
  for (const [version, expected] of Object.entries(RELEASED)) {
    const n = Number(version)
    if (n > migrations.length) continue
    const actual = fingerprint(n)
    // Dump the canonical text alongside the hash: a hash-only failure on a
    // platform you can't reproduce locally tells you nothing about WHAT moved.
    if (actual !== expected) {
      drifted.push(`v${n}: locked ${expected}, now ${actual}\n    canonical:\n      ${canonicalSchema(n).split('\n').join('\n      ')}`)
    }
  }
  expect(
    drifted,
    drifted.length === 0
      ? ''
      : `The schema at these already-released versions changed:\n  ${drifted.join('\n  ')}\n`
        + `user_version only records a COUNT, so existing databases resolve each version by `
        + `position — changing what a published version builds silently repoints it for every `
        + `user already past it (issue #79). Append a new migration instead. If you are merging `
        + `a branch that numbered its migrations from a stale base, renumber the branch's `
        + `migrations to the end of the array.`,
  ).toEqual([])
})

it('no released version is missing from the lock (a new migration must extend it)', () => {
  const locked = Object.keys(RELEASED).map(Number)
  expect(Math.max(...locked)).toBe(migrations.length)
})

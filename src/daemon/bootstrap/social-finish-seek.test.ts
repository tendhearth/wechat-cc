/**
 * social-finish-seek.test.ts — M1 regression: the wired finishSeek decision
 * must be authoritative + non-downgrading. Drives the REAL applyFinishSeek
 * (the exact function the bootstrap broker wiring calls) over real seek/echo
 * stores on an in-memory db.
 */
import { describe, it, expect } from 'vitest'
import { openDb } from '../../lib/db'
import { makeSeekStore } from '../../core/social-seek-store'
import { makeEchoStore } from '../../core/social-echo-store'
import { applyFinishSeek } from './social-finish-seek'

function setup() {
  const db = openDb({ path: ':memory:' })
  const seekStore = makeSeekStore(db)
  const echoStore = makeEchoStore(db)
  return { db, seekStore, echoStore }
}

describe('applyFinishSeek (M1)', () => {
  it('does NOT downgrade a seek the owner already connected (only bumps peersAsked)', () => {
    const { seekStore, echoStore } = setup()
    seekStore.create({ id: 's1', kind: 'seek', topic: '找个会修老相机的' })
    // Owner revealed an echo before forage finished → seek is `connected`.
    seekStore.update('s1', { status: 'connected' })
    // An echo row exists (so the naive "echoCount>0 → echoed" would fire).
    echoStore.create({ id: 's1:ccb', seekId: 's1', peerMasked: '小B', degree: 1, content: 'hi', peerAgentId: 'ccb' })

    applyFinishSeek({ seekStore, echoStore }, 's1', 3)

    const row = seekStore.get('s1')!
    expect(row.status).toBe('connected')   // NOT downgraded to echoed
    expect(row.peers_asked).toBe(3)        // peersAsked still updated
  })

  it('derives status from REAL echo rows on resume, ignoring the broker count', () => {
    const { seekStore, echoStore } = setup()
    seekStore.create({ id: 's2', kind: 'seek', topic: '找摄影搭子' })
    // Resume re-forage: an echo ROW already exists from the first pass even
    // though peers are now unreachable (broker would recompute echoCount==0).
    echoStore.create({ id: 's2:ccb', seekId: 's2', peerMasked: '第 1 度的某人', degree: 1, content: 'x', peerAgentId: 'ccb' })

    applyFinishSeek({ seekStore, echoStore }, 's2', 4)

    expect(seekStore.get('s2')!.status).toBe('echoed')   // real rows win → echoed, not closed
  })

  it('closes a seek with no echo rows', () => {
    const { seekStore, echoStore } = setup()
    seekStore.create({ id: 's3', kind: 'seek', topic: '没人回应' })

    applyFinishSeek({ seekStore, echoStore }, 's3', 5)

    const row = seekStore.get('s3')!
    expect(row.status).toBe('closed')
    expect(row.peers_asked).toBe(5)
  })
})

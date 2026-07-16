/**
 * social-finish-seek.ts — the terminal status decision for a foraged seek,
 * extracted from the bootstrap wiring so it's directly testable (mirrors the
 * delegate.ts / fallback-reply.ts sibling-helper pattern).
 *
 * The broker's forage passes a computed status, but the wiring must be
 * AUTHORITATIVE + NON-DOWNGRADING because two things the broker can't see:
 *   (a) the owner may have revealed an echo (seek already `connected`) before
 *       the background forage finished — that terminal state must NOT be
 *       overwritten back to `echoed`;
 *   (b) on a resume re-forage the peers may now be unreachable, so the broker
 *       recomputes echoCount==0 → 'closed' even though echo ROWS already exist.
 * So we ignore the broker-passed status and derive echoed/closed from the
 * persisted echoes (listForSeek is authoritative across resume).
 */
import type { EchoStore } from '../../core/social-echo-store'
import type { SeekStore } from '../../core/social-seek-store'

export interface FinishSeekStores {
  seekStore: Pick<SeekStore, 'get' | 'update'>
  echoStore: Pick<EchoStore, 'listForSeek'>
}

export function applyFinishSeek(stores: FinishSeekStores, intentId: string, peersAsked: number): void {
  const cur = stores.seekStore.get(intentId)
  // (a) Never downgrade a seek the owner already connected — only bump peersAsked.
  if (cur?.status === 'connected') {
    stores.seekStore.update(intentId, { peersAsked })
    return
  }
  // (b) Derive from real echo rows, not the broker-passed count.
  const status: 'echoed' | 'closed' = stores.echoStore.listForSeek(intentId).length > 0 ? 'echoed' : 'closed'
  stores.seekStore.update(intentId, { status, peersAsked })
}

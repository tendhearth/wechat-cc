/**
 * Per-contact profiles + closeness scoring — a NUMERIC-FAITHFUL port of
 * wxgraph's `profile.py` (build_profiles, percentile, _clamp01, and the
 * recency/volume/intimacy/reciprocity sub-scores + weighted closeness).
 *
 * This module must produce the SAME numbers as the reviewed Python for the
 * same input — see graph-profiles.test.ts, which pins exact values (not just
 * "runs"). Where profile.py does something that looks odd (see inline notes
 * below), it is ported LITERALLY rather than "cleaned up": fidelity over
 * elegance is the whole point of this task.
 *
 * `now` and `weights` are injected parameters — this module never calls
 * Date.now() itself, so callers (and tests) fully control the clock.
 *
 * Source of truth:
 * wechat-cc-plugins/packages/wxgraph/wxgraph/profile.py
 */

/** One normalized message, as the profile builder needs it. Mirrors
 *  `SourceMsg` (src/core/knowledge/store.ts) after mapping at the call site:
 *  `is_group`/`conversation`/`ts`(=time)/`kind` come straight across;
 *  `sender_un`=sender, `ltype`=local_type, `content`=text. `ltype`/`content`
 *  are carried for shape-fidelity with profile.py's message dict (which
 *  re-derives its tag via `classify_type(ltype, content)`) but are NOT read
 *  by this module — `kind` is used directly instead, since the source layer
 *  (GR Task 1's `classifyKind`) already computed the identical tag. */
export interface Msg {
  is_group: boolean
  sender_un: string
  conversation: string
  ts: number
  ltype: number
  content: string
  kind: string
}

export interface Weights {
  recency: number
  volume: number
  intimacy: number
  reciprocity: number
}

/** One contact's accumulated profile + transparent sub-scores. Mirrors the
 *  dict shape `build_profiles` returns in profile.py (minus the internal
 *  `_n_int` scratch field, which the Python `del`s before returning). */
export interface Profile {
  username: string
  total: number
  sent: number
  recv: number
  first_ts: number
  last_ts: number
  known_days: number
  active_days: number
  initiations: number
  transfer_in: number
  transfer_out: number
  shared_groups: number
  types: Record<string, number>
  s_volume: number
  s_recency: number
  s_reciprocity: number
  s_intimacy: number
  closeness: number
}

export const DAY = 86400
/** >6h since the previous message => a fresh initiation. */
export const GAP = 6 * 3600
export const TAU_DAYS = 90.0

export const DEFAULT_WEIGHTS: Weights = {
  recency: 0.35,
  volume: 0.3,
  intimacy: 0.2,
  reciprocity: 0.15,
}

/** Ported verbatim from profile.py's `percentile` — linear-interpolation
 *  percentile over a plain array (no external stats lib). */
export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 0) return 0.0
  if (s.length === 1) return s[0]!
  const k = (s.length - 1) * p
  const f = Math.floor(k)
  const c = Math.ceil(k)
  if (f === c) return s[f]!
  return s[f]! * (c - k) + s[c]! * (k - f)
}

function clamp01(x: number): number {
  return x < 0 ? 0.0 : x > 1 ? 1.0 : x
}

interface Acc {
  msgs: Msg[]
  types: Record<string, number>
  sent: number
  recv: number
  transfer_in: number
  transfer_out: number
}

/**
 * Port of `build_profiles(messages, owner, now, weights=None)`.
 *
 * Per-1:1-contact accumulation (group messages feed ONLY the group-speaker
 * sets used for `shared_groups`, never a contact accumulator directly), then
 * the sub-scores + weighted closeness. `now` and `weights` are parameters —
 * no wall-clock reads here.
 */
export function buildProfiles(
  messages: Msg[],
  owner: string,
  now: number,
  weights: Weights = DEFAULT_WEIGHTS,
): Profile[] {
  // group speaker sets, for shared_groups
  const groupSpeakers = new Map<string, Set<string>>()
  // per 1:1 contact accumulator (Map preserves insertion order, like the
  // Python dict `acc` does across 3.7+ — irrelevant to the final output
  // since callers sort/rank explicitly, but kept for parity).
  const acc = new Map<string, Acc>()

  for (const msg of messages) {
    if (msg.is_group) {
      if (msg.sender_un) {
        let speakers = groupSpeakers.get(msg.conversation)
        if (!speakers) {
          speakers = new Set()
          groupSpeakers.set(msg.conversation, speakers)
        }
        speakers.add(msg.sender_un)
      }
      continue
    }
    const contact = msg.conversation
    if (contact === owner) continue // self-chat / filehelper edge: skip
    let a = acc.get(contact)
    if (!a) {
      a = { msgs: [], types: {}, sent: 0, recv: 0, transfer_in: 0, transfer_out: 0 }
      acc.set(contact, a)
    }
    a.msgs.push(msg)
    if (msg.sender_un === owner) a.sent += 1
    else a.recv += 1
    const tag = msg.kind
    a.types[tag] = (a.types[tag] ?? 0) + 1
    if (tag === 'transfer' || tag === 'redpacket') {
      if (msg.sender_un === owner) a.transfer_out += 1
      else a.transfer_in += 1
    }
  }

  // groups where BOTH owner and the contact spoke
  function sharedGroups(contact: string): number {
    let n = 0
    for (const speakers of groupSpeakers.values()) {
      if (speakers.has(owner) && speakers.has(contact)) n += 1
    }
    return n
  }

  const rows: (Profile & { _n_int: number })[] = []
  for (const [contact, a] of acc) {
    const msgs = [...a.msgs].sort((x, y) => x.ts - y.ts)
    const firstTs = msgs[0]!.ts
    const lastTs = msgs[msgs.length - 1]!.ts
    const activeDays = new Set(msgs.map(x => Math.floor(x.ts / DAY))).size
    let initiations = 0
    let prevTs: number | null = null
    for (const x of msgs) {
      if (x.sender_un === owner && (prevTs === null || x.ts - prevTs > GAP)) {
        initiations += 1
      }
      prevTs = x.ts
    }
    const total = msgs.length
    const nInt = (a.types['voice'] ?? 0) + (a.types['call'] ?? 0) + a.transfer_in + a.transfer_out
    rows.push({
      username: contact,
      total,
      sent: a.sent,
      recv: a.recv,
      first_ts: firstTs,
      last_ts: lastTs,
      known_days: Math.max(0, Math.floor((now - firstTs) / DAY)),
      active_days: activeDays,
      initiations,
      transfer_in: a.transfer_in,
      transfer_out: a.transfer_out,
      shared_groups: sharedGroups(contact),
      types: { ...a.types },
      _n_int: nInt,
      // sub-scores filled in the normalization pass below.
      s_volume: 0,
      s_recency: 0,
      s_reciprocity: 0,
      s_intimacy: 0,
      closeness: 0,
    })
  }

  // normalization corpora (P95, floored at 1.0)
  const p95Total = Math.max(1.0, percentile(rows.map(r => r.total), 0.95))
  const p95Int = Math.max(1.0, percentile(rows.map(r => r._n_int), 0.95))

  for (const r of rows) {
    const sVolume = clamp01(Math.log1p(r.total) / Math.log1p(p95Total))
    const daysSince = Math.max(0, now - r.last_ts) / DAY
    const sRecency = clamp01(Math.exp(-daysSince / TAU_DAYS))
    const denom = r.sent + r.recv
    const sRecip = denom ? 1.0 - Math.abs(r.sent - r.recv) / denom : 0.0
    const sIntim = clamp01(Math.log1p(r._n_int) / Math.log1p(p95Int))
    const closeness =
      weights.recency * sRecency +
      weights.volume * sVolume +
      weights.intimacy * sIntim +
      weights.reciprocity * sRecip
    r.s_volume = sVolume
    r.s_recency = sRecency
    r.s_reciprocity = sRecip
    r.s_intimacy = sIntim
    r.closeness = closeness
  }

  return rows.map(({ _n_int, ...rest }) => rest)
}

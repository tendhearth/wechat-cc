/**
 * Daemon-wide permission posture. Tiny standalone module so both
 * `agent-provider.ts` and `user-tier.ts` can import it without forming
 * a cycle (RFC 05 Phase 2 made capability-matrix import from each
 * provider for CAPABILITIES; previously PermissionMode lived in
 * capability-matrix and the cycle would route through there).
 *
 * - `strict`     ⇒ per-tier policy governs (tier `allow` / `relay` / `deny`).
 * - `dangerously` ⇒ operator launched the daemon with `--dangerously`;
 *   every provider's SDK-level bypass is used regardless of tier.
 */
export type PermissionMode = 'strict' | 'dangerously'

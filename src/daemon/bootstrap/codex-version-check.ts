/**
 * codex-version-check — boot-time guard against the silent
 * "no reply" trap documented in src/lib/find-codex-binary.ts:81-86.
 *
 * The codex SDK ↔ codex CLI wire protocol is version-locked: a
 * globally-installed CLI at version X paired with our bundled SDK at
 * version Y where X != Y emits events the SDK can't decode, so every
 * dispatch returns empty `assistantText`. The coordinator then takes
 * the FALLBACK_REPLY path with nothing to send and the user gets no
 * reply, no error, no signal anything is wrong.
 *
 * This helper compares the CLI's `--version` output against the SDK's
 * expected version and surfaces a structured pass/fail so the bootstrap
 * can refuse to register the codex provider entirely on mismatch (better
 * a loud "codex disabled" at boot than a silent dead chat).
 */

export interface CheckCodexVersionInput {
  binary: string
  /** Sync probe of `<binary> --version`. Returns the first non-empty
   *  stdout line, or null on timeout/error. */
  probe: (path: string) => string | null
  /** SDK-expected CLI semver — read from `@openai/codex/package.json`
   *  at bootstrap time, so a bump of the SDK dep automatically updates
   *  this and the check stays in sync. */
  expectedVersion: string
}

export interface CheckCodexVersionResult {
  ok: boolean
  binary: string
  expectedVersion: string
  /** Raw probe output (e.g. "codex-cli 0.128.0") — preserved for logs. */
  rawVersion: string | null
  /** Extracted semver (e.g. "0.128.0"). null when no semver pattern in
   *  the raw output. */
  actualSemver: string | null
  reason?: 'version_mismatch' | 'version_probe_failed'
}

// Captures X.Y.Z plus an optional `-prerelease` tag (alphanumeric + dot + hyphen
// per semver 2.0). Without the prerelease part, an rc CLI matched against a
// stable expected version would falsely pass — the codex wire protocol can
// still differ between e.g. 0.128.0 and 0.128.0-rc.1.
const SEMVER_RE = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/

/**
 * Are these two versions close enough to share a wire protocol?
 *
 * Same major.minor, both stable — patch bumps are compatible. That is
 * measured, not assumed: on 2026-08-14 every combination of SDK/CLI 0.144.4
 * and 0.144.5 (four real codex dispatches, both mismatch directions) returned
 * a proper agent_message. The old exact-equality rule was refusing to register
 * codex for users whose globally-installed CLI self-updated a patch ahead of
 * our bundled SDK — the standalone installer updates itself on startup, so
 * this happens without the user doing anything.
 *
 * Everything else stays refused:
 *  - a minor or major gap. The failure this guard exists for (CLI 0.125 vs
 *    SDK 0.128, silent empty replies) is a minor gap and was never re-tested,
 *    so it keeps the benefit of the doubt.
 *  - anything with a prerelease tag on either side, which falls back to exact
 *    string equality. A prerelease can carry protocol changes a stable patch
 *    bump would not.
 */
function versionsCompatible(actual: string, expected: string): boolean {
  if (actual === expected) return true
  if (actual.includes('-') || expected.includes('-')) return false
  const a = actual.split('.')
  const e = expected.split('.')
  return a[0] === e[0] && a[1] === e[1]
}

export function checkCodexVersion(input: CheckCodexVersionInput): CheckCodexVersionResult {
  const raw = input.probe(input.binary)
  if (!raw) {
    return {
      ok: false,
      binary: input.binary,
      expectedVersion: input.expectedVersion,
      rawVersion: null,
      actualSemver: null,
      reason: 'version_probe_failed',
    }
  }
  const m = SEMVER_RE.exec(raw)
  const actualSemver = m?.[1] ?? null
  if (!actualSemver) {
    return {
      ok: false,
      binary: input.binary,
      expectedVersion: input.expectedVersion,
      rawVersion: raw,
      actualSemver: null,
      reason: 'version_probe_failed',
    }
  }
  if (!versionsCompatible(actualSemver, input.expectedVersion)) {
    return {
      ok: false,
      binary: input.binary,
      expectedVersion: input.expectedVersion,
      rawVersion: raw,
      actualSemver,
      reason: 'version_mismatch',
    }
  }
  return {
    ok: true,
    binary: input.binary,
    expectedVersion: input.expectedVersion,
    rawVersion: raw,
    actualSemver,
  }
}

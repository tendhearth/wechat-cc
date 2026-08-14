import { describe, expect, it } from 'vitest'
import { checkCodexVersion } from './codex-version-check'

describe('checkCodexVersion', () => {
  it('passes when the CLI reports the exact expected version', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => '0.128.0',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(true)
    expect(result.actualSemver).toBe('0.128.0')
  })

  it('extracts the semver from a prefixed --version string ("codex-cli 0.128.0")', () => {
    // The codex CLI's --version output is "codex-cli <semver>"; comparing
    // raw strings would falsely reject the matched case. The check must
    // pull the semver out before comparing.
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.128.0',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(true)
    expect(result.actualSemver).toBe('0.128.0')
  })

  it('reports mismatch when CLI version differs from SDK expectation', () => {
    // The exact failure mode from find-codex-binary.ts:81-86 — CLI 0.125
    // paired with SDK 0.128 silently emits events the SDK can't decode
    // and every dispatch returns empty assistantText.
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.125.0',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_mismatch')
    expect(result.actualSemver).toBe('0.125.0')
    expect(result.expectedVersion).toBe('0.128.0')
  })

  it('reports probe failure when --version returns null', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => null,
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_probe_failed')
    expect(result.actualSemver).toBeNull()
  })

  it('treats a prerelease CLI as a mismatch against a stable expected version', () => {
    // Without prerelease capture, 0.128.0-rc.1 would mangle to 0.128.0 and
    // falsely PASS when expected is 0.128.0 — the SDK's wire protocol may
    // still be incompatible with the prerelease. Be conservative: full
    // string equality including prerelease tag.
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.128.0-rc.1',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_mismatch')
    expect(result.actualSemver).toBe('0.128.0-rc.1')
  })

  it('passes when both CLI and SDK expect the same prerelease tag', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.128.0-rc.1',
      expectedVersion: '0.128.0-rc.1',
    })
    expect(result.ok).toBe(true)
    expect(result.actualSemver).toBe('0.128.0-rc.1')
  })

  it('reports unparseable output as probe failure (no semver found)', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'unexpected output',
      expectedVersion: '0.128.0',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_probe_failed')
  })

  // Patch-level tolerance (2026-08-14). Measured, not assumed: four real
  // codex dispatches on the maintainer's machine, every combination of
  // SDK/CLI 0.144.4 and 0.144.5, all returned a proper agent_message. The
  // exact-equality rule was refusing to register codex for a user whose
  // globally-installed CLI self-updated 0.144.5 -> 0.144.7 — a patch bump
  // the protocol handles fine. Minor gaps stay refused: the failure this
  // guard was built for (0.125 CLI vs 0.128 SDK) is a minor gap, and that
  // was never re-tested, so it keeps the benefit of the doubt.
  it('passes when only the patch differs and the CLI is newer (the self-update case)', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.144.7',
      expectedVersion: '0.144.5',
    })
    expect(result.ok).toBe(true)
    expect(result.actualSemver).toBe('0.144.7')
  })

  it('passes when only the patch differs and the CLI is older', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.144.4',
      expectedVersion: '0.144.5',
    })
    expect(result.ok).toBe(true)
  })

  it('still refuses a minor gap', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.145.0',
      expectedVersion: '0.144.5',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_mismatch')
  })

  it('still refuses a major gap', () => {
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 1.144.5',
      expectedVersion: '0.144.5',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_mismatch')
  })

  it('does not extend patch tolerance to prereleases — same major.minor, differing patch, one prerelease', () => {
    // A prerelease can carry protocol changes a stable patch bump would not.
    // Keep those on strict equality, consistent with the existing
    // prerelease-vs-stable case above.
    const result = checkCodexVersion({
      binary: '/usr/local/bin/codex',
      probe: () => 'codex-cli 0.144.7-rc.1',
      expectedVersion: '0.144.5',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('version_mismatch')
  })
})

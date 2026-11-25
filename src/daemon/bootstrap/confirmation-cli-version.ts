import { statSync } from 'node:fs'
import { CLI_SPECS } from '../../domain/cli-upgrade/specs'
import { parseVersion } from '../../domain/cli-upgrade/version'
import type { probeVersion } from './provider-probe'

function identity(path: string): string | undefined {
  try {
    const file = statSync(path, { bigint: true })
    if (file.isFile()) return [path, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':')
  } catch { /* The executable might be between installs. */ }
}

/** Capture the selected file before launch. Status readers never wait for --version. */
export function confirmationCliVersion(id: 'claude' | 'codex', probe: typeof probeVersion) {
  let cached: { key: string; result: Promise<string | undefined>; version?: string; retryAt?: number } | undefined
  function observe(path: string | undefined, initial?: Promise<Awaited<ReturnType<typeof probeVersion>>>) {
    if (!path) return
    const key = identity(path)
    if (!key) return
    if (cached?.key === key && (cached.retryAt === undefined || Date.now() < cached.retryAt)) return cached
    const entry: NonNullable<typeof cached> = {
      key,
      result: Promise.resolve().then(() => initial ?? probe(path)).then(result => {
        if (identity(path) === key && result.ok) entry.version = parseVersion(CLI_SPECS[id], result.firstLine) ?? undefined
        if (!entry.version) entry.retryAt = Date.now() + 30_000
        return entry.version
      }, () => {
        entry.retryAt = Date.now() + 30_000
        return undefined
      }),
    }
    cached = entry
    return entry
  }
  return {
    read: (path: string | undefined) => observe(path)?.version,
    capture: (path: string | undefined) => observe(path)?.result ?? Promise.resolve(undefined),
    prime: (path: string, result: Promise<Awaited<ReturnType<typeof probeVersion>>>) => observe(path, result),
  }
}

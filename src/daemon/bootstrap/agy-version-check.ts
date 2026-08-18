/**
 * agy-version-check — boot-time gate: does `<bin> --version` exit 0?
 *
 * agy (Antigravity CLI) registration (providers.ts, spec
 * 2026-08-17-agy-provider-design.md) needs a cheap "is this actually a
 * working agy binary" probe before registering the provider — a present
 * but non-functional/wedged binary must not (a) register a provider that
 * fails every turn, or (b) stall daemon boot waiting on it. This is the
 * async counterpart to `probeBinaryVersion` (src/lib/util.ts, used
 * synchronously by codex's version check) — agy's gate only needs a
 * boolean pass/fail, not the version string itself, and boot-time async
 * code (providers.ts already awaits dynamic imports in the surrounding
 * registration blocks) reads more naturally with an async probe here.
 */

/** Injection seam for tests — defaults to `Bun.spawn`. */
export interface AgyVersionProbeHandle {
  exited: Promise<number>
  kill(): void
}
export type AgyVersionProbeSpawn = (bin: string, args: string[]) => AgyVersionProbeHandle

const DEFAULT_TIMEOUT_MS = 5000

function defaultSpawn(bin: string, args: string[]): AgyVersionProbeHandle {
  const proc = Bun.spawn([bin, ...args], { stdout: 'ignore', stderr: 'ignore' })
  return {
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill()
      } catch {
        // already gone — best effort
      }
    },
  }
}

/**
 * Resolves `true` iff `<bin> --version` exits 0 within `timeoutMs`.
 * Resolves `false` on: nonzero exit, a spawn error (ENOENT etc., whether
 * thrown synchronously or surfaced as a rejected `exited`), or a timeout
 * (the child is killed on the way out — never left running past this call).
 */
export async function agyVersionOk(
  bin: string,
  opts?: { timeoutMs?: number; spawnFn?: AgyVersionProbeSpawn },
): Promise<boolean> {
  const spawnFn = opts?.spawnFn ?? defaultSpawn
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let proc: AgyVersionProbeHandle
  try {
    proc = spawnFn(bin, ['--version'])
  } catch {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('agy-version-check-timeout')
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs)
  })
  try {
    const result = await Promise.race([proc.exited, timeout])
    if (result === timedOut) {
      proc.kill()
      return false
    }
    return result === 0
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

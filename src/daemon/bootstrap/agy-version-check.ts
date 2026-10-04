/**
 * agy-version-check — boot-time gate: does `<bin> --version` exit 0?
 *
 * agy (Antigravity CLI) registration (providers.ts, spec
 * 2026-08-17-agy-provider-design.md) needs a cheap "is this actually a
 * working agy binary" probe before registering the provider — a present
 * but non-functional/wedged binary must not (a) register a provider that
 * fails every turn, or (b) stall daemon boot waiting on it.
 *
 * 2026-10-04:实现搬进 provider-probe.ts 的 `probeVersion`(超时只按事件循环醒着的
 * 时间计、失败带具体原因、失败后有退避重探)。providers.ts 直接用那边;这里留一个
 * 布尔版本的薄壳,签名不变。
 */
import { probeVersion, type VersionProbeHandle, type VersionProbeSpawn } from './provider-probe'

/** Injection seam for tests — defaults to a piped `spawn`. */
export type AgyVersionProbeHandle = VersionProbeHandle
export type AgyVersionProbeSpawn = VersionProbeSpawn

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
  return (await probeVersion(bin, opts)).ok
}

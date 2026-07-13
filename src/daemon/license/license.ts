/**
 * License / entitlement — the free ⇄ Pro gate for wechat-cc.
 *
 * Reality this is built around: wechat-cc is MIT + runs on the user's machine,
 * so a license check is NOT unbreakable DRM and isn't trying to be. It's a
 * light, honest gate. Value that can't be pirated (support, cross-WeChat-version
 * upkeep, the Pro experience) is what people actually pay for.
 *
 * Model (Lemon Squeezy license keys):
 *   activate(key)  → LS binds the key to this install (instance) → cache result
 *   validate()     → periodic online re-check (catches cancel/refund/expiry)
 *   getEntitlement → PURE read of the cache (works OFFLINE); Pro iff the last
 *                    known status is active and not past expiry.
 *
 * Offline grace is inherent: entitlement is computed from the cached
 * last-known-good result, so a plane-mode user keeps Pro until expiry; we only
 * downgrade when an ONLINE validate says the subscription ended.
 *
 * Testing without a real LS account:
 *   - env WECHAT_CC_DEV_PRO=1        → force Pro (test the gate)
 *   - a license key starting "DEV-"  → activate/validate locally as active
 *   - env WECHAT_CC_LS_API           → point at a mock LS server
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { licensePath } from './paths'

export interface LicenseCache {
  key: string
  instanceId: string
  /** LS license_key.status: active | inactive | expired | disabled */
  status: string
  /** ISO expiry, or null for a lifetime/non-expiring key. */
  expiresAt: string | null
  /** ISO of the last successful ONLINE confirmation. */
  lastValidatedAt: string
}

export interface Entitlement {
  pro: boolean
  reason: string
  expiresAt: string | null
}

const LS_API = process.env.WECHAT_CC_LS_API || 'https://api.lemonsqueezy.com/v1'
const REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000   // re-check online at most daily

// ── cache I/O ────────────────────────────────────────────────────────────────
export function readCache(stateDir: string): LicenseCache | null {
  const p = licensePath(stateDir)
  if (!existsSync(p)) return null
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (c && typeof c === 'object' && typeof (c as LicenseCache).key === 'string'
        && typeof (c as LicenseCache).status === 'string') {
      const lc = c as LicenseCache
      return {
        key: lc.key,
        instanceId: typeof lc.instanceId === 'string' ? lc.instanceId : '',
        status: lc.status,
        expiresAt: typeof lc.expiresAt === 'string' ? lc.expiresAt : null,
        lastValidatedAt: typeof lc.lastValidatedAt === 'string' ? lc.lastValidatedAt : new Date(0).toISOString(),
      }
    }
  } catch { /* malformed → treated as no license */ }
  return null
}

function writeCache(stateDir: string, cache: LicenseCache): void {
  const p = licensePath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p)
}

export function clearLicense(stateDir: string): void {
  try { rmSync(licensePath(stateDir), { force: true }) } catch { /* best effort */ }
}

// ── entitlement (PURE — the gate) ────────────────────────────────────────────
/** Compute Pro/free purely from the cache. No network. */
export function entitlementFromCache(cache: LicenseCache | null, now: Date): Entitlement {
  if (!cache) return { pro: false, reason: 'free — no license', expiresAt: null }
  if (cache.status !== 'active') return { pro: false, reason: `license ${cache.status}`, expiresAt: cache.expiresAt }
  if (cache.expiresAt && new Date(cache.expiresAt).getTime() < now.getTime()) {
    return { pro: false, reason: 'license expired', expiresAt: cache.expiresAt }
  }
  return { pro: true, reason: 'pro — active', expiresAt: cache.expiresAt }
}

/** The gate everything Pro checks. `WECHAT_CC_DEV_PRO=1` forces Pro (dev only). */
export function getEntitlement(stateDir: string, now: Date = new Date()): Entitlement {
  if (process.env.WECHAT_CC_DEV_PRO === '1') {
    return { pro: true, reason: 'pro — dev override (WECHAT_CC_DEV_PRO)', expiresAt: null }
  }
  return entitlementFromCache(readCache(stateDir), now)
}

export function isPro(stateDir: string): boolean {
  return getEntitlement(stateDir).pro
}

/** True when the cache is stale enough to warrant an online re-check. */
export function needsRevalidation(cache: LicenseCache | null, now: Date = new Date()): boolean {
  if (!cache || cache.key.startsWith('DEV-')) return false
  return now.getTime() - new Date(cache.lastValidatedAt).getTime() > REVALIDATE_AFTER_MS
}

// ── Lemon Squeezy calls ──────────────────────────────────────────────────────
type Fetcher = typeof fetch

function parseLicenseKey(lk: unknown): { status: string; expiresAt: string | null } {
  const o = (lk && typeof lk === 'object') ? lk as Record<string, unknown> : {}
  return {
    status: typeof o.status === 'string' ? o.status : 'inactive',
    expiresAt: typeof o.expires_at === 'string' ? o.expires_at : null,
  }
}

/** Activate a license key against LS (or a DEV- key locally). Persists the cache. */
export async function activate(
  stateDir: string, key: string, instanceName: string, fetchImpl: Fetcher = fetch,
): Promise<{ ok: true; entitlement: Entitlement } | { ok: false; error: string }> {
  const now = new Date()
  if (key.startsWith('DEV-')) {          // fake key: unlock Pro locally for testing
    const cache: LicenseCache = { key, instanceId: 'dev', status: 'active', expiresAt: null, lastValidatedAt: now.toISOString() }
    writeCache(stateDir, cache)
    return { ok: true, entitlement: entitlementFromCache(cache, now) }
  }
  try {
    const resp = await fetchImpl(`${LS_API}/licenses/activate`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key, instance_name: instanceName }),
      signal: AbortSignal.timeout(10_000),
    })
    const json = await resp.json().catch(() => ({})) as Record<string, unknown>
    if (!json.activated) {
      return { ok: false, error: typeof json.error === 'string' ? json.error : `activation failed (HTTP ${resp.status})` }
    }
    const { status, expiresAt } = parseLicenseKey(json.license_key)
    const instance = json.instance as Record<string, unknown> | undefined
    const cache: LicenseCache = {
      key, instanceId: String(instance?.id ?? ''), status, expiresAt, lastValidatedAt: now.toISOString(),
    }
    writeCache(stateDir, cache)
    return { ok: true, entitlement: entitlementFromCache(cache, now) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Re-check the cached key online, refresh the cache. Offline → keep last-known-good (grace). */
export async function validate(stateDir: string, fetchImpl: Fetcher = fetch): Promise<Entitlement> {
  const now = new Date()
  const cache = readCache(stateDir)
  if (!cache) return getEntitlement(stateDir, now)
  if (cache.key.startsWith('DEV-')) return entitlementFromCache(cache, now)
  try {
    const resp = await fetchImpl(`${LS_API}/licenses/validate`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: cache.key, instance_id: cache.instanceId }),
      signal: AbortSignal.timeout(10_000),
    })
    const json = await resp.json().catch(() => ({})) as Record<string, unknown>
    const { status, expiresAt } = parseLicenseKey(json.license_key)
    const updated: LicenseCache = { ...cache, status, expiresAt, lastValidatedAt: now.toISOString() }
    writeCache(stateDir, updated)
    return entitlementFromCache(updated, now)
  } catch {
    return entitlementFromCache(cache, now)   // offline grace: honor the cache
  }
}

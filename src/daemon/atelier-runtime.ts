import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildRenderBrief, renderBriefToPrompt, parseArtImpulse, type ArtImpulse, type RenderBrief } from './art-impulse'
import type { ArtworkRenderer, RenderedArtwork } from './artwork-renderer'
import type { AtelierStore } from './atelier-store'

export type AtelierMode = 'off' | 'private' | 'share'

export interface AtelierContext {
  recentObservations: string[]
  activeThreads: string[]
  personaExcerpt: string
  recentWorks: Array<{ id: string; createdAt: string; subject?: string; surface?: string; medium?: string }>
  nowLocal: string
}

export interface ArtImpulsePlanner {
  plan(context: AtelierContext): Promise<ArtImpulse | unknown>
}

export interface AtelierCadenceState {
  lastEvaluatedAt?: string
  successfulAt: string[]
}

export interface AtelierRuntimeDeps {
  stateDir: string
  mode: AtelierMode
  planner: ArtImpulsePlanner
  renderer: ArtworkRenderer | null
  store: AtelierStore
  context: AtelierContext
  now?: () => Date
  evaluationIntervalMs?: number
  minSuccessIntervalMs?: number
  rollingWindowMs?: number
  maxSuccessesInWindow?: number
  /** Sharing is a second gate; returning false keeps a work local. */
  canShare?: () => boolean
  notify?: (recordId: string) => Promise<void>
  log?: (tag: string, line: string) => void
}

export type AtelierRunResult =
  | { status: 'skipped_off' | 'skipped_no_renderer' | 'skipped_cadence' | 'no_impulse' | 'invalid_impulse' | 'privacy_rejected' | 'render_failed' | 'save_failed' }
  | { status: 'created'; recordId: string; shared: boolean }

const DEFAULT_EVALUATION_INTERVAL_MS = 24 * 3600_000
const DEFAULT_MIN_SUCCESS_INTERVAL_MS = 30 * 3600_000
const DEFAULT_ROLLING_WINDOW_MS = 7 * 24 * 3600_000
const DEFAULT_MAX_SUCCESSES = 2

function statePath(stateDir: string): string { return join(stateDir, 'atelier', 'atelier-state.json') }

export function readAtelierCadence(stateDir: string): AtelierCadenceState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(stateDir), 'utf8')) as Partial<AtelierCadenceState>
    if (!Array.isArray(parsed.successfulAt)) return { successfulAt: [] }
    return {
      ...(typeof parsed.lastEvaluatedAt === 'string' ? { lastEvaluatedAt: parsed.lastEvaluatedAt } : {}),
      successfulAt: parsed.successfulAt.filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))),
    }
  } catch {
    return { successfulAt: [] }
  }
}

export function writeAtelierCadence(stateDir: string, state: AtelierCadenceState): void {
  const file = statePath(stateDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

function recentSuccessful(state: AtelierCadenceState, nowMs: number, windowMs: number): string[] {
  return state.successfulAt.filter(value => nowMs - Date.parse(value) < windowMs && nowMs >= Date.parse(value))
}

/**
 * One isolated atelier opportunity. This function is intentionally not
 * imported by the daemon tick yet; it is the seam for private-mode rollout.
 */
export async function runAtelierCycle(d: AtelierRuntimeDeps): Promise<AtelierRunResult> {
  const log = d.log ?? (() => {})
  if (d.mode === 'off') return { status: 'skipped_off' }
  if (!d.renderer) return { status: 'skipped_no_renderer' }

  const now = d.now ?? (() => new Date())
  const nowDate = now()
  const nowMs = nowDate.getTime()
  if (!Number.isFinite(nowMs)) return { status: 'skipped_cadence' }
  const evaluationIntervalMs = d.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS
  const minSuccessIntervalMs = d.minSuccessIntervalMs ?? DEFAULT_MIN_SUCCESS_INTERVAL_MS
  const rollingWindowMs = d.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS
  const maxSuccesses = d.maxSuccessesInWindow ?? DEFAULT_MAX_SUCCESSES
  const cadence = readAtelierCadence(d.stateDir)
  if (cadence.lastEvaluatedAt && nowMs - Date.parse(cadence.lastEvaluatedAt) < evaluationIntervalMs) {
    return { status: 'skipped_cadence' }
  }
  const successful = recentSuccessful(cadence, nowMs, rollingWindowMs)
  if (successful.length >= maxSuccesses || (successful[0] && nowMs - Date.parse(successful[0]) < minSuccessIntervalMs)) {
    return { status: 'skipped_cadence' }
  }

  // Stamp the opportunity before invoking a provider: a thrown planner must
  // not create a hot loop on every daemon restart.
  cadence.lastEvaluatedAt = nowDate.toISOString()
  writeAtelierCadence(d.stateDir, cadence)
  let planned: ArtImpulse | unknown
  try {
    planned = await d.planner.plan(d.context)
  } catch (error) {
    log('ATELIER', `planner failed: ${String(error)}`)
    return { status: 'invalid_impulse' }
  }
  const parsed = parseArtImpulse(planned)
  if (!parsed.ok) {
    log('ATELIER', `invalid impulse: ${parsed.reason}`)
    return { status: 'invalid_impulse' }
  }
  if (!parsed.value.shouldPaint) return { status: 'no_impulse' }
  const brief = buildRenderBrief(parsed.value, {
    continuityHints: d.context.recentWorks.flatMap(work => [work.surface, work.medium, work.subject].filter((v): v is string => Boolean(v))),
  })
  if (!brief.ok) {
    log('ATELIER', `privacy rejected: ${brief.reason}`)
    return { status: 'privacy_rejected' }
  }
  let rendered: RenderedArtwork
  try {
    rendered = await d.renderer.render({ prompt: renderBriefToPrompt(brief.brief) })
  } catch (error) {
    log('ATELIER', `renderer failed: ${String(error)}`)
    return { status: 'render_failed' }
  }
  const pendingShare = d.mode === 'share' && parsed.value.shareIntent === 'now' && Boolean(d.canShare?.() ?? false)
  try {
    const record = d.store.save({
      imageBytes: rendered.bytes,
      impulse: parsed.value,
      privateCauseSummary: parsed.value.whyNow,
      rendererId: rendered.rendererId,
      shareState: pendingShare ? 'pending' : 'private',
    })
    // Cadence uses the runtime's own time authority (d.now), not the store's
    // clock, so a fixed injected `now` stays consistent across the gate and the
    // recorded success. Using record.createdAt (store clock) made cadence
    // date-dependent when the store had no injected clock.
    cadence.successfulAt = [...successful, nowDate.toISOString()]
      .sort((a, b) => Date.parse(b) - Date.parse(a))
      .slice(0, maxSuccesses)
    writeAtelierCadence(d.stateDir, cadence)
    let shared = false
    if (pendingShare && d.notify) {
      try {
        await d.notify(record.id)
        shared = true
      } catch (error) {
        log('ATELIER', `notify failed; artwork kept pending: ${String(error)}`)
      }
    }
    return { status: 'created', recordId: record.id, shared }
  } catch (error) {
    log('ATELIER', `save failed: ${String(error)}`)
    return { status: 'save_failed' }
  }
}

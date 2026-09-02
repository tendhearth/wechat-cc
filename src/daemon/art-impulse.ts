/**
 * Provider-neutral intent and art-direction boundary for CC Atelier.
 *
 * A chat provider may propose an ArtImpulse, but only this deterministic
 * module is allowed to turn it into renderer-bound visual information.
 * Private causal context (`whyNow`) is intentionally impossible to copy into
 * RenderBrief through the public API below.
 */

const FIELD_LIMIT = 240
const CONTINUITY_LIMIT = 4

const IMPULSE_KEYS = new Set([
  'shouldPaint', 'feeling', 'whyNow', 'subject', 'surface', 'medium',
  'gesture', 'composition', 'shareIntent',
])

const CONTROL_OR_PROMPT_TOKEN = /[\u0000-\u001f\u007f-\u009f]|```|<\|[^>]*\|>/u
const URL_OR_EMAIL = /(?:https?:\/\/|www\.)\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu
const PHONE_OR_ID = /(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b\d{8,}\b/iu
const DIRECT_QUOTE = /[“”‘’「」『』"']/u

export type ArtworkShareIntent = 'now' | 'later' | 'private'

export interface ArtImpulse {
  shouldPaint: boolean
  feeling?: string
  /** Local-only causal summary. Never becomes renderer input. */
  whyNow?: string
  subject?: string
  surface?: string
  medium?: string
  gesture?: string
  composition?: string
  shareIntent?: ArtworkShareIntent
}

export interface RenderBrief {
  subject: string
  surface: string
  medium: string
  gesture: string
  composition: string
  continuityHints: string[]
  negativeConstraints: string[]
}

export type ArtImpulseParseResult =
  | { ok: true; value: ArtImpulse }
  | { ok: false; reason: string }

export type RenderBriefResult =
  | { ok: true; brief: RenderBrief }
  | { ok: false; reason: string }

function parseJsonCandidate(input: unknown): unknown {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 4_000 || trimmed.startsWith('```')) return undefined
  try { return JSON.parse(trimmed) } catch { return undefined }
}

function validText(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= FIELD_LIMIT && !CONTROL_OR_PROMPT_TOKEN.test(trimmed)
}

/** Parse strict planner output. Any ambiguity fails closed before rendering. */
export function parseArtImpulse(input: unknown): ArtImpulseParseResult {
  const candidate = parseJsonCandidate(input)
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'impulse is not a JSON object' }
  }
  const raw = candidate as Record<string, unknown>
  if (Object.keys(raw).some(key => !IMPULSE_KEYS.has(key))) {
    return { ok: false, reason: 'impulse contains unknown fields' }
  }
  if (typeof raw.shouldPaint !== 'boolean') {
    return { ok: false, reason: 'shouldPaint must be boolean' }
  }
  if (!raw.shouldPaint) {
    if (Object.keys(raw).length !== 1) {
      return { ok: false, reason: 'no-paint impulse must not contain creative fields' }
    }
    return { ok: true, value: { shouldPaint: false } }
  }

  const required = ['feeling', 'subject', 'surface', 'medium', 'gesture', 'composition'] as const
  for (const key of required) {
    if (!validText(raw[key])) return { ok: false, reason: `${key} is missing or invalid` }
  }
  if (raw.whyNow !== undefined && !validText(raw.whyNow)) {
    return { ok: false, reason: 'whyNow is invalid' }
  }
  if (raw.shareIntent !== 'now' && raw.shareIntent !== 'later' && raw.shareIntent !== 'private') {
    return { ok: false, reason: 'shareIntent is invalid' }
  }
  const feeling = raw.feeling as string
  const subject = raw.subject as string
  const surface = raw.surface as string
  const medium = raw.medium as string
  const gesture = raw.gesture as string
  const composition = raw.composition as string
  return {
    ok: true,
    value: {
      shouldPaint: true,
      feeling: feeling.trim(),
      ...(typeof raw.whyNow === 'string' ? { whyNow: raw.whyNow.trim() } : {}),
      subject: subject.trim(),
      surface: surface.trim(),
      medium: medium.trim(),
      gesture: gesture.trim(),
      composition: composition.trim(),
      shareIntent: raw.shareIntent,
    },
  }
}

function isRendererSafe(value: string, privateTerms: readonly string[]): boolean {
  if (!validText(value) || URL_OR_EMAIL.test(value) || PHONE_OR_ID.test(value) || DIRECT_QUOTE.test(value)) return false
  const folded = value.toLocaleLowerCase()
  return !privateTerms.some(term => {
    const needle = term.trim().toLocaleLowerCase()
    return needle.length >= 2 && folded.includes(needle)
  })
}

/**
 * Convert a validated impulse into visual-only renderer data. If any field may
 * contain identity/private material, reject the entire brief instead of trying
 * to guess at a lossy redaction.
 */
export function buildRenderBrief(
  impulse: ArtImpulse,
  options: { continuityHints?: readonly string[]; privateTerms?: readonly string[] } = {},
): RenderBriefResult {
  if (!impulse.shouldPaint) return { ok: false, reason: 'no creative impulse' }
  const visual = [impulse.subject, impulse.surface, impulse.medium, impulse.gesture, impulse.composition]
  if (visual.some(value => typeof value !== 'string')) {
    return { ok: false, reason: 'impulse is incomplete' }
  }
  const privateTerms = options.privateTerms ?? []
  if (visual.some(value => !isRendererSafe(value!, privateTerms))) {
    return { ok: false, reason: 'renderer-bound field failed privacy validation' }
  }
  const continuityHints = [...(options.continuityHints ?? [])].slice(0, CONTINUITY_LIMIT)
  if (continuityHints.some(value => !isRendererSafe(value, privateTerms))) {
    return { ok: false, reason: 'continuity hint failed privacy validation' }
  }
  return {
    ok: true,
    brief: {
      subject: impulse.subject!,
      surface: impulse.surface!,
      medium: impulse.medium!,
      gesture: impulse.gesture!,
      composition: impulse.composition!,
      continuityHints,
      negativeConstraints: [
        'no generated text or explanatory emotion labels',
        'no automatic mascot, white bear, face, heart, or sticker composition',
        'no polished generic AI illustration; preserve physical texture and imperfection',
      ],
    },
  }
}

/** One canonical prompt builder keeps rendering stable across chat providers. */
export function renderBriefToPrompt(brief: RenderBrief): string {
  const continuity = brief.continuityHints.length > 0
    ? `\nSubtle continuity with earlier work: ${brief.continuityHints.join('; ')}.`
    : ''
  return [
    'Create a single, text-free artwork as a physical mark made in the world.',
    `Subject or mark: ${brief.subject}.`,
    `Surface: ${brief.surface}; it must be visibly present in the finished image.`,
    `Medium: ${brief.medium}; show its real texture, resistance, and imperfections.`,
    `Gesture: ${brief.gesture}.`,
    `Composition: ${brief.composition}.${continuity}`,
    `Avoid: ${brief.negativeConstraints.join('; ')}.`,
  ].join('\n')
}

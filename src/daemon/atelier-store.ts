import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { parseArtImpulse, type ArtImpulse } from './art-impulse'

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_DIMENSION = 8_192
const DEFAULT_MAX_PIXELS = 36_000_000
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/

export type ArtworkShareState = 'private' | 'pending' | 'shared'

export interface ArtworkRecord {
  id: string
  createdAt: string
  imageFile: string
  mime: 'image/png'
  width: number
  height: number
  impulse: Omit<ArtImpulse, 'whyNow'>
  /** Local-only; callers must not expose this on guest-readable surfaces. */
  privateCauseSummary?: string
  caption?: string
  rendererId: string
  shareState: ArtworkShareState
  sharedAt?: string
}

export interface SaveArtworkInput {
  id?: string
  createdAt?: string
  imageBytes: Uint8Array
  impulse: ArtImpulse
  privateCauseSummary?: string
  caption?: string
  rendererId: string
  shareState?: ArtworkShareState
  sharedAt?: string
}

export interface AtelierStore {
  save(input: SaveArtworkInput): ArtworkRecord
  load(id: string): ArtworkRecord | null
  list(limit?: number): ArtworkRecord[]
  imagePath(recordOrId: ArtworkRecord | string): string | null
}

export interface AtelierStoreOptions {
  maxBytes?: number
  maxDimension?: number
  maxPixels?: number
  now?: () => Date
  makeId?: () => string
}

export class AtelierStoreError extends Error {
  constructor(readonly code: 'invalid_image' | 'invalid_record' | 'already_exists' | 'save_failed', message: string) {
    super(message)
    this.name = 'AtelierStoreError'
  }
}

function pngDimensions(bytes: Uint8Array, maxDimension: number, maxPixels: number): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const validHeader = bytes.length >= 33
    && signature.every((value, index) => bytes[index] === value)
    && bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13
    && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  if (!validHeader) throw new AtelierStoreError('invalid_image', 'artwork is not a valid PNG header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension || width * height > maxPixels) {
    throw new AtelierStoreError('invalid_image', 'artwork dimensions are invalid or too large')
  }
  return { width, height }
}

function safeOptionalText(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function publicImpulse(impulse: ArtImpulse): Omit<ArtImpulse, 'whyNow'> {
  const { whyNow: _privateCause, ...safe } = impulse
  return safe
}

function isRecord(value: unknown): value is ArtworkRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ArtworkRecord>
  if (!ID_RE.test(record.id ?? '') || record.imageFile !== `${record.id}.png`) return false
  if (basename(record.imageFile) !== record.imageFile) return false
  if (record.mime !== 'image/png' || !Number.isInteger(record.width) || !Number.isInteger(record.height)) return false
  if ((record.width ?? 0) < 1 || (record.height ?? 0) < 1) return false
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return false
  if (typeof record.rendererId !== 'string' || record.rendererId.length < 1 || record.rendererId.length > 200) return false
  if (record.shareState !== 'private' && record.shareState !== 'pending' && record.shareState !== 'shared') return false
  if (record.caption !== undefined && !safeOptionalText(record.caption)) return false
  if (record.privateCauseSummary !== undefined && !safeOptionalText(record.privateCauseSummary)) return false
  if (record.sharedAt !== undefined && (typeof record.sharedAt !== 'string' || !Number.isFinite(Date.parse(record.sharedAt)))) return false
  const parsed = parseArtImpulse(record.impulse)
  return parsed.ok && parsed.value.shouldPaint && parsed.value.whyNow === undefined
}

function defaultId(now: Date): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
}

export function makeAtelierStore(stateDir: string, options: AtelierStoreOptions = {}): AtelierStore {
  const worksDir = join(stateDir, 'atelier', 'works')
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS
  const now = options.now ?? (() => new Date())

  function paths(id: string): { image: string; metadata: string } | null {
    if (!ID_RE.test(id)) return null
    return { image: join(worksDir, `${id}.png`), metadata: join(worksDir, `${id}.json`) }
  }

  function load(id: string): ArtworkRecord | null {
    const target = paths(id)
    if (!target || !existsSync(target.image) || !existsSync(target.metadata)) return null
    try {
      const value = JSON.parse(readFileSync(target.metadata, 'utf8')) as unknown
      if (!isRecord(value)) return null
      const bytes = readFileSync(target.image)
      if (bytes.length > maxBytes) return null
      const dimensions = pngDimensions(bytes, maxDimension, maxPixels)
      return dimensions.width === value.width && dimensions.height === value.height ? value : null
    } catch {
      return null
    }
  }

  return {
    save(input) {
      if (input.imageBytes.length < 1 || input.imageBytes.length > maxBytes) {
        throw new AtelierStoreError('invalid_image', 'artwork bytes are empty or too large')
      }
      const dimensions = pngDimensions(input.imageBytes, maxDimension, maxPixels)
      const parsed = parseArtImpulse(input.impulse)
      if (!parsed.ok || !parsed.value.shouldPaint) {
        throw new AtelierStoreError('invalid_record', 'artwork requires a valid paint impulse')
      }
      if (input.caption !== undefined && !safeOptionalText(input.caption)) {
        throw new AtelierStoreError('invalid_record', 'caption is invalid')
      }
      if (input.privateCauseSummary !== undefined && !safeOptionalText(input.privateCauseSummary)) {
        throw new AtelierStoreError('invalid_record', 'private cause summary is invalid')
      }
      if (!safeOptionalText(input.rendererId, 200)) {
        throw new AtelierStoreError('invalid_record', 'renderer id is invalid')
      }
      if (input.shareState !== undefined && input.shareState !== 'private' && input.shareState !== 'pending' && input.shareState !== 'shared') {
        throw new AtelierStoreError('invalid_record', 'share state is invalid')
      }
      if (input.sharedAt !== undefined && !Number.isFinite(Date.parse(input.sharedAt))) {
        throw new AtelierStoreError('invalid_record', 'sharedAt is invalid')
      }
      const created = input.createdAt ? new Date(input.createdAt) : now()
      if (!Number.isFinite(created.getTime())) throw new AtelierStoreError('invalid_record', 'createdAt is invalid')
      const id = input.id ?? options.makeId?.() ?? defaultId(created)
      const target = paths(id)
      if (!target) throw new AtelierStoreError('invalid_record', 'artwork id is invalid')
      mkdirSync(worksDir, { recursive: true })
      if (existsSync(target.image) || existsSync(target.metadata)) {
        throw new AtelierStoreError('already_exists', 'artwork id already exists')
      }

      const record: ArtworkRecord = {
        id,
        createdAt: created.toISOString(),
        imageFile: `${id}.png`,
        mime: 'image/png',
        ...dimensions,
        impulse: publicImpulse(parsed.value),
        ...(input.privateCauseSummary ? { privateCauseSummary: input.privateCauseSummary.trim() } : {}),
        ...(input.caption ? { caption: input.caption.trim() } : {}),
        rendererId: input.rendererId.trim(),
        shareState: input.shareState ?? 'private',
        ...(input.sharedAt ? { sharedAt: new Date(input.sharedAt).toISOString() } : {}),
      }
      const scratch = `${id}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
      const tmpImage = join(worksDir, `${scratch}.png`)
      const tmpMetadata = join(worksDir, `${scratch}.json`)
      let imageCommitted = false
      try {
        writeFileSync(tmpImage, input.imageBytes, { flag: 'wx', mode: 0o600 })
        writeFileSync(tmpMetadata, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        renameSync(tmpImage, target.image)
        imageCommitted = true
        // Metadata is the commit marker: readers ignore an image without it.
        renameSync(tmpMetadata, target.metadata)
        return record
      } catch (error) {
        rmSync(tmpImage, { force: true })
        rmSync(tmpMetadata, { force: true })
        if (imageCommitted && !existsSync(target.metadata)) rmSync(target.image, { force: true })
        if (error instanceof AtelierStoreError) throw error
        throw new AtelierStoreError('save_failed', 'failed to save artwork atomically')
      }
    },

    load,

    list(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1) return []
      let names: string[]
      try { names = readdirSync(worksDir).filter(name => name.endsWith('.json') && !name.includes('.tmp-')) } catch { return [] }
      return names
        .map(name => load(name.slice(0, -5)))
        .filter((record): record is ArtworkRecord => record !== null)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, Math.min(limit, 100))
    },

    imagePath(recordOrId) {
      const id = typeof recordOrId === 'string' ? recordOrId : recordOrId.id
      const target = paths(id)
      if (!target) return null
      const stored = load(id)
      return stored && stored.imageFile === `${id}.png` ? target.image : null
    },
  }
}

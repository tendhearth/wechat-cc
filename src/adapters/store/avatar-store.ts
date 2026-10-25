/**
 * Per-contact / Claude avatar store.
 *
 * Files live at <stateDir>/avatars/<safe-filename>.<ext> where:
 *   - "claude" is the literal filename `_claude.png` (single global avatar)
 *   - any other key (chat_id) is sha256-hashed to a 16-hex-char filename
 *     so chat_ids with `@` / `:` / etc. don't break the filesystem
 *
 * Manual uploads canvas-resize to PNG. Automatic WeChat avatars may arrive
 * as PNG / JPEG / WEBP, so this layer validates known image magic bytes and
 * stores the matching extension.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const JPG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF])
const WEBP_RIFF = Buffer.from('RIFF')
const WEBP_MARK = Buffer.from('WEBP')
const MAX_BYTES = 1024 * 1024  // 1 MB cap; resized 80×80 PNG is typically <30 KB
const AVATAR_EXTS = ['png', 'jpg', 'webp'] as const
type AvatarExt = typeof AVATAR_EXTS[number]

export interface AvatarInfo {
  exists: boolean
  path: string
}

function avatarBasename(key: string): string {
  if (key === 'claude') return '_claude'
  // sha256 → first 16 hex chars: enough entropy to avoid collisions
  // among any plausible chat-id set, but short enough to be readable
  // in the filesystem.
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function avatarFilename(key: string, ext: AvatarExt = 'png'): string {
  return `${avatarBasename(key)}.${ext}`
}

export function avatarPath(stateDir: string, key: string): string {
  return join(stateDir, 'avatars', avatarFilename(key))
}

export function avatarInfo(stateDir: string, key: string): AvatarInfo {
  const fallback = avatarPath(stateDir, key)
  for (const ext of AVATAR_EXTS) {
    const path = join(stateDir, 'avatars', avatarFilename(key, ext))
    if (existsSync(path)) return { exists: true, path }
  }
  const path = fallback
  return { exists: existsSync(path), path }
}

function detectAvatarExt(buf: Buffer): AvatarExt | null {
  if (buf.subarray(0, 8).compare(PNG_MAGIC) === 0) return 'png'
  if (buf.subarray(0, 3).compare(JPG_MAGIC) === 0) return 'jpg'
  if (
    buf.length >= 12
    && buf.subarray(0, 4).compare(WEBP_RIFF) === 0
    && buf.subarray(8, 12).compare(WEBP_MARK) === 0
  ) return 'webp'
  return null
}

export function setAvatar(
  stateDir: string,
  key: string,
  base64Png: string,
): { ok: true; path: string } {
  // Strip data-URI prefix if the caller passed one (frontend canvas
  // returns "data:image/png;base64,..."); accept both forms.
  const m = base64Png.match(/^data:image\/[a-z]+;base64,(.*)$/i)
  const data = (m ? m[1]! : base64Png).trim()
  const buf = Buffer.from(data, 'base64')

  if (buf.length === 0) throw new Error('avatar bytes are empty')
  if (buf.length > MAX_BYTES) throw new Error(`avatar exceeds ${MAX_BYTES} byte cap`)
  const ext = detectAvatarExt(buf)
  if (!ext) throw new Error('avatar is not a supported image (PNG/JPEG/WEBP magic bytes missing)')

  const dir = join(stateDir, 'avatars')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const oldExt of AVATAR_EXTS) {
    const oldPath = join(dir, avatarFilename(key, oldExt))
    if (oldExt !== ext && existsSync(oldPath)) rmSync(oldPath)
  }
  const path = join(dir, avatarFilename(key, ext))
  writeFileSync(path, buf, { mode: 0o600 })
  return { ok: true, path }
}

export function removeAvatar(stateDir: string, key: string): { ok: true; path: string } {
  const path = avatarPath(stateDir, key)
  for (const ext of AVATAR_EXTS) {
    const candidate = join(stateDir, 'avatars', avatarFilename(key, ext))
    if (existsSync(candidate)) rmSync(candidate)
  }
  return { ok: true, path }
}

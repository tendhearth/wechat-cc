import { createHash } from 'node:crypto'
import icon from './mobile-brand-icon.json'

// build:icons copies the existing runtime logo into this JSON so Bun includes
// the PNG in compiled sidecars. No source checkout, cwd or Tauri resource path
// is required when a phone requests its home-screen icon.
export const MOBILE_BRAND_ICON_PNG = Buffer.from(icon.pngBase64, 'base64')
export const MOBILE_BRAND_ICON_SIZES = `${MOBILE_BRAND_ICON_PNG.readUInt32BE(16)}x${MOBILE_BRAND_ICON_PNG.readUInt32BE(20)}`
export const MOBILE_BRAND_ICON_VERSION = createHash('sha256').update(MOBILE_BRAND_ICON_PNG).digest('hex').slice(0, 12)

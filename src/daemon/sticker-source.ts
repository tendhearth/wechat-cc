const ALLOWED_DOWNLOAD_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const DEFAULT_MAX_BYTES = 3_000_000

export interface StickerHit { url: string; id: string }
export interface StickerSource {
  search(query: string, opts?: { limit?: number }): Promise<StickerHit[]>
  download(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>
}
export interface TenorDeps { apiKey: string; fetch?: typeof fetch; maxBytes?: number }

function extFromUrl(url: string): string | null {
  try {
    const match = /\.([^.\/]+)$/.exec(new URL(url).pathname)
    const ext = match?.[1]?.toLowerCase()
    return ext && ext.length <= 5 ? ext : null
  } catch { return null }
}

export function makeTenorSource(deps: TenorDeps): StickerSource {
  const doFetch = deps.fetch ?? fetch
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  return {
    async search(query, opts) {
      const url = 'https://tenor.googleapis.com/v2/search?' + new URLSearchParams({
        key: deps.apiKey, q: query, limit: String(opts?.limit ?? 8),
        contentfilter: 'high', media_filter: 'gif',
      })
      try {
        const response = await doFetch(url)
        if (!response.ok) return []
        const body = await response.json() as { results?: unknown }
        if (!Array.isArray(body.results)) return []
        return body.results.flatMap((raw) => {
          const result = raw as { id?: unknown; media_formats?: { gif?: { url?: unknown } } }
          const mediaUrl = result.media_formats?.gif?.url
          return typeof result.id === 'string' && typeof mediaUrl === 'string' ? [{ id: result.id, url: mediaUrl }] : []
        })
      } catch { return [] }
    },
    async download(url) {
      const ext = extFromUrl(url)
      if (!ext || !ALLOWED_DOWNLOAD_EXTS.has(ext)) return null
      try {
        const response = await doFetch(url)
        if (!response.ok) return null
        const bytes = new Uint8Array(await response.arrayBuffer())
        return bytes.length > 0 && bytes.length <= maxBytes ? { bytes, ext } : null
      } catch { return null }
    },
  }
}

export function makeCooldown(ms: number): { ready(key: string, now: number): boolean } {
  const last = new Map<string, number>()
  return { ready(key, now) {
    if (ms <= 0) return true
    const previous = last.get(key)
    if (previous !== undefined && now - previous < ms) return false
    last.set(key, now)
    return true
  } }
}

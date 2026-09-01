export interface Env {
  GIPHY_API_KEY: string
}

const ACCESS_CONTROL_ALLOW_ORIGIN = '*'

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    'access-control-allow-origin': ACCESS_CONTROL_ALLOW_ORIGIN,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'public, max-age=60',
  })
  if (origin) headers.set('vary', 'Origin')
  return headers
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
    if (request.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders(origin) })

    const url = new URL(request.url)
    if (url.pathname !== '/search') return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders(origin) })
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 8) || 8, 1), 8)
    if (!query) return Response.json({ data: [] }, { headers: corsHeaders(origin) })

    const upstream = new URL('https://api.giphy.com/v1/stickers/search')
    upstream.search = new URLSearchParams({ api_key: env.GIPHY_API_KEY, q: query, limit: String(limit), rating: 'pg-13' }).toString()
    const response = await fetch(upstream)
    if (!response.ok) return Response.json({ error: 'upstream_unavailable' }, { status: 502, headers: corsHeaders(origin) })
    const body = await response.json() as { data?: unknown }
    const data = Array.isArray(body.data) ? body.data.flatMap((raw) => {
      const item = raw as { id?: unknown; images?: { original?: { url?: unknown }; downsized?: { url?: unknown } } }
      const mediaUrl = item.images?.original?.url ?? item.images?.downsized?.url
      return typeof item.id === 'string' && typeof mediaUrl === 'string' ? [{ id: item.id, url: mediaUrl }] : []
    }) : []
    return Response.json({ data }, { headers: corsHeaders(origin) })
  },
}

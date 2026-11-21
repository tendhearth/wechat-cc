import { PlaceMapPinRequest, PlaceHideRequest, PlaceMoveRequest, PlaceSeenRequest } from '@wechat-cc/protocol'
import type { InternalApiDeps, RouteTable } from '../../daemon/internal-api/types'
import { readFailure } from './routes'

export function placesRoutes(deps: Pick<InternalApiDeps, 'places' | 'log'>): RouteTable {
  const unavailable = { status: 503, body: { error: 'unavailable' } }
  return {
    'POST /v1/places/map/pin': async (_query, body, caller) => {
      if (caller?.origin !== 'operator') return { status: 403, body: { error: 'forbidden' } }
      const input = PlaceMapPinRequest.safeParse(body)
      if (!input.success) return { status: 400, body: { error: 'invalid' } }
      if (!deps.places) return unavailable
      try {
        const error = await deps.places.pin(input.data)
        if (error) return { status: error === 'place_map_item_fixed' ? 409 : 404, body: { error } }
        return { status: 200, body: { ok: true } }
      } catch {
        deps.log?.('PLACES', 'unavailable')
        return unavailable
      }
    },
    'GET /v1/places/map': async (query, _body, caller) => {
      if (caller?.origin !== 'operator') return { status: 403, body: { error: 'forbidden' } }
      if (!deps.places) return unavailable
      try {
        const result = await deps.places.map(query.get('key') ?? '')
        return result ? { status: 200, body: result } : { status: 404, body: { error: 'place_not_found' } }
      } catch {
        deps.log?.('PLACES', 'map unavailable')
        return unavailable
      }
    },
    'GET /v1/places': (_query, _body, caller, ctx) => {
      if (caller?.origin !== 'operator' && caller?.origin !== 'device') return { status: 403, body: { error: 'forbidden' } }
      try {
        if (!deps.places) return unavailable
        const body = deps.places.read(caller.origin)
        const headers = { etag: body.version }
        return ctx?.headers?.get('if-none-match') === body.version ? { status: 304, body: null, headers } : { status: 200, body, headers }
      } catch (error) {
        deps.log?.('PLACES', `read failed: ${readFailure(error)}`)
        return unavailable
      }
    },
    // 顺序和收起是主人在桌面上定的,只给 operator。
    'POST /v1/places/move': (_query, body, caller) => {
      if (caller?.origin !== 'operator') return { status: 403, body: { error: 'forbidden' } }
      const input = PlaceMoveRequest.safeParse(body)
      if (!input.success) return { status: 400, body: { error: 'invalid' } }
      if (!deps.places) return unavailable
      return deps.places.move(input.data.key, input.data.to) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not_found' } }
    },
    'POST /v1/places/hide': (_query, body, caller) => {
      if (caller?.origin !== 'operator') return { status: 403, body: { error: 'forbidden' } }
      const input = PlaceHideRequest.safeParse(body)
      if (!input.success) return { status: 400, body: { error: 'invalid' } }
      if (!deps.places) return unavailable
      return deps.places.hide(input.data.key, input.data.hidden) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not_found' } }
    },
    // 看过这一行:桌面和手机都是主人自己在看。
    'POST /v1/places/seen': (_query, body, caller) => {
      if (caller?.origin !== 'operator' && caller?.origin !== 'device') return { status: 403, body: { error: 'forbidden' } }
      const input = PlaceSeenRequest.safeParse(body)
      if (!input.success) return { status: 400, body: { error: 'invalid' } }
      if (!deps.places) return unavailable
      return deps.places.seen(input.data.key) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'not_found' } }
    },
  }
}

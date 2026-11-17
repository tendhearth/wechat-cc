import type { InternalApiDeps, RouteTable } from '../../daemon/internal-api/types'

export function rosterRoutes(deps: Pick<InternalApiDeps, 'roster'>): RouteTable {
  return { 'GET /v1/roster': (_query, _body, caller, ctx) => {
    if (caller?.origin !== 'operator' && caller?.origin !== 'device') return {status:403,body:{error:'forbidden'}}
    try {
      if (!deps.roster) throw Error('roster_unavailable')
      const body = deps.roster.read(caller.origin)
      const headers = {etag:body.version}
      return ctx?.headers?.get('if-none-match') === body.version
        ? {status:304,body:null,headers} : {status:200,body,headers}
    } catch { return {status:503,body:{error:'unavailable'}} }
  } }
}

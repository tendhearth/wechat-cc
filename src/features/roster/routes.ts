import type { InternalApiDeps, RouteTable } from '../../daemon/internal-api/types'

/** 读名单 / 地方出错时在日志里留一行。只记错误码样子的短串,别的只记错误类型——报错文字里可能带主人的内容。 */
export function readFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^[a-z0-9_]{1,64}$/.test(message) ? message : error instanceof Error ? error.name : typeof error
}

export function rosterRoutes(deps: Pick<InternalApiDeps, 'roster' | 'log'>): RouteTable {
  return { 'GET /v1/roster': (_query, _body, caller, ctx) => {
    if (caller?.origin !== 'operator' && caller?.origin !== 'device') return {status:403,body:{error:'forbidden'}}
    try {
      if (!deps.roster) throw Error('roster_unavailable')
      const body = deps.roster.read(caller.origin)
      const headers = {etag:body.version}
      return ctx?.headers?.get('if-none-match') === body.version
        ? {status:304,body:null,headers} : {status:200,body,headers}
    } catch (error) {
      deps.log?.('ROSTER', `read failed: ${readFailure(error)}`)
      return {status:503,body:{error:'unavailable'}}
    }
  } }
}

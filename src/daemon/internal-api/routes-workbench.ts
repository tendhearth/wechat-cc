import { isAbsolute } from 'node:path'
import type { WorkbenchListQuery } from '../../core/workbench/store'
import type { InternalApiDeps, RouteHandler, RouteTable } from './types'

const TASK_ID = /^[a-f0-9]{8}$/
const ARTIFACT_ID = /^[a-f0-9-]{8,64}$/
const SHA256 = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const PROVIDERS = new Set(['claude', 'codex'])

type JsonObject = Record<string, unknown>

function objectBody(body: unknown): JsonObject | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as JsonObject : null
}

function invalid(): ReturnType<RouteHandler> {
  return { status: 400, body: { error: 'invalid_request' } }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code
  return err instanceof Error ? err.message : ''
}

function mappedError(err: unknown): ReturnType<RouteHandler> {
  const code = errorCode(err)
  if (code === 'workbench_archived' || code === 'workbench_busy' || code === 'artifact_changed' || code === 'permission_stale' || code === 'restart_confirmation_required' || code === 'restart_confirmation_stale') return { status: 409, body: { error: code } }
  if (code === 'not_found') return { status: 404, body: { error: code } }
  if (code === 'unavailable_provider') return { status: 422, body: { error: code } }
  if (code.startsWith('invalid_')) return { status: 400, body: { error: code } }
  return { status: 500, body: { error: 'internal' } }
}

export function workbenchRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/workbench': async query => {
      for(const key of ['q','archived','limit','cursor'])if(query.getAll(key).length>1)return invalid()
      const q=query.get('q')?.trim(),archived=query.get('archived'),rawLimit=query.get('limit'),cursor=query.get('cursor')
      if((q!==undefined && q.length>200) || (archived!==null && !['exclude','only','all'].includes(archived)) ||
          (rawLimit!==null && (!/^\d+$/.test(rawLimit) || Number(rawLimit)<1 || Number(rawLimit)>100)))return invalid()
      if(cursor!==null && (!cursor || cursor.length>1024))return {status:400,body:{error:'invalid_cursor'}}
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      const filters:WorkbenchListQuery={
        ...(q!==undefined ? {q} : {}),...(archived!==null ? {archived:archived as WorkbenchListQuery['archived']} : {}),
        ...(rawLimit!==null ? {limit:Number(rawLimit)} : {}),...(cursor!==null ? {cursor} : {}),
      }
      try {return {status:200,body:await (Object.keys(filters).length ? deps.workbench.list(filters) : deps.workbench.list())}}
      catch(err){return mappedError(err)}
    },

    'GET /v1/workbench/task': async (query) => {
      const id = query.get('id')
      if (!id || !TASK_ID.test(id)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 200, body: await deps.workbench.detail(id) }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/create': async (_query, body) => {
      const value = objectBody(body)
      if (!value) return invalid()
      const title = typeof value.title === 'string' ? value.title.trim() : undefined
      const path = typeof value.path === 'string' ? value.path.trim() : ''
      const providerId = typeof value.providerId === 'string' ? value.providerId : ''
      const text = typeof value.text === 'string' ? value.text.trim() : ''
      if ((value.title !== undefined && (!title || title.length > 120)) ||
          !path || !isAbsolute(path) || !PROVIDERS.has(providerId) || !text || text.length > 20_000) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const task = await deps.workbench.create({ ...(title ? { title } : {}), path, providerId: providerId as 'claude' | 'codex', text })
        return { status: 202, body: { task } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/continue': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const text = typeof value?.text === 'string' ? value.text.trim() : ''
      const restartToken = value?.restartToken
      if (!TASK_ID.test(id) || !text || text.length > 20_000 ||
          (restartToken !== undefined && (typeof restartToken !== 'string' || !SHA256.test(restartToken)))) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        const task = restartToken === undefined
          ? await deps.workbench.continueTask(id, text)
          : await deps.workbench.continueTask(id, text, { restartToken: restartToken as string })
        return { status: 202, body: { task } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/archive': async (_query,body) => {
      const value=objectBody(body),id=typeof value?.id==='string' ? value.id : '',archived=value?.archived
      if(!TASK_ID.test(id) || typeof archived!=='boolean')return invalid()
      if(!deps.workbench)return {status:503,body:{error:'workbench_not_wired'}}
      try {return {status:200,body:{task:await deps.workbench.setArchived(id,archived)}}}
      catch(err){return mappedError(err)}
    },

    'POST /v1/workbench/cancel': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      if (!TASK_ID.test(id)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 202, body: { task: await deps.workbench.cancel(id) } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'GET /v1/workbench/artifact': async (query) => {
      const id = query.get('id') ?? ''
      const artifactId = query.get('artifactId') ?? ''
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        return { status: 200, body: await deps.workbench.artifact(id, artifactId) }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/approve': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const artifactId = typeof value?.artifactId === 'string' ? value.artifactId : ''
      const sha256 = typeof value?.sha256 === 'string' ? value.sha256 : ''
      if (!TASK_ID.test(id) || !ARTIFACT_ID.test(artifactId) || !SHA256.test(sha256)) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        await deps.workbench.approve(id, artifactId, sha256)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return mappedError(err)
      }
    },

    'POST /v1/workbench/permission': async (_query, body) => {
      const value = objectBody(body)
      const id = typeof value?.id === 'string' ? value.id : ''
      const requestId = typeof value?.requestId === 'string' ? value.requestId : ''
      const decision = value?.decision
      if (!TASK_ID.test(id) || !REQUEST_ID.test(requestId) || (decision !== 'allow' && decision !== 'deny')) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        await deps.workbench.resolvePermission(id, requestId, decision)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return mappedError(err)
      }
    },
  }
}

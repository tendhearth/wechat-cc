// src/daemon/internal-api/routes-knowledge.test.ts
//
// Knowledge Kernel Task 3 — the internal-api Ingest+Query surface over
// src/core/knowledge/store.ts (T1) + search.ts (T2). Mirrors
// routes-social.test.ts's real-deps-stub shape, but wires a REAL temp
// KnowledgeStore (not a vi.fn mock) since the whole point of this route
// table is thin pass-through to the store/search functions — a real store
// exercises putSourceMessages/listMessages/putSemantic/semanticSearch
// exactly as production wiring will.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeRoutes } from './routes-knowledge'
import { openKnowledge, type KnowledgeStore, type SourceMsg, type Chunk } from '../../core/knowledge/store'
import { semanticSearch } from '../../core/knowledge/search'
import type { InternalApiDeps } from './types'

function msg(msg_key: string, overrides: Partial<SourceMsg> = {}): SourceMsg {
  return {
    msg_key,
    conversation: 'wxid_alice',
    sender: 'alice',
    time: 1000,
    type: 'text',
    text: `text for ${msg_key}`,
    server_id: 'srv-1',
    ...overrides,
  }
}

function chunk(msg_key: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    msg_key,
    conversation: 'wxid_alice',
    sender: 'alice',
    time: 1000,
    kind: 'text',
    text: `hello world for ${msg_key}`,
    vector: [1, 0, 0],
    ...overrides,
  }
}

function deps(knowledge?: InternalApiDeps['knowledge']): InternalApiDeps {
  return { knowledge } as unknown as InternalApiDeps
}

describe('knowledgeRoutes', () => {
  describe('when deps.knowledge is undefined', () => {
    const routes = knowledgeRoutes(deps(undefined))

    it('503s every route', async () => {
      const q = new URLSearchParams()
      const cases: Array<[string, unknown]> = [
        ['POST /v1/knowledge/source/put', { messages: [] }],
        ['GET /v1/knowledge/messages', null],
        ['POST /v1/knowledge/semantic/put', { model_id: 'm', model_version: 'v', chunks: [] }],
        ['POST /v1/knowledge/search', { query: 'x', model_id: 'm', limit: 5, queryVector: [1] }],
        ['GET /v1/knowledge/semantic/status', null],
      ]
      for (const [key, body] of cases) {
        const handler = routes[key]
        expect(handler, key).toBeDefined()
        const r = await handler!(q, body)
        expect(r.status, key).toBe(503)
        expect(r.body).toEqual({ error: 'knowledge_not_wired' })
      }
    })
  })

  describe('with a real temp store wired', () => {
    let dir: string
    let store: KnowledgeStore
    let routes: ReturnType<typeof knowledgeRoutes>

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'kk-routes-'))
      store = openKnowledge(dir)
      routes = knowledgeRoutes(deps({ store, search: semanticSearch }))
    })

    afterEach(() => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })

    describe('POST /v1/knowledge/source/put + GET /v1/knowledge/messages', () => {
      it('ingests messages then pages them back by watermark', async () => {
        const putR = await routes['POST /v1/knowledge/source/put']!(new URLSearchParams(), {
          messages: [msg('m1'), msg('m2'), msg('m3')],
        })
        expect(putR.status).toBe(200)
        expect(putR.body).toEqual({ ok: true, watermark: 3 })

        const page1 = await routes['GET /v1/knowledge/messages']!(
          new URLSearchParams({ since_watermark: '0', limit: '2' }),
          null,
        )
        expect(page1.status).toBe(200)
        expect((page1.body as any).messages).toHaveLength(2)
        expect((page1.body as any).watermark).toBe(2)

        const page2 = await routes['GET /v1/knowledge/messages']!(
          new URLSearchParams({ since_watermark: String((page1.body as any).watermark) }),
          null,
        )
        expect(page2.status).toBe(200)
        expect((page2.body as any).messages).toHaveLength(1)
        expect((page2.body as any).messages[0].msg_key).toBe('m3')
      })

      it('defaults since_watermark=0 and limit=500 when omitted', async () => {
        await routes['POST /v1/knowledge/source/put']!(new URLSearchParams(), { messages: [msg('m1')] })
        const r = await routes['GET /v1/knowledge/messages']!(new URLSearchParams(), null)
        expect(r.status).toBe(200)
        expect((r.body as any).messages).toHaveLength(1)
      })

      it('400 when messages is not an array', async () => {
        const r = await routes['POST /v1/knowledge/source/put']!(new URLSearchParams(), { messages: 'nope' })
        expect(r.status).toBe(400)
        expect(r.body).toEqual({ error: 'invalid_messages' })
      })
    })

    describe('POST /v1/knowledge/semantic/put + POST /v1/knowledge/search', () => {
      it('indexes a chunk then search returns it for a matching queryVector', async () => {
        const putR = await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_id: 'model-a',
          model_version: 'v1',
          chunks: [chunk('m1')],
        })
        expect(putR.status).toBe(200)
        expect(putR.body).toEqual({ ok: true })

        const searchR = await routes['POST /v1/knowledge/search']!(new URLSearchParams(), {
          query: 'hello',
          model_id: 'model-a',
          limit: 5,
          queryVector: [1, 0, 0],
        })
        expect(searchR.status).toBe(200)
        const body = searchR.body as any
        expect(body.results.length).toBeGreaterThan(0)
        expect(body.results[0].text).toContain('m1')
      })

      it('400 query_vector_required when queryVector is absent', async () => {
        const r = await routes['POST /v1/knowledge/search']!(new URLSearchParams(), {
          query: 'hello',
          model_id: 'model-a',
          limit: 5,
        })
        expect(r.status).toBe(400)
        expect(r.body).toEqual({ error: 'query_vector_required' })
      })

      it('400 on bad body for semantic/put (missing model_id)', async () => {
        const r = await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_version: 'v1',
          chunks: [],
        })
        expect(r.status).toBe(400)
      })
    })

    describe('GET /v1/knowledge/semantic/status', () => {
      it('reports indexed count and model meta', async () => {
        store.setMeta('embed_model', 'model-a')
        await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_id: 'model-a',
          model_version: 'v1',
          chunks: [chunk('m1'), chunk('m2')],
        })
        const r = await routes['GET /v1/knowledge/semantic/status']!(new URLSearchParams(), null)
        expect(r.status).toBe(200)
        expect(r.body).toEqual({ indexed: 2, model: 'model-a' })
      })
    })
  })
})

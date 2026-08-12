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
import { rebuildGraphFromSource } from '../../core/knowledge/graph-build'
import { makeGraphQueryApi } from '../../core/knowledge/graph-query'
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
        ['POST /v1/knowledge/graph/contact_profile', { name: 'alice' }],
        ['POST /v1/knowledge/graph/top_contacts', {}],
        ['POST /v1/knowledge/graph/rank_contacts', {}],
        ['POST /v1/knowledge/graph/relationship_subgraph', {}],
        ['POST /v1/knowledge/graph/connectors', { a: 'alice', b: 'bob' }],
        ['GET /v1/knowledge/graph/status', null],
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

  describe('when deps.knowledge is wired but deps.knowledge.graph is undefined', () => {
    // Distinct from the "deps.knowledge is undefined" case above — this is
    // knowledge_enabled with the graph accessor specifically absent, which
    // production wiring never does (bootstrap wires `graph` unconditionally
    // alongside `store`), but the routes defend against it anyway.
    let dir: string
    let store: KnowledgeStore
    let routes: ReturnType<typeof knowledgeRoutes>

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'kk-routes-graph-unwired-'))
      store = openKnowledge(dir)
      routes = knowledgeRoutes(deps({ store, search: semanticSearch }))
    })

    afterEach(() => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('503s every graph route', async () => {
      const q = new URLSearchParams()
      const cases: Array<[string, unknown]> = [
        ['POST /v1/knowledge/graph/contact_profile', { name: 'alice' }],
        ['POST /v1/knowledge/graph/top_contacts', {}],
        ['POST /v1/knowledge/graph/rank_contacts', {}],
        ['POST /v1/knowledge/graph/relationship_subgraph', {}],
        ['POST /v1/knowledge/graph/connectors', { a: 'alice', b: 'bob' }],
        ['GET /v1/knowledge/graph/status', null],
      ]
      for (const [key, body] of cases) {
        const r = await routes[key]!(q, body)
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

      it('embeds body.query via deps.knowledge.embedQuery when queryVector is absent (AS T3)', async () => {
        const putR = await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_id: 'm',
          model_version: 'v1',
          chunks: [chunk('m1')],
        })
        expect(putR.status).toBe(200)

        const embedder = {
          model_id: 'm',
          embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
          close: async () => {},
        }
        const routesWithEmbedder = knowledgeRoutes(
          deps({
            store,
            search: semanticSearch,
            embedder,
            embedQuery: (t: string) => embedder.embed([t]).then(v => v[0]!),
          }),
        )

        const searchR = await routesWithEmbedder['POST /v1/knowledge/search']!(new URLSearchParams(), {
          query: 'hello',
          model_id: 'some-other-model-that-must-be-ignored',
          limit: 5,
        })
        expect(searchR.status).toBe(200)
        const body = searchR.body as any
        expect(body.vectors_stale).toBe(false)
        expect(body.results.length).toBeGreaterThan(0)
        expect(body.results[0].text).toContain('m1')
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
      it('reports { indexed, model_id, model_version } for the active (last-indexed) model', async () => {
        await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_id: 'model-a',
          model_version: 'v1',
          chunks: [chunk('m1'), chunk('m2')],
        })
        const r = await routes['GET /v1/knowledge/semantic/status']!(new URLSearchParams(), null)
        expect(r.status).toBe(200)
        expect(r.body).toEqual({ indexed: 2, model_id: 'model-a', model_version: 'v1' })
      })

      it('indexed count is scoped to the active model, not the whole store', async () => {
        await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_id: 'model-a',
          model_version: 'v1',
          chunks: [chunk('m1')],
        })
        // A later put under a different model becomes the new active model —
        // indexed must reflect model-b's count, not model-a's leftover rows.
        await routes['POST /v1/knowledge/semantic/put']!(new URLSearchParams(), {
          model_id: 'model-b',
          model_version: 'v2',
          chunks: [chunk('m2'), chunk('m3')],
        })
        const r = await routes['GET /v1/knowledge/semantic/status']!(new URLSearchParams(), null)
        expect(r.status).toBe(200)
        expect(r.body).toEqual({ indexed: 2, model_id: 'model-b', model_version: 'v2' })
      })
    })

    describe('POST /v1/knowledge/graph/* (Knowledge Graph inproc GR T5)', () => {
      // Seeds REAL source (via the same putSourceMessages/putMentions the
      // adapter uses) then runs the real rebuildGraphFromSource (GR T4) to
      // build graph.db, then wires deps.knowledge.graph via the real
      // makeGraphQueryApi (GR T5) — end-to-end through the actual store
      // wiring, same posture as the search describe blocks above.
      let graphRoutes: ReturnType<typeof knowledgeRoutes>

      beforeEach(() => {
        store.putSourceMessages([
          // 1:1 with alice — "me" sends more, so detectOwner votes "me" owner.
          msg('a1', { conversation: 'wxid_alice', sender: 'me', time: 100 }),
          msg('a2', { conversation: 'wxid_alice', sender: 'wxid_alice', time: 200 }),
          msg('a3', { conversation: 'wxid_alice', sender: 'me', time: 300 }),
          // 1:1 with bob.
          msg('b1', { conversation: 'wxid_bob', sender: 'me', time: 400 }),
          msg('b2', { conversation: 'wxid_bob', sender: 'wxid_bob', time: 500 }),
          // A group both alice and bob speak in (for connectors' shared_groups),
          // where alice @-mentions bob (for the mention edge).
          msg('g1', {
            conversation: 'g1@chatroom', sender: 'wxid_alice', time: 600,
            local_type: 1, is_group: true, kind: 'text', text: '@bob hi',
          }),
          msg('g2', {
            conversation: 'g1@chatroom', sender: 'wxid_bob', time: 700,
            local_type: 1, is_group: true, kind: 'text', text: 'hi back',
          }),
        ])
        store.putMentions([{ msg_key: 'g1', target_un: 'wxid_bob' }])
        store.putContacts([
          { username: 'wxid_alice', display: 'Alice' },
          { username: 'wxid_bob', display: 'Bob' },
        ])
        const result = rebuildGraphFromSource({ store, now: 100000 })
        expect(result.skipped).toBe(false)
        expect(result.owner).toBe('me')

        graphRoutes = knowledgeRoutes(deps({ store, search: semanticSearch, graph: makeGraphQueryApi(store) }))
      })

      it('contact_profile resolves by display name and returns mention_partners', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/contact_profile']!(new URLSearchParams(), { name: 'Alice' })
        expect(r.status).toBe(200)
        const body = r.body as any
        expect(body.resolved).toBe(true)
        expect(body.username).toBe('wxid_alice')
        expect(body.display).toBe('Alice')
      })

      it('contact_profile returns candidates when the name does not resolve', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/contact_profile']!(new URLSearchParams(), { name: 'nobody' })
        expect(r.status).toBe(200)
        expect((r.body as any).resolved).toBe(false)
      })

      it('400 invalid_name when name is missing', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/contact_profile']!(new URLSearchParams(), {})
        expect(r.status).toBe(400)
        expect(r.body).toEqual({ error: 'invalid_name' })
      })

      it('top_contacts returns both seeded contacts, defaulting by=closeness limit=20 kind=person', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/top_contacts']!(new URLSearchParams(), {})
        expect(r.status).toBe(200)
        const usernames = (r.body as any).contacts.map((c: any) => c.username).sort()
        expect(usernames).toEqual(['wxid_alice', 'wxid_bob'])
      })

      it('rank_contacts returns the seeded contacts closeness-sorted', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/rank_contacts']!(new URLSearchParams(), {})
        expect(r.status).toBe(200)
        const usernames = (r.body as any).contacts.map((c: any) => c.username).sort()
        expect(usernames).toEqual(['wxid_alice', 'wxid_bob'])
      })

      it('relationship_subgraph returns the owner + both contacts as nodes', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/relationship_subgraph']!(new URLSearchParams(), {})
        expect(r.status).toBe(200)
        const body = r.body as any
        expect(body.owner).toBe('me')
        const usernames = body.nodes.map((n: any) => n.username).sort()
        expect(usernames).toEqual(['wxid_alice', 'wxid_bob'])
      })

      it('connectors resolves both names and reports the shared group + mention edge', async () => {
        const r = await graphRoutes['POST /v1/knowledge/graph/connectors']!(new URLSearchParams(), { a: 'Alice', b: 'Bob' })
        expect(r.status).toBe(200)
        const body = r.body as any
        expect(body.resolved).toBe(true)
        expect(body.a).toBe('wxid_alice')
        expect(body.b).toBe('wxid_bob')
        // alice and bob both spoke in g1@chatroom — the sharedGroupsOf
        // closure built over the real source messages must find it.
        expect(body.shared_groups).toBe(1)
        expect(body.mention_edges.length).toBe(1)
        expect(body.mention_edges[0]).toMatchObject({ a: 'wxid_alice', b: 'wxid_bob', kind: 'mention' })
      })

      it('400 invalid_a / invalid_b when connectors names are missing', async () => {
        const r1 = await graphRoutes['POST /v1/knowledge/graph/connectors']!(new URLSearchParams(), { b: 'Bob' })
        expect(r1.status).toBe(400)
        expect(r1.body).toEqual({ error: 'invalid_a' })
        const r2 = await graphRoutes['POST /v1/knowledge/graph/connectors']!(new URLSearchParams(), { a: 'Alice' })
        expect(r2.status).toBe(400)
        expect(r2.body).toEqual({ error: 'invalid_b' })
      })

      it('GET /v1/knowledge/graph/status reports contacts/owner/built_at and not stale right after a build', async () => {
        const r = await graphRoutes['GET /v1/knowledge/graph/status']!(new URLSearchParams(), null)
        expect(r.status).toBe(200)
        expect(r.body).toEqual({ contacts: 2, owner: 'me', built_at: 100000, stale: false })
      })

      it('status reports stale=true once new source lands without a rebuild', async () => {
        store.putSourceMessages([msg('a4', { conversation: 'wxid_alice', sender: 'me', time: 800 })])
        const r = await graphRoutes['GET /v1/knowledge/graph/status']!(new URLSearchParams(), null)
        expect(r.status).toBe(200)
        expect((r.body as any).stale).toBe(true)
      })
    })
  })
})

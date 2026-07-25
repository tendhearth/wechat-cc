// src/daemon/internal-api/routes-memory.test.ts
//
// Mirrors routes-social.test.ts's injection idiom. NOTE: the dep is named
// `memoryLlm` (not `memory`) — InternalApiDeps already has `memory?: MemoryFS`
// (the sandbox FS backing memory_read/write/list), so the daemon-owns-LLM-
// memory-ops dep (MemoryLlmOps: synthesize/generateProfile) gets its own
// field name to avoid colliding with that existing type.
import { describe, it, expect, vi } from 'vitest'
import { memoryRoutes } from './routes-memory'
import type { InternalApiDeps } from './types'
const q = () => new URLSearchParams()

function deps(over: Record<string, unknown> = {}): InternalApiDeps {
  return {
    memoryLlm: {
      synthesize: vi.fn(async () => ({ ok: true, written: { path: '_overview.md', bytesWritten: 10 } })),
      generateProfile: vi.fn(async () => ({ ok: true, written: { path: '_profile.json', bytesWritten: 5 } })),
    },
    resolveAdminChatId: () => 'admin1',
    ...over,
  } as unknown as InternalApiDeps
}

describe('POST /v1/memory/synthesize', () => {
  it('未接线 → 503', async () => {
    const r = await memoryRoutes(deps({ memoryLlm: undefined }))['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(503)
  })
  it('透传 synthesize;缺省 chat_id 用 resolveAdminChatId', async () => {
    const d = deps(); const r = await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(200); expect((r.body as any).written.path).toBe('_overview.md')
    expect((d.memoryLlm as any).synthesize).toHaveBeenCalledWith('admin1')
  })
  it('body.chat_id 覆盖', async () => {
    const d = deps(); await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), { chat_id: 'c9' })
    expect((d.memoryLlm as any).synthesize).toHaveBeenCalledWith('c9')
  })
  it('无 chat_id 且无 resolveAdminChatId(或返回 null) → 400', async () => {
    const d = deps({ resolveAdminChatId: () => null }); const r = await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(400)
  })
})
describe('POST /v1/memory/profile/generate', () => {
  it('透传 generateProfile', async () => {
    const d = deps(); const r = await memoryRoutes(d)['POST /v1/memory/profile/generate']!(q(), { chat_id: 'c9' })
    expect(r.status).toBe(200); expect((r.body as any).written.path).toBe('_profile.json')
    expect((d.memoryLlm as any).generateProfile).toHaveBeenCalledWith('c9')
  })
  it('未接线 → 503', async () => {
    const r = await memoryRoutes(deps({ memoryLlm: undefined }))['POST /v1/memory/profile/generate']!(q(), {})
    expect(r.status).toBe(503)
  })
})

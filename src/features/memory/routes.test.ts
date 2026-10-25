// 记忆功能的 LLM / 每晚整理路由(原 internal-api/routes-memory.test.ts)。两样都是现取的:
// 这里的 `memoryLlm` / `memoryNightly` 写成值(undefined = 还没有),deps() 包成取值函数。
import { describe, it, expect, vi } from 'vitest'
import { memoryRoutes } from './routes'
import type { MemoryRoutesDeps } from './routes'
const q = () => new URLSearchParams()

function deps(over: Record<string, unknown> = {}): MemoryRoutesDeps {
  const o: Record<string, unknown> = {
    memoryLlm: {
      synthesize: vi.fn(async () => ({ ok: true, written: { path: '_overview.md', bytesWritten: 10 } })),
      generateProfile: vi.fn(async () => ({ ok: true, written: { path: '_profile.json', bytesWritten: 5 } })),
    },
    resolveAdminChatId: () => 'admin1',
    ...over,
  }
  return {
    stateDir: '',
    memoryLlm: () => (o.memoryLlm ?? null) as ReturnType<MemoryRoutesDeps['memoryLlm']>,
    memoryNightly: () => (o.memoryNightly ?? null) as ReturnType<MemoryRoutesDeps['memoryNightly']>,
    resolveAdminChatId: o.resolveAdminChatId as MemoryRoutesDeps['resolveAdminChatId'],
  }
}

describe('POST /v1/memory/synthesize', () => {
  it('未接线 → 503', async () => {
    const r = await memoryRoutes(deps({ memoryLlm: undefined }))['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(503)
  })
  it('透传 synthesize;缺省 chat_id 用 resolveAdminChatId', async () => {
    const d = deps(); const r = await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(200); expect((r.body as any).written.path).toBe('_overview.md')
    expect((d.memoryLlm() as any).synthesize).toHaveBeenCalledWith('admin1')
  })
  it('body.chat_id 覆盖', async () => {
    const d = deps(); await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), { chat_id: 'c9' })
    expect((d.memoryLlm() as any).synthesize).toHaveBeenCalledWith('c9')
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
    expect((d.memoryLlm() as any).generateProfile).toHaveBeenCalledWith('c9')
  })
  it('未接线 → 503', async () => {
    const r = await memoryRoutes(deps({ memoryLlm: undefined }))['POST /v1/memory/profile/generate']!(q(), {})
    expect(r.status).toBe(503)
  })
})
describe('POST /v1/memory/nightly/run', () => {
  it('POST /v1/memory/nightly/run runs the nightly tidy now and returns its result', async () => {
    const runNow = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'no_new_material' })
    const r = await memoryRoutes(deps({ memoryNightly: { runNow } }))['POST /v1/memory/nightly/run']!(q(), {})
    expect(r).toEqual({ status: 200, body: { ok: true, result: { status: 'skipped', reason: 'no_new_material' } } })
  })
  it('POST /v1/memory/nightly/run is 503 when not wired', async () => {
    expect(await memoryRoutes(deps())['POST /v1/memory/nightly/run']!(q(), {})).toEqual({ status: 503, body: { error: 'memory_nightly_not_wired' } })
  })
})

describe('POST /v1/memory/view · /v1/memory/edit(记忆编辑)', () => {
  const view = { chatId: 'admin1', path: '_overview.md', baseHash: 'a'.repeat(64), generatedAt: null, stale: false, lines: [] }
  const nightly = (over: Record<string, unknown> = {}) => ({ runNow: vi.fn(), view: vi.fn(() => view), edit: vi.fn(async () => ({ ok: false, code: 'memory_changed' })), ...over })
  it('未接线 → 503', async () => {
    expect((await memoryRoutes(deps())['POST /v1/memory/view']!(q(), { path: 'memory.md' })).status).toBe(503)
    expect((await memoryRoutes(deps())['POST /v1/memory/edit']!(q(), {})).status).toBe(503)
  })
  it('view 透传 path;业务上的拒绝是 200 + ok:false,照原样给桌面', async () => {
    const n = nightly()
    const v = await memoryRoutes(deps({ memoryNightly: n }))['POST /v1/memory/view']!(q(), { path: '_overview.md' })
    expect(v).toEqual({ status: 200, body: { ok: true, ...view } })
    const e = await memoryRoutes(deps({ memoryNightly: n }))['POST /v1/memory/edit']!(q(), { path: 'memory.md', baseHash: 'b'.repeat(64), lines: [] })
    expect(e).toEqual({ status: 200, body: { ok: false, code: 'memory_changed' } })
  })
  it('没有主人 → 409 memory_no_owner;别的异常 → 500,不漏错误原文', async () => {
    const noOwner = nightly({ view: vi.fn(() => { throw new Error('no_owner') }) })
    expect(await memoryRoutes(deps({ memoryNightly: noOwner }))['POST /v1/memory/view']!(q(), { path: 'memory.md' })).toEqual({ status: 409, body: { ok: false, code: 'memory_no_owner' } })
    const boom = nightly({ edit: vi.fn(async () => { throw new Error('/secret/path EACCES') }) })
    expect(await memoryRoutes(deps({ memoryNightly: boom }))['POST /v1/memory/edit']!(q(), {})).toEqual({ status: 500, body: { ok: false, code: 'memory_edit_failed' } })
  })
})

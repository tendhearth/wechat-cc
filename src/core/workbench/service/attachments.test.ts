import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import type { Attachment } from '../attachments'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState } from './state'
import { makeAttachmentsDomain } from './attachments'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

/** 最小 ctx:真 store,主人可配可不配(owner=null 模拟「还没配主人」)。 */
function setup(owner: string | null = 'owner') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-attachments-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const log = vi.fn()
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => owner, registry: createProviderRegistry() }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, log, now: Date.now, actions: new Ref<ServiceActions>('t') }
  const domain = makeAttachmentsDomain(ctx)
  const task = (ownerChatId: string | null) => store.create({ title: '事', path: project, providerId: 'claude', ownerChatId })
  return { store, state, domain, task, log, project }
}

const att = (id: string, size = 1): Attachment => ({ id, size } as unknown as Attachment)

describe('makeAttachmentsDomain · 作用域', () => {
  it('attachmentScope:配了主人 ⇒ 带 allowLegacyUnbound;没配 ⇒ undefined', () => {
    expect(setup().domain.attachmentScope()).toEqual({ ownerKey: 'owner', allowLegacyUnbound: true })
    expect(setup(null).domain.attachmentScope()).toBeUndefined()
  })
  it('strictAttachmentScope:没配主人 ⇒ invalid_entry_owner;别人的任务 ⇒ attachment_scope;自己的 ⇒ {ownerKey}', () => {
    expect(() => setup(null).domain.strictAttachmentScope()).toThrow('invalid_entry_owner')
    const { domain, task } = setup()
    expect(() => domain.strictAttachmentScope(task('someone-else').id)).toThrow('attachment_scope')
    expect(domain.strictAttachmentScope(task('owner').id)).toEqual({ ownerKey: 'owner' })
  })
  it('continuationAttachmentScope:老任务(owner=NULL)+ 空材料 ⇒ undefined 放行;带材料 / 非数组 / 别人的任务 ⇒ attachment_scope', () => {
    const { domain, task } = setup()
    const legacy = task(null).id
    expect(domain.continuationAttachmentScope(legacy, [])).toBeUndefined()
    expect(() => domain.continuationAttachmentScope(legacy, ['a'])).toThrow('attachment_scope')
    expect(() => domain.continuationAttachmentScope(legacy, undefined)).toThrow('attachment_scope')
    expect(() => domain.continuationAttachmentScope(task('someone-else').id, [])).toThrow('attachment_scope')
    expect(domain.continuationAttachmentScope(task('owner').id, [])).toEqual({ ownerKey: 'owner' })
  })
  it('selectAttachments:不带材料、不带策略 ⇒ 空数组,不要求主人', () => {
    expect(setup(null).domain.selectAttachments()).toEqual([])
    expect(setup(null).domain.selectAttachments({}, undefined)).toEqual([])
  })
})

describe('makeAttachmentsDomain · 合并', () => {
  it('combinedAttachments:previous 在前、同 id 取 current 的字段但位置留在 previous 处;超 8 个或 24 MiB ⇒ invalid_attachment_context_limit', () => {
    const { domain } = setup()
    const merged = domain.combinedAttachments([att('b', 2), att('c')], [att('a'), att('b', 9)])
    expect(merged.map(a => [a.id, a.size])).toEqual([['a', 1], ['b', 2], ['c', 1]])
    expect(() => domain.combinedAttachments(Array.from({ length: 9 }, (_, i) => att(String(i))))).toThrow('invalid_attachment_context_limit')
    expect(() => domain.combinedAttachments([att('x', 24 * 1024 * 1024 + 1)])).toThrow('invalid_attachment_context_limit')
    expect(domain.combinedAttachments([att('x', 24 * 1024 * 1024)])).toHaveLength(1)
  })
})

describe('makeAttachmentsDomain · 入口闸', () => {
  it('stopping 之后 uploadAttachment / uploadAttachmentChunk 抛 workbench_stopping', () => {
    const { domain, state } = setup()
    state.stopping = true
    expect(() => domain.uploadAttachment({} as never)).toThrow('workbench_stopping')
    expect(() => domain.uploadAttachmentChunk({} as never, { ownerKey: 'owner', surface: 'phone' })).toThrow('workbench_stopping')
  })
  it('uploadAttachment:归档任务 ⇒ workbench_archived(在碰 store.attachments.upload 之前)', () => {
    const { domain, task, store } = setup()
    const id = task('owner').id
    store.update(id, 'completed'); store.setArchived(id, true)
    const upload = vi.spyOn(store.attachments, 'upload')
    expect(() => domain.uploadAttachment({ taskId: id } as never)).toThrow('workbench_archived')
    expect(upload).not.toHaveBeenCalled()
  })
  it('readAttachment:任务不存在 ⇒ not_found', () => {
    expect(() => setup().domain.readAttachment('deadbeef', 'x')).toThrow('not_found')
  })
  it('uploads():懒建且只建一次;onTransaction 走 ctx.log', () => {
    const { domain, store, log } = setup()
    const spy = vi.spyOn(store, 'attachmentUploads')
    expect(spy).not.toHaveBeenCalled()
    const a = domain.uploads(), b = domain.uploads()
    expect(a).toBe(b); expect(spy).toHaveBeenCalledTimes(1)
    const opts = spy.mock.calls[0]![0]
    opts.onTransaction!({ operation: 'reserve', durationMs: 1.5 } as never)
    expect(log).toHaveBeenCalledWith('attachment-upload', 'reserve lock_ms=1.5')
  })
  it('discardAttachment:没配主人时,已落库的材料走 attachmentScope(不抛 invalid_entry_owner);上传中的走 strict(抛)', () => {
    const { domain, store } = setup(null)
    vi.spyOn(store, 'uploadRequestExists').mockReturnValueOnce(false)
    const discard = vi.spyOn(store.attachments, 'discard').mockReturnValueOnce(undefined as never)
    domain.discardAttachment('att-1', 'draft-1')
    expect(discard).toHaveBeenCalledWith('att-1', 'draft-1', undefined)
    vi.spyOn(store, 'uploadRequestExists').mockReturnValueOnce(true)
    expect(() => domain.discardAttachment('att-2', 'draft-1')).toThrow('invalid_entry_owner')
  })
})

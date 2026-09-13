import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchController, renderWorkbench } from './workbench.js'

const task = (id: string, options = {}) => ({ id, title: id, path: '/work', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null, archivedAt: null, canArchive: true, ...options })
const providers = [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude Code' }]
const list = (tasks: ReturnType<typeof task>[], nextCursor: string | null = null) => ({ tasks, providers, defaultProvider: 'codex', canWechat: false, page: { limit: 2, total: 4, hasMore: !!nextCursor, nextCursor } })
const detail = (value = task('A')) => ({ task: value, events: [], artifacts: [], permissions: [{ id: 'REQ', taskId: value.id, tool: 'Shell', description: 'Run tests', createdAt: 1 }] })

afterEach(() => { vi.resetModules() })

describe('workbench task organization', () => {
  it('loads older pages once, deduplicates IDs and refetches all loaded pages with fresh cursors on refresh', async () => {
    let revision = 0
    const api = vi.fn(async (_method: string, path: string) => {
      if (path.startsWith('/v1/workbench/task?')) return detail()
      if (path === '/v1/workbench') return list([task('A'), task('B')], revision ? 'fresh-cursor' : 'old-cursor')
      if (path.includes('old-cursor')) return list([task('B'), task('C')])
      if (path.includes('fresh-cursor')) return list([task('C'), task('D')])
      throw Error(`Unexpected path ${path}`)
    })
    const controller = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn() })
    await controller.refresh()
    expect(typeof controller.loadMore).toBe('function')
    await controller.loadMore()
    expect(controller.state.tasks.map(value => value.id)).toEqual(['A', 'B', 'C'])
    revision++
    await controller.refresh()
    expect(controller.state.tasks.map(value => value.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(api).toHaveBeenCalledWith('GET', '/v1/workbench?cursor=fresh-cursor')
    expect(controller.state.page?.hasMore).toBe(false)
  })

  it('combines authoritative project executors across loaded pages and replaces them on a fresh query', async () => {
    const api = vi.fn(async (_method: string, path: string) => {
      if (path.includes('/task?')) return detail()
      if (path.includes('q=')) return { ...list([task('C', { path: '/other' })]), projectProviders: { '/other': 'codex' } }
      if (path.includes('cursor=')) return { ...list([task('B', { path: '/other' })]), projectProviders: { '/other': 'claude' } }
      return { ...list([task('A')], 'next'), projectProviders: { '/work': 'claude' } }
    })
    const controller = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn() })
    await controller.refresh()
    await controller.loadMore()
    expect(controller.state.projectProviders).toEqual({ '/work': 'claude', '/other': 'claude' })
    await controller.refresh()
    expect(controller.state.projectProviders).toEqual({ '/work': 'claude', '/other': 'claude' })
    await controller.filterTasks({ q: 'other', archived: 'exclude' })
    expect(controller.state.projectProviders).toEqual({ '/other': 'codex' })
  })

  it('ignores an older query response after search changes and keeps the selected detail and permission requests', async () => {
    let resolveOld!: (value: unknown) => void
    const oldResponse = new Promise(resolve => { resolveOld = resolve })
    const api = vi.fn(async (_method: string, path: string) => {
      if (path.startsWith('/v1/workbench/task?')) return detail()
      if (path === '/v1/workbench') return list([task('A')])
      if (path.includes('q=old')) return oldResponse
      return list([task('MATCH')])
    })
    const controller = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn() })
    await controller.refresh()
    expect(typeof controller.filterTasks).toBe('function')
    const old = controller.filterTasks({ q: 'old', archived: 'exclude' })
    await controller.filterTasks({ q: ' /other & folder ', archived: 'only' })
    resolveOld(list([task('STALE')]))
    await old
    expect(controller.state.tasks.map(value => value.id)).toEqual(['MATCH'])
    expect(controller.state.selectedId).toBe('A')
    expect(controller.state.detail?.task.id).toBe('A')
    expect(controller.state.detail?.permissions?.[0]?.id).toBe('REQ')
    expect(api).toHaveBeenCalledWith('GET', '/v1/workbench?q=%2Fother+%26+folder&archived=only')
    expect(controller.state.query).toEqual({ q: '/other & folder', archived: 'only' })
  })

  it('skips competing list polling while an older page loads but refreshes the open detail', async () => {
    let finishMore!: (value: unknown) => void
    const more = new Promise(resolve => { finishMore = resolve })
    const api = vi.fn(async (_method: string, path: string) => path.includes('/task?') ? detail() : path.includes('cursor=') ? more : list([task('A')], 'next'))
    const controller = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn() })
    await controller.refresh()
    expect(typeof controller.loadMore).toBe('function')
    const pending = controller.loadMore()
    const duplicate = controller.loadMore()
    await controller.refresh()
    expect(api.mock.calls.filter(([, path]) => path === '/v1/workbench')).toHaveLength(1)
    expect(api.mock.calls.filter(([, path]) => path.includes('/task?'))).toHaveLength(2)
    finishMore(list([task('B')]))
    await Promise.all([pending, duplicate])
    expect(controller.state.tasks.map(value => value.id)).toEqual(['A', 'B'])
  })

  it('discards an old load-more response after filtering without hiding the artifact preview', async () => {
    let finishMore!: (value: unknown) => void
    const more = new Promise(resolve => { finishMore = resolve })
    const artifact = { id: 'FILE', taskId: 'A', name: 'report.md', mime: 'text/markdown', size: 1, sha256: 'a', createdAt: 1, approvedAt: null }
    const api = vi.fn(async (_method: string, path: string) => path.includes('/task?') ? { ...detail(), artifacts: [artifact] } : path.includes('cursor=') ? more : path.includes('archived=') ? list([]) : list([task('A')], 'next'))
    const controller = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn() })
    await controller.refresh()
    controller.state.preview = { artifactId: 'FILE', html: 'Saved preview' }
    expect(typeof controller.loadMore).toBe('function')
    const pending = controller.loadMore()
    await controller.filterTasks({ q: '', archived: 'only' })
    finishMore(list([task('STALE')]))
    await pending
    expect(controller.state.tasks).toEqual([])
    expect(controller.state.preview?.html).toBe('Saved preview')
    expect(controller.state.selectedId).toBe('A')
  })

  it('restores an archived selected task absent from the visible list and recognizes project new scopes', async () => {
    const api = vi.fn(async (_method: string, path: string) => path.includes('/task?') ? detail(task('SAVED', { archivedAt: 5 })) : list([task('OTHER')]))
    const controller = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn(), initialScope: 'task:SAVED' })
    await controller.refresh()
    expect(controller.state.selectedId).toBe('SAVED')
    const project = createWorkbenchController({ invokeWorkbenchApi: api, render: vi.fn(), initialScope: 'new:/work' })
    await project.refresh()
    expect(project.state.selectedId).toBeNull()
    expect(project.state.newScope).toBe('new:/work')
  })

  it('renders server-backed title/folder search, archived filtering, project creation and conditional paging', () => {
    const controller = createWorkbenchController({ invokeWorkbenchApi: vi.fn(), render: vi.fn() })
    Object.assign(controller.state, list([task('A')], 'next'), { query: { q: '<folder>', archived: 'only' } })
    const html = renderWorkbench(controller.state)
    expect(html).toContain('id="wb-search-form"')
    expect(html).toContain('placeholder="搜索任务或文件夹"')
    expect(html).toContain('maxlength="200"')
    expect(html).toContain('value="&lt;folder&gt;"')
    expect(html).toContain('返回任务')
    expect(html).toContain('data-action="clear-search"')
    expect(html).toContain('加载更早的任务')
    expect(html).toContain('aria-label="在 work 新建任务"')
    expect(html).toContain('data-project-path="/work"')
    controller.state.page = { limit: 2, total: 0, hasMore: false, nextCursor: null }
    controller.state.tasks = []
    expect(renderWorkbench(controller.state)).not.toContain('加载更早的任务')
    expect(renderWorkbench(controller.state)).toContain('没有找到匹配的任务')
  })

  it('uses exact backend archive eligibility and replaces archived continuation with restore', () => {
    const controller = createWorkbenchController({ invokeWorkbenchApi: vi.fn(), render: vi.fn() })
    controller.state.detail = detail(task('A', { canArchive: false, error: 'writer_not_closed' }))
    expect(renderWorkbench(controller.state)).not.toContain('data-action="archive-task"')
    controller.state.detail.task.canArchive = true
    const eligible = renderWorkbench(controller.state)
    expect(eligible).toMatch(/class="wb-task-info-body"[\s\S]*data-action="archive-task"/)
    controller.state.detail.task.archivedAt = 5
    const archived = renderWorkbench(controller.state)
    expect(archived).toContain('已归档')
    expect(archived).toContain('恢复后可继续')
    expect(archived).toContain('data-action="restore-task"')
    expect(archived).not.toContain('data-action="continue"')
    expect(archived).not.toContain('data-action="restart"')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

const root = globalThis as unknown as { window?: unknown; document?: unknown }

afterEach(() => {
  delete root.window
  delete root.document
  vi.useRealTimers()
  vi.resetModules()
})

describe('workbench rendering', () => {
  it('escapes task and event content before putting it in the page', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const html = renderWorkbench({
      tasks: [{ id: 'A1B2C3D4', title: '<img src=x onerror=alert(1)>', path: '/tmp/<work>', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }],
      providers: [{ id: 'codex', displayName: 'Codex <unsafe>' }], defaultProvider: 'codex', canWechat: true,
      selectedId: 'A1B2C3D4',
      detail: { task: { id: 'A1B2C3D4', title: '<task>', path: '/tmp/<work>', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }, events: [{ id: 'e1', taskId: 'A1B2C3D4', kind: 'text', text: '<script>bad()</script>', createdAt: 3 }], artifacts: [] },
      selectedArtifactId: null,
      error: '', preview: null,
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
  })

  it('shows stop only while active and continuation only after a turn ends', async () => {
    const { renderTaskControls } = await import('./workbench.js')
    expect(renderTaskControls('running')).toContain('data-action="cancel"')
    expect(renderTaskControls('running')).not.toContain('data-action="continue"')
    expect(renderTaskControls('completed')).toContain('data-action="continue"')
    expect(renderTaskControls('completed')).not.toContain('data-action="cancel"')
  })

  it('keeps the selected artifact version when a newer poll arrives', async () => {
    const { chooseArtifactId } = await import('./workbench.js')
    const artifacts = [
      { id: 'old', taskId: 'A1B2C3D4', name: 'report.md', mime: 'text/markdown', size: 1, sha256: 'a', createdAt: 1, approvedAt: null },
      { id: 'new', taskId: 'A1B2C3D4', name: 'report.md', mime: 'text/markdown', size: 2, sha256: 'b', createdAt: 2, approvedAt: null },
    ]
    expect(chooseArtifactId(artifacts, 'old')).toBe('old')
    expect(chooseArtifactId(artifacts, 'missing')).toBe('new')
  })

  it('keeps an opened preview and its controls when poll data is rendered', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const artifact = { id: 'a1', taskId: 'TASK', name: 'report.md', mime: 'text/markdown', size: 2, sha256: 'hash', createdAt: 2, approvedAt: null }
    const html = renderWorkbench({ tasks: [], providers: [], defaultProvider: 'codex', canWechat: false, selectedId: 'TASK', selectedArtifactId: 'a1', error: '', preview: { artifactId: 'a1', html: '<pre>safe preview</pre>' }, detail: { task: { id: 'TASK', title: 'Report', path: '/tmp', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }, events: [], artifacts: [artifact] } })
    expect(html).toContain('<pre>safe preview</pre>')
    expect(html).toContain('data-action="download-artifact"')
    expect(html).toContain('data-action="approve-artifact"')
  })

  it('shows the explicit WeChat continuation command only when available', async () => {
    const { renderWorkbench } = await import('./workbench.js')
    const base = { tasks: [], providers: [], defaultProvider: 'codex', selectedId: 'TASK1234', selectedArtifactId: null, error: '', preview: null, detail: { task: { id: 'TASK1234', title: 'Report', path: '/tmp', providerId: 'codex', status: 'completed', createdAt: 1, updatedAt: 2, error: null }, events: [], artifacts: [] } }
    expect(renderWorkbench({ ...base, canWechat: true })).toContain('任务 TASK1234')
    expect(renderWorkbench({ ...base, canWechat: false })).not.toContain('在微信继续')
  })
})

describe('workbench drafts', () => {
  it('retains provider choice and scopes followups to their task', async () => {
    const { createWorkbenchDraftStore } = await import('./workbench.js')
    const drafts = createWorkbenchDraftStore()
    drafts.set('new', { path: '/work', text: 'draft', title: '', providerId: 'claude', followup: '' })
    drafts.set('task:A', { path: '', text: '', title: '', providerId: '', followup: 'for A' })
    expect(drafts.get('new').providerId).toBe('claude')
    expect(drafts.get('task:B').followup).toBe('')
    expect(drafts.get('task:A').followup).toBe('for A')
  })
})

describe('workbench request ordering', () => {
  it('opens the most recent task after the initial list loads', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    const invokeWorkbenchApi = vi.fn(async (_method: string, path: string) => path === '/v1/workbench'
      ? { tasks: [{ id: 'RECENT' }], providers: [], defaultProvider: 'codex', canWechat: false }
      : { task: { id: 'RECENT' }, events: [], artifacts: [] })
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: vi.fn() })
    await controller.refresh()
    expect(controller.state.selectedId).toBe('RECENT')
    expect(controller.state.detail?.task.id).toBe('RECENT')
  })

  it('ignores a stale detail response after the user selects another task', async () => {
    const { createWorkbenchController } = await import('./workbench.js')
    let finishFirst!: (value: unknown) => void
    const first = new Promise(resolve => { finishFirst = resolve })
    const invokeWorkbenchApi = vi.fn((method: string, path: string) => {
      if (path.includes('id=FIRST')) return first
      return Promise.resolve({ task: { id: 'SECOND' }, events: [], artifacts: [] })
    })
    const renders: any[] = []
    const controller = createWorkbenchController({ invokeWorkbenchApi, render: (state: unknown) => renders.push(structuredClone(state)) })
    const pending = controller.selectTask('FIRST')
    await controller.selectTask('SECOND')
    finishFirst({ task: { id: 'FIRST' }, events: [], artifacts: [] })
    await pending
    expect(renders.at(-1).selectedId).toBe('SECOND')
    expect(renders.at(-1).detail.task.id).toBe('SECOND')
  })
})

describe('workbench lifecycle', () => {
  it('removes the previous activation handlers so one click dispatches once', async () => {
    vi.useFakeTimers()
    class FakeElement {
      dataset: Record<string, string> = {}
      innerHTML = ''
      listeners = new Map<string, Set<(event: any) => void>>()
      addEventListener(name: string, fn: (event: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set) }
      removeEventListener(name: string, fn: (event: any) => void) { this.listeners.get(name)?.delete(fn) }
      closest() { return null }
      querySelector() { return null }
    }
    const page = new FakeElement()
    const button = new FakeElement(); button.dataset.action = 'cancel'; (button as any).closest = () => button
    root.document = { getElementById: (id: string) => id === 'workbench-root' ? page : null, activeElement: null, createElement: () => new FakeElement() }
    root.window = {}
    vi.stubGlobal('Element', FakeElement)
    const task = { id: 'TASK', title: 'Task', path: '/tmp', providerId: 'codex', status: 'running', createdAt: 1, updatedAt: 2, error: null }
    const invokeWorkbenchApi = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/v1/workbench') return { tasks: [task], providers: [], defaultProvider: 'codex', canWechat: false }
      if (method === 'GET') return { task, events: [], artifacts: [] }
      return { task }
    })
    const { initWorkbenchPage, stopWorkbenchPolling } = await import('./workbench.js')
    initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })
    await vi.runAllTicks()
    initWorkbenchPage({ invokeWorkbenchApi, pollMs: 60_000 })
    await vi.runAllTicks()
    expect(page.listeners.get('click')?.size).toBe(1)
    page.listeners.get('click')?.forEach(fn => fn({ target: button }))
    await vi.runAllTicks()
    expect(invokeWorkbenchApi.mock.calls.filter(([method, path]) => method === 'POST' && path === '/v1/workbench/cancel')).toHaveLength(1)
    stopWorkbenchPolling()
  })
})

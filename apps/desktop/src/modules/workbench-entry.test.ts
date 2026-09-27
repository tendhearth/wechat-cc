import { afterEach, expect, it, vi } from 'vitest'

class Dialog {
  className = ''; innerHTML = ''; value = '0'; removed = false; open = false
  listeners: Record<string, (event: any) => void> = {}
  setAttribute() {}
  addEventListener(name: string, fn: (event: any) => void) { this.listeners[name] = fn }
  querySelector() { return this }
  showModal() { this.open = true }
  close() { this.open = false; this.listeners.close?.({}) }
  remove() { this.removed = true }
}
const fixture = () => ({
  projects: [{ id: 'one', name: '网站 <一>', path: '/work/a/site', providerId: 'codex' }, { id: 'two', name: '网站 <一>', path: '/work/b/site', providerId: 'codex' }],
  tasks: [{ id: 'old', path: '/work/a/site', providerId: 'codex', title: 'Older task', status: 'completed', createdAt: 1, updatedAt: 1, error: null }],
  projectProviders: { '/work/a/site': 'claude' }, providers: [{ id: 'codex', displayName: 'Codex' }, { id: 'claude', displayName: 'Claude' }], defaultProvider: 'codex', canWechat: false,
})
function installDialog() {
  const dialog = new Dialog()
  vi.stubGlobal('document', { createElement: () => dialog, body: { append() {} } })
  return dialog
}
afterEach(() => { vi.unstubAllGlobals() })

it('chooses a real registered project and inherits its latest executor without creating work', async () => {
  const dialog = installDialog(), response = fixture()
  const requests: string[] = []
  const { chooseWorkbenchProject } = await import('./workbench-entry.js')
  const choosing = chooseWorkbenchProject(async (method, path) => { requests.push(`${method} ${path}`); return response })
  await Promise.resolve()
  expect(dialog.open).toBe(true)
  expect(dialog.innerHTML).toContain('网站 &lt;一&gt;')
  expect(dialog.innerHTML).toContain('/work/a/site')
  expect(dialog.innerHTML).toContain('/work/b/site')
  dialog.listeners.submit!({ preventDefault() {} })
  expect(await choosing).toEqual({ path: '/work/a/site', providerId: 'claude' })
  expect(dialog.removed).toBe(true)
  expect(requests).toEqual(['GET /v1/workbench'])
})

it('cancels the picker without selecting a project', async () => {
  const dialog = installDialog()
  const { chooseWorkbenchProject } = await import('./workbench-entry.js')
  const choosing = chooseWorkbenchProject(async () => fixture())
  await Promise.resolve()
  dialog.close()
  expect(await choosing).toBeNull()
})

it('opens the existing add-project flow when no project exists', async () => {
  const dialog = installDialog()
  const { chooseWorkbenchProject } = await import('./workbench-entry.js')
  expect(await chooseWorkbenchProject(async () => ({ ...fixture(), projects: [], tasks: [], projectProviders: {} }))).toEqual({ path: '', providerId: 'codex' })
  expect(dialog.open).toBe(false)
})

it('propagates loading failures so the chat keeps its request', async () => {
  const dialog = installDialog()
  const { chooseWorkbenchProject } = await import('./workbench-entry.js')
  await expect(chooseWorkbenchProject(async () => { throw new Error('offline') })).rejects.toThrow('offline')
  expect(dialog.open).toBe(false)
})

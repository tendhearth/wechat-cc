import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { assembleMobilePage } from './assemble'
import { readMobileSource } from './sources'

const windows: Window[] = []
afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.happyDOM.abort())) })
function fixture() {
  const window = new Window({ url: 'https://fixture.test/m' }); windows.push(window)
  const document = window.document
  document.body.innerHTML = assembleMobilePage(readMobileSource).phone
  const detail = { ok: true, matter: { id: 'deadbeef', kind: 'task', title: '首页调整', status: 'open' }, runId: 'run1', task: { phase: 'working' }, permissions: [], questions: [], events: [] }
  const sent: string[] = []
  const api = async () => ({ status: 200, json: async () => detail })
  const env = { document, window, api, fetch: async (path: string) => { sent.push(path); return { json: async () => ({ ok: true }) } }, q: (p: string) => p, REMOTE: null,
    localStorage: window.localStorage, ccPlain: (s: string) => s, esc: (s: string) => s, preferTunnel: false, AbortController, setTimeout, clearTimeout, ccSelectMobilePane: () => {} }
  const fns = new Function(...Object.keys(env), readMobileSource('workbench.js') + '\nreturn {openMatter,mRenderStatus}')(...Object.values(env)) as { openMatter: (id: string) => Promise<void>; mRenderStatus: (d: unknown) => void }
  return { window, document, detail, sent, ...fns }
}

describe('status-only page keyboard actions', () => {
  it('keeps focus on Stop when arming confirmation and refreshing status, without sending a request', async () => {
    const h = fixture()
    await h.openMatter('deadbeef')
    const button = h.document.querySelector('button[data-stop]') as unknown as HTMLButtonElement
    button.focus(); button.click()
    expect(h.document.activeElement?.textContent).toBe('再点一次，确认停止')
    expect(h.sent).toEqual([])
    // A status refresh can change nearby text while the confirmation remains armed.
    h.mRenderStatus({ ...h.detail, events: [{ kind: 'tool_call', activity: { status: 'running', label: '核对结果' } }] })
    expect(h.document.activeElement?.textContent).toBe('再点一次，确认停止')
  })

  it('does not move focus from another action during a background status refresh', async () => {
    const h = fixture()
    await h.openMatter('deadbeef')
    const back = h.document.getElementById('m-back') as unknown as HTMLElement
    back.focus()
    h.mRenderStatus({ ...h.detail, events: [{ kind: 'tool_call', activity: { status: 'running', label: '核对结果' } }] })
    expect(h.document.activeElement).toBe(back)
  })
})

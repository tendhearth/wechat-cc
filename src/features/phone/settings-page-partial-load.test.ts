import { afterEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { pageHtml } from './settings-panel-html'

// 设置读到一半抛错(这里是 models 形状不对):要看得见失败、能重试,而且「全部忘掉」这类安全动作还够得着。
let window: Window
afterEach(() => { window?.close(); vi.unstubAllGlobals() })
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }

it('a load that throws partway keeps the paired-device safety actions reachable and offers retry, without exposing unloaded fields', async () => {
  const html = pageHtml('tok'), start = html.indexOf('<script>'), end = html.lastIndexOf('</script>')
  const state = (models: unknown) => ({ ok: true, name: 'Nate', persona: '', prefs: {}, config: {}, models,
    remote: { available: true, enabled: true, devices: [{ id: 'phone1', label: '手机', current: true, created_at: '2026-10-01', last_seen_at: '2026-10-28' }] } })
  let models: unknown = {}  // providers 缺了 ⇒ renderModels 抛错
  const posts: unknown[] = []
  window = new Window({ url: 'http://127.0.0.1/set' })
  window.document.write(html.slice(0, start) + '</body></html>')
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('localStorage', window.localStorage)
  vi.stubGlobal('confirm', () => true)
  vi.stubGlobal('fetch', async (url: string, opts?: { body?: string }) => {
    if (opts?.body) { posts.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true })) }
    if (String(url).startsWith('/set/api/state')) return new Response(JSON.stringify(state(models)))
    return new Response(JSON.stringify({ ok: false }), { status: 404 })
  })
  new Function(html.slice(start + '<script>'.length, end))()
  await flush()

  const $ = (id: string) => window.document.getElementById(id) as unknown as HTMLElement
  const shown = (id: string) => { for (let el: any = $(id); el; el = el.parentElement) if (el.hasAttribute?.('hidden')) return false; return true }
  expect(shown('settings-status')).toBe(true)
  expect($('settings-status').textContent).toContain('没读到')
  expect(shown('settings-retry')).toBe(true)
  expect(shown('forget-devices')).toBe(true)
  expect(($('settings-fields') as any).disabled).toBe(false)
  expect(shown('f-name')).toBe(false)          // 没读全的字段不给改,免得写回空值
  expect(shown('f-default-provider')).toBe(false)
  $('forget-devices').click(); await flush()
  expect(posts).toEqual([{ op: 'forget_devices' }])

  models = { providers: [{ id: 'claude', name: 'Claude', registered: true }], default_provider: 'claude', openai: { base_url: '', model: '', has_key: false, aliases: {} } }
  $('settings-retry').click(); await flush()
  expect(shown('f-name')).toBe(true)
  expect(($('f-name') as any).value).toBe('Nate')
  expect(shown('settings-status')).toBe(false)
  expect(shown('settings-retry')).toBe(false)
})

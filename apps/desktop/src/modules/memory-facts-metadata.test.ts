// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { loadMemoryPane } from './memory.js'

beforeEach(() => {
  document.body.innerHTML = '<section id="memory-facts"><p id="memory-facts-source">old file.md</p><div id="memory-facts-records"></div><button id="memory-facts-edit"></button></section>'
})

it.each(['memory.md', 'notes/read-only.md'])('hides unavailable tidying metadata for %s without substituting file mtime', async path => {
  const call = vi.fn(async (_method: string, url: string) => {
    if (url === '/v1/memory/files') return [{ userId: 'u', fileCount: 1, files: [{ path, mtime: new Date().toISOString(), size: 10 }] }]
    if (url === '/v1/memory/view') return { ok: true, chatId: 'u', path, baseHash: 'a'.repeat(64), generatedAt: null, stale: false, lines: [{ text: '在窗边读书', origin: 'owner', assertionId: '1' }] }
    if (url.startsWith('/v1/memory/file?')) return { ok: true, content: '在窗边读书' }
    throw Error(`Unexpected call: ${url}`)
  })
  await loadMemoryPane({ invoke: vi.fn(), invokeApi: vi.fn(), invokeWorkbenchApi: call, formatInvokeError: String, doctorPoller: { current: null } })
  const metadata = document.getElementById('memory-facts-source')!
  expect(metadata.textContent).toBe('')
  expect(metadata.hidden).toBe(true)
  expect(document.getElementById('memory-facts-records')!.textContent).toContain('在窗边读书')
})

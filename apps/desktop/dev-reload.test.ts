import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELOAD_SCRIPT_TAG, injectReloadScript, makeLiveReload } from './dev-reload'

describe('injectReloadScript', () => {
  it('注在最后一个 </body> 之前(字符串字面量里的 </body> 不算)', () => {
    const html = `<html><body><script>const s = "</body>";</script><p>x</p></body></html>`
    const out = injectReloadScript(html)
    expect(out).toContain(RELOAD_SCRIPT_TAG)
    expect(out.indexOf(RELOAD_SCRIPT_TAG)).toBeLessThan(out.lastIndexOf('</body>'))
  })

  it('没有 </body> 时追加到末尾', () => {
    const out = injectReloadScript('<p>no body tag</p>')
    expect(out.trimEnd().endsWith(RELOAD_SCRIPT_TAG)).toBe(true)
  })

  it('外链而非 inline(CSP script-src self)', () => {
    expect(RELOAD_SCRIPT_TAG).toBe('<script src="/__dev_reload.js"></script>')
    expect(injectReloadScript('<body></body>')).not.toContain('<script>(function')
  })
})

describe('makeLiveReload', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-reload-test-'))

  it('/__dev_reload.js 返回客户端脚本(js content-type)', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload.js')!
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain("EventSource('/__dev_reload')")
    lr.close()
  })

  it('/__dev_reload 返回 SSE 流', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload')!
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    lr.close()
  })

  it('其他路径返回 null(交给宿主 server)', () => {
    const lr = makeLiveReload({ root })
    expect(lr.handle('/index.html')).toBeNull()
    lr.close()
  })

  it('notify 去抖后向已连接客户端广播 reload 事件', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload')!
    const reader = res.body!.getReader()
    await reader.read()                     // ': connected'
    lr.notify('main.js'); lr.notify('main.js'); lr.notify('main.js')
    const chunk = await reader.read()
    const text = new TextDecoder().decode(chunk.value!)
    expect(text).toContain('event: reload')
    lr.close()
  })

  it('watch() 监视 root 下的变更并触发广播', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload')!
    const reader = res.body!.getReader()
    await reader.read()
    lr.watch()
    // Touch repeatedly instead of once. `watch()` registers an fs watcher
    // asynchronously, so a single write issued immediately after it can land
    // before the watcher is listening — the event is never delivered, the
    // read below never resolves, and the test dies on vitest's 5s timeout.
    // That is what made this the flakiest test in the suite (three failures
    // across one day's CI, always on the slower runners). Re-touching until
    // the event arrives removes the race without betting on a fixed delay.
    const chunkPromise = reader.read()
    const ticker = setInterval(() => {
      writeFileSync(join(root, 'touched.js'), `// ${Date.now()}`)
    }, 25)
    try {
      const chunk = await chunkPromise
      expect(new TextDecoder().decode(chunk.value!)).toContain('event: reload')
    } finally {
      clearInterval(ticker)
      lr.close()
    }
  })
})

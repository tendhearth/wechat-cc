import { describe, expect, it, vi } from 'vitest'
import { showPageError } from './page-status.js'

function host() {
  let click: (() => Promise<void>) | undefined
  const button = {
    disabled: false, textContent: '重新读取',
    addEventListener: (_: string, fn: () => Promise<void>) => { click = fn },
  }
  const element = { innerHTML: '', querySelector: () => button }
  return { element, button, click: () => click!() }
}

describe('page recovery', () => {
  it('retries the supplied operation once, without losing its arguments', async () => {
    const view = host()
    let finish!: () => void
    const read = vi.fn((_query: string) => new Promise<void>(resolve => { finish = resolve }))
    showPageError(view.element as unknown as HTMLElement, {
      title: '暂时没能搜索', description: '可以再试一次。', retry: () => read('之前的搜索'),
    })
    const pending = view.click()
    await view.click()
    expect(read.mock.calls).toEqual([['之前的搜索']])
    expect(view.button.disabled).toBe(true)
    finish()
    await pending
    expect(view.button.disabled).toBe(false)
  })

  it('keeps retry available after another failure and does not expose internal errors', async () => {
    const view = host()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const retry = vi.fn().mockRejectedValueOnce(new Error('/private/db: SQL failure')).mockResolvedValueOnce(undefined)
      showPageError(view.element as unknown as HTMLElement, {
        title: '暂时没能读取', description: '请稍后重试。', retry,
      })
      await view.click()
      expect(view.button.disabled).toBe(false)
      expect(view.element.innerHTML).not.toContain('/private/db')
      await view.click()
      expect(retry).toHaveBeenCalledTimes(2)
    } finally { log.mockRestore() }
  })

  it('escapes displayed text', () => {
    const view = host()
    showPageError(view.element as unknown as HTMLElement, {
      title: '<script>', description: 'A & B', retry: async () => {},
    })
    expect(view.element.innerHTML).toContain('&lt;script&gt;')
    expect(view.element.innerHTML).toContain('A &amp; B')
    expect(view.element.innerHTML).not.toContain('<script>')
  })
})

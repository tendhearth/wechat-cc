import { describe, expect, it, vi } from 'vitest'
import { pageStatusHtml, showPageStatus } from './page-status.js'

describe('page status recovery', () => {
  it('escapes status content and does not fabricate an action', () => {
    const html = pageStatusHtml({ title: '<img onerror=bad>', detail: 'A & B' })
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<button')
    expect(html).toContain('role="status"')
  })
  it('runs the supplied recovery once while pending, and permits retry after failure', async () => {
    let click: () => Promise<void> = async () => {}
    const button = { disabled: false, addEventListener: (_: string, fn: typeof click) => { click = fn } }
    const host = { innerHTML: '', querySelector: () => button }
    let reject!: (e: Error) => void
    const retry = vi.fn(() => new Promise<void>((_, no) => { reject = no }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    showPageStatus(host as never, { title: '暂时无法读取', actionLabel: '重新加载' }, retry)
    const pending = click()
    await click()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    reject(new Error('offline'))
    await pending
    expect(button.disabled).toBe(false)
    vi.restoreAllMocks()
  })
})

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'

let window: Window
let document: Document
beforeEach(() => {
  window = new Window()
  window.document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8'))
  document = window.document as unknown as Document
})
afterEach(() => window.close())
const label = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim()

describe('secondary entry hierarchy', () => {
  it('keeps fold titles short and the read-only, recovery and editing scope inside the disclosure', () => {
    for (const [id, title, qualifier] of [
      ['memory-retractions', '收回的话', '不对、过时或不用记'],
      ['memory-projects', '本机项目记忆', '只读'],
      ['memory-archive', '原始记忆', '查看和编辑'],
    ]) {
      const toggle = document.getElementById(`${id}-toggle`)!
      expect(label(toggle.querySelector('span'))).toBe(title)
      expect(toggle.getAttribute('aria-controls')).toBe(`${id}-body`)
      const body = document.getElementById(`${id}-body`)!
      expect(body.hidden).toBe(true)
      expect(body.textContent).toContain(qualifier)
    }
  })

  it('distinguishes re-reading records from both AI generation actions with their source and cost context', () => {
    const refresh = document.getElementById('memory-refresh')!
    const profile = document.getElementById('memory-profile-generate-btn')!
    const map = document.getElementById('memory-synthesize-btn')!
    expect(label(refresh)).toBe('读取记录')
    expect(label(profile)).toBe('更新画像')
    expect(label(map)).toBe('生成项目地图')
    const description = (el: HTMLElement) => el.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!.textContent).join(' ')
    expect(description(refresh)).toContain('不生成新内容')
    expect(description(profile)).toContain('长期记忆')
    expect(description(profile)).toContain('费用')
    expect(description(map)).toContain('不改每晚整理的长期记忆')
    expect(description(map)).toContain('费用')
  })

  it('puts optional self-check behind disclosure and leaves recovery and phone pairing outside it', () => {
    const diagnostics = document.getElementById('brain-selfcheck')!.closest('details')!
    expect(diagnostics).not.toBeNull()
    expect(diagnostics.open).toBe(false)
    expect(label(diagnostics.querySelector('summary'))).toBe('连接检查')
    for (const id of ['dash-restart', 'dash-test-conn', 'dash-rebind', 'open-phone-settings']) {
      const action = document.getElementById(id)!
      expect(action.closest('details')).toBeNull()
      expect(action.closest('#settings-drawer')).not.toBeNull()
    }
    expect(document.querySelector('#dash-connection-options #dash-stop')).not.toBeNull()
  })
})

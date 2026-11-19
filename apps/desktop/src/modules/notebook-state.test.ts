import { describe, expect, it, vi } from 'vitest'
import type { NotebookEntryT } from '@wechat-cc/protocol'
import { callNotebook } from '../daemon-client.js'
import {
  canWriteNotebookFont, createNotebookQueue, NOTEBOOK_QUEUE_KEY, notebookDay, notebookDateLabel, notebookPenStyle, notebookPeriod,
} from './notebook-state.js'

describe('桌面本子', () => {
  it('本机日期可作离线初值，日期标签按传入的今天显示', () => {
    const today = notebookDay(new Date(2026, 10, 4, 23, 30))
    expect(today).toBe('2026-11-04')
    expect(notebookDateLabel(today, today)).toBe('今天')
    expect(notebookDateLabel('2026-10-28', today)).toBe('10 月 28 日')
  })

  it.each([
    [0, '夜里'], [4, '夜里'], [5, '清晨'], [8, '上午'], [12, '下午'], [17, '傍晚'], [20, '夜里'],
  ])('本地 %s 点落款为 %s', (hour, label) => {
    expect(notebookPeriod(new Date(2026, 10, 4, hour).getTime())).toBe(label)
  })

  it.each([
    ['kai', 'blueBlack', "'Kaiti SC', 'STKaiti', 'KaiTi', ", 'normal', 'blue-black'],
    ['fangsong', 'darkGreen', "'STFangsong', 'FangSong', ", 'normal', 'dark-green'],
    ['xingkai', 'ochre', "'Xingkai SC', 'STXingkai', ", 'normal', 'ochre'],
    ['songItalic', 'greyPurple', '', 'italic', 'grey-purple'],
  ] as const)('把 %s 和 %s 映射到本机字和墨色 token', (font, ink, stack, fontStyle, token) => {
    expect(notebookPenStyle({ font, ink }, new Set([font]))).toEqual({
      fontFamily: stack + 'var(--th-font-serif)', fontStyle, color: `var(--th-notebook-${token})`,
    })
  })

  it('用同一段中文比较目标字体与兜底，宋体斜无需测量', () => {
    const measure = vi.fn((_sample: string, families: string) =>
      families.includes('Kaiti SC') && families.endsWith('monospace') ? 26 : 24)
    expect(canWriteNotebookFont('kai', measure)).toBe(true)
    expect(canWriteNotebookFont('fangsong', measure)).toBe(false)
    expect(canWriteNotebookFont('xingkai', measure)).toBe(false)
    expect(new Set(measure.mock.calls.map(([sample]) => sample)).size).toBe(1)
    expect(measure.mock.calls[0]?.[0]).toMatch(/本子/)
    measure.mockClear()
    expect(canWriteNotebookFont('songItalic', measure)).toBe(true)
    expect(measure).not.toHaveBeenCalled()
  })

  it('已存字体不可用时退到宋体斜，保留墨色', () => {
    expect(notebookPenStyle({ font: 'kai', ink: 'ochre' }, new Set(['songItalic']))).toEqual({
      fontFamily: 'var(--th-font-serif)', fontStyle: 'italic', color: 'var(--th-notebook-ochre)',
    })
  })

  it('从生成的调用表传日期和可用字体', async () => {
    const transport = vi.fn().mockResolvedValue({})
    await callNotebook(transport, { day: '2026-11-04', fonts: 'kai,songItalic' })
    await callNotebook(transport, { action: 'strike', body: { id: 'sample', struck: true } })
    expect(transport.mock.calls).toEqual([
      ['GET', '/v1/notebook?day=2026-11-04&fonts=kai%2CsongItalic'],
      ['POST', '/v1/notebook/strike', { id: 'sample', struck: true }],
    ])
  })

  it('失败留队，重开后用同一个 clientId 重发，成功才出队', async () => {
    const items = new Map<string, string>()
    const storage: Storage = {
      get length() { return items.size },
      key: index => [...items.keys()][index] ?? null,
      clear: () => items.clear(),
      getItem: key => items.get(key) ?? null,
      setItem: (key, value) => { items.set(key, value) },
      removeItem: key => { items.delete(key) },
    }
    const pending = { clientId: 'local-1', body: '一行字', day: '2026-11-04', createdAt: 1 }
    const receipt: NotebookEntryT = {
      id: '682261b1-e8b7-4a6b-9edd-11a51bb6eeae', clientId: pending.clientId, body: pending.body,
      createdAt: 2, day: '2026-11-05', refId: null, struckAt: null, origin: 'desktop', author: 'owner',
    }
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(receipt)
    const acknowledge = vi.fn()
    const queue = createNotebookQueue(storage, send, acknowledge)
    queue.add(pending)
    await queue.flush()
    expect(queue.entries()).toEqual([pending])
    expect(acknowledge).not.toHaveBeenCalled()

    const reopened = createNotebookQueue(storage, send, acknowledge)
    await Promise.all([reopened.flush(), reopened.flush()])
    expect(send.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ body: pending.body, clientId: pending.clientId }]))
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(pending, receipt)
    expect(reopened.entries()).toEqual([])
    expect(storage.getItem(NOTEBOOK_QUEUE_KEY)).toBe('[]')
  })
})

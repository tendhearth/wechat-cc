import { describe, expect, it } from 'vitest'
import { STATUS_ICON, statusGlyphHtml, taskStatusKey, workbenchTaskStatusKey } from './matter-status.js'
import { STATUS_TABLE } from '../generated/status-table.js'

describe('matter-status: one status mapping for 全部 and the detail (U4, 2026-11-05)', () => {
  it.each([
    [{ status: 'running' }, 'working'],
    [{ status: 'queued' }, 'working'],
    [{ status: 'running', phase: 'replied' }, 'replied'],
    [{ status: 'completed' }, 'done'],
    [{ status: 'failed' }, 'failed'],
    [{ status: 'running', phase: 'failed' }, 'failed'],
    [{ status: 'cancelled' }, 'stopped'],
    [{ status: 'interrupted' }, 'stopped'],
    // 老 daemon 不给 phase:会话还留着、前台空着、后台也没活 ⇒ 这一轮做完了,不算在做;后台还有活 ⇒ 在做
    [{ status: 'running', runtime: { retained: true, foreground: 'idle', backgroundCount: 0 } }, 'replied'],
    [{ status: 'running', runtime: { retained: true, foreground: 'idle', backgroundCount: 2 } }, 'working'],
  ])('%j ⇒ %s', (t, key) => { expect(taskStatusKey(t as never)).toBe(key) })

  it('pending requests make a task 等你; imported-only is 停下了; archived never waits', () => {
    expect(workbenchTaskStatusKey({ status: 'running', pendingPermissionCount: 1 })).toBe('waiting')
    expect(workbenchTaskStatusKey({ status: 'running', pendingQuestionCount: 2 })).toBe('waiting')
    expect(workbenchTaskStatusKey({ status: 'running', pendingPermissionCount: 0, pendingQuestionCount: 0 })).toBe('working')
    expect(workbenchTaskStatusKey({ status: 'running', importedOnly: true })).toBe('stopped')
    expect(workbenchTaskStatusKey({ status: 'completed', archivedAt: 5, pendingPermissionCount: 3 })).toBe('done')
    expect(workbenchTaskStatusKey({ status: 'running', phase: 'replied' })).toBe('replied')
    expect(workbenchTaskStatusKey({ status: 'failed' })).toBe('failed')
  })

  it('every status-table icon has a desktop glyph; tone comes from the table', () => {
    for (const spec of Object.values(STATUS_TABLE)) if (spec.icon) expect(STATUS_ICON[spec.icon], spec.icon).toBeTruthy()
    expect(statusGlyphHtml('waiting')).toMatch(/^<span class="now-row-status" data-tone="accent" aria-hidden="true"><svg /)
    expect(statusGlyphHtml('done')).toContain('data-tone="inkSoft"')
    // 在做不画,留空位(同 App)
    expect(statusGlyphHtml('working')).toBe('<span class="now-row-status" data-tone="inkSoft" aria-hidden="true"></span>')
  })
})

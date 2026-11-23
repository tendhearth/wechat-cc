import { expect, it } from 'vitest'
import { PlaceWaiting } from './places'

const legacy = { itemKey: 'matter:sample', kind: 'permission', requestId: 'pending', summary: 'sample', count: 1 }

it('keeps legacy waiting records and accepts bounded operation metadata', () => {
  expect(PlaceWaiting.parse(legacy)).toEqual(legacy)
  const detailed = {
    ...legacy, tool: 'Bash', cwd: '/sample', truncated: false, showSnapshotNotice: true, hasScriptPreview: false,
    display: { body: { kind: 'command', command: 'sample' } },
  }
  const waiting = PlaceWaiting.parse(detailed)
  expect(JSON.stringify(waiting.display) === JSON.stringify(detailed.display)).toBe(true)
  expect(waiting.tool === detailed.tool && waiting.cwd === detailed.cwd && waiting.truncated === false && waiting.showSnapshotNotice === true).toBe(true)
  expect(waiting.hasScriptPreview).toBe(false)
})

it('reads the waiting record when a preview exceeds the existing wire byte limit or cwd is invalid', () => {
  const display = { body: { kind: 'write', path: '示'.repeat(8192), content: '例'.repeat(8192) } }
  const waiting = PlaceWaiting.parse({ ...legacy, display, cwd: 'relative' })
  expect(waiting.display).toBeUndefined()
  expect(waiting.cwd).toBeUndefined()
  expect(waiting.requestId).toBe(legacy.requestId)
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('native drag safety', () => {
  it('locks a Wry runtime containing the macOS file-reference pasteboard fix', () => {
    const lock = readFileSync('apps/desktop/src-tauri/Cargo.lock', 'utf8')
    const record = lock.split('[[package]]').find(block => /^name = "wry"$/m.test(block))
    const version = record?.match(/^version = "([^"]+)"$/m)?.[1]
    expect(version).toBeDefined()
    const current = version!.split('.').map(Number), minimum = [0, 57, 1]
    const firstDifference = current.findIndex((part, index) => part !== minimum[index])
    expect(firstDifference === -1 || current[firstDifference]! > minimum[firstDifference]!,
      `Wry ${version} must include upstream macOS drag fix #1844 (0.57.1+)`).toBe(true)
  })

  it('keeps file-drop handling disabled on the companion that only supports window movement', () => {
    const source = readFileSync('apps/desktop/src-tauri/src/lib.rs', 'utf8')
    const open = source.slice(source.indexOf('fn open_companion_window('), source.indexOf('fn close_companion_window('))
    expect(open).toContain('.disable_drag_drop_handler()')
  })
})

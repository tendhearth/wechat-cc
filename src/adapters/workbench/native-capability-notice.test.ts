import { expect, it } from 'vitest'
import { claudeNativeCapabilityNotice, codexNativeCapabilityNotice } from './native-capability-notice'

it('explains omitted Claude capabilities without copying raw config or replacing assistant text', () => {
  const notice = claudeNativeCapabilityNotice({ servers: { catalog: { command: 'secret-command' } }, omitted: ['disabled', 'wechat', 'bad\nname'],
    omissionReasons: { disabled: '本机已停用', wechat: '陪伴工具不进入工作任务' }, disabledPlugins: { 'plugin@local': false } })!
  expect(notice).toContain('disabled（本机已停用）')
  expect(notice).toContain('wechat（陪伴工具不进入工作任务）')
  expect(notice).toContain('原生插件')
  expect(notice).not.toContain('secret-command')
  expect(notice).not.toContain('bad\nname')
  expect(notice.length).toBeLessThanOrEqual(4000)
})

it('does not add noise when no Claude capability was omitted and bounds large lists', () => {
  expect(claudeNativeCapabilityNotice({ servers: {}, omitted: [] })).toBeNull()
  const notice = claudeNativeCapabilityNotice({ servers: {}, omitted: Array.from({ length: 500 }, (_, i) => `server_${i}`) })!
  expect(notice.length).toBeLessThanOrEqual(4000)
  expect(notice).toContain('其余 476 项')
})

it('names Codex tools excluded from enabled native config without exposing transport details', () => {
  expect(codexNativeCapabilityNotice([{ name: 'ordinary', enabled: true }, { name: 'off', enabled: false }], new Set(['ordinary']))).toBeNull()
  const notice = codexNativeCapabilityNotice([{ name: 'ordinary', enabled: true }, { name: 'private', enabled: true, url: 'secret-url' }], new Set(['ordinary']))!
  expect(notice).toContain('private')
  expect(notice).not.toContain('secret-url')
})

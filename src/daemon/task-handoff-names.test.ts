import { it, expect } from 'vitest'
import { createProviderRegistry } from '../app/provider-registry'
import { taskHandoffNames } from './task-handoff-names'
import { isTaskHandoffRequest } from '../features/workbench/task-reference'

it('handoff names follow real registrations, custom ACP display names and current gateway aliases', () => {
  const registry = createProviderRegistry()
  const provider = { spawn: async () => { throw Error('read-only fixture') } }
  const config = { openaiAliases: { GLM4: 'glm-4-plus', ds: 'DeepSeek' }, openaiModel: 'Kimi-Code' }
  const requests = ['转给 Claude', '让 agy 接手', '换成 GLM4 继续', '交给我的 ACP', '交给 Cursor']
  expect(requests.map(t => isTaskHandoffRequest(t, taskHandoffNames(registry, config)))).toEqual([false, false, false, false, false])
  for (const id of ['claude', 'agy', 'openai']) registry.register(id, provider, { canResume: () => false })
  registry.register('custom-acp', provider, { canResume: () => false, displayName: '我的 ACP' })
  expect(requests.map(t => isTaskHandoffRequest(t, taskHandoffNames(registry, config)))).toEqual([true, true, true, true, false])
  for (const text of ['交给 Gemini', '转给 ds', '给 glm-4-plus 做吧', 'switch to kimi-code']) expect(isTaskHandoffRequest(text, taskHandoffNames(registry, config))).toBe(true)
  expect(isTaskHandoffRequest('换成 GLM4 继续', taskHandoffNames(registry, { openaiAliases: {} }))).toBe(false)
})

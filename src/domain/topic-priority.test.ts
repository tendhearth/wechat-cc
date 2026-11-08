import { expect, it } from 'vitest'
import { pickEntries, type MatchTopic } from './topic-match'
import { renderProjectMemory } from '../features/terminal/project-memory'
import { resolveTopicRecall } from '../daemon/threads/recall'

const topic: MatchTopic = { id: 'cc', title: 'wechat-cc', aliases: [], tags: [], summary: '', lastActive: '', entries: [
  { id: 'general', kind: 'progress', line: '演示已经录完', body: '', due: null, updatedTs: '2026-11-08' },
  { id: 'conclusion', kind: 'conclusion', line: '录屏路径确认可用', body: '', due: null, updatedTs: '2026-11-07' },
  { id: 'decision', kind: 'decision', line: '选择统一入口', body: '', due: null, updatedTs: '2026-11-06' },
  { id: 'unfinished', kind: 'progress', line: '尚未补完手机验收', body: '', due: null, updatedTs: '2026-11-05' },
  { id: 'promise', kind: 'commitment', line: '答应周五交付', body: '', due: null, updatedTs: '2026-11-04' },
  { id: 'fact', kind: 'fact', line: '项目地址在本机', body: '', due: null, updatedTs: '2026-11-09' },
] }
it('neutral recall and project injection order obligations before completed progress', () => {
  expect(pickEntries('wechat-cc', topic).map(e => e.id)).toEqual(['promise', 'unfinished', 'decision', 'conclusion', 'general', 'fact'])
  const out = renderProjectMemory(topic)
  const lines = ['答应周五交付', '尚未补完手机验收', '选择统一入口', '录屏路径确认可用', '演示已经录完', '项目地址在本机']
  for (let i = 1; i < lines.length; i++) expect(out.indexOf(lines[i - 1]!)).toBeLessThan(out.indexOf(lines[i]!))
})
it('specific query and model selection still beat generic obligations', () => {
  expect(pickEntries('项目地址在本机', topic, 1)[0]?.id).toBe('fact')
  expect(pickEntries('项目地址在本机', topic, 1, 'general')[0]?.id).toBe('general')
})
it('completed pending items stay general progress; mixed completed and remaining work stays unfinished', () => {
  const t = { ...topic, entries: [
    { ...topic.entries[0]!, id: 'done', line: '已完成全部待办并演示' },
    topic.entries[2]!,
    { ...topic.entries[0]!, id: 'mixed', line: '已完成桌面;仍待补手机验收' },
  ] }
  expect(pickEntries('wechat-cc', t).map(e => e.id)).toEqual(['mixed', 'decision', 'done'])
})
it('routine receipts cannot enter recall or project injection even before cleanup', async () => {
  const noisy = { ...topic, entries: [
    { ...topic.entries[0]!, id: 'noise', line: 'Codex升至0.167.0自检过' },
    topic.entries[0]!,
  ] }
  const r = await resolveTopicRecall('wechat-cc', [noisy])
  expect(r?.entryIds).toEqual(['general'])
  expect(r?.block).not.toContain('0.167.0')
  expect(renderProjectMemory(noisy)).not.toContain('0.167.0')
})

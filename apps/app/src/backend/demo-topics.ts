import type { TopicsListT } from './types'
export function demoTopics(p: { view?: 'recent' | 'all'; cursor?: string }): TopicsListT {
  const titles = ['服务器', '旅行', '菜谱', '书架', '家里', '花园', '旧计划']
  const topics: TopicsListT['topics'] = titles.map((title, i) => ({ id: i === 0 ? 'demo-backup' : i === 1 ? 'demo-trip' : `demo-topic-${i}`, title, description: i === 0 ? '家里的服务与备份' : '', summary: i === 0 ? '上次：备份留在本地' : '', bubbleState: i === 0 ? 'open' : 'closed', lastRecalledAt: '2026-11-05T12:00:00Z', lastOpenedByOwnerAt: null, activityRevision: 1, matterSummary: { waiting: i === 0 ? 1 : 0, running: 0, total: i === 0 ? 3 : 0 } }))
  return { topics: p.view === 'all' ? topics : topics.slice(0, 6), nextCursor: null, revision: 'demo-topics' }
}

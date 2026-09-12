import { initWorkbenchPage } from '../../src/modules/workbench.js'

const now = Date.now()
const task = { id: '7H3K9P2Q', title: '整理访谈主题和引用', path: '/Users/demo/Documents/interviews', providerId: 'codex', status: 'completed', createdAt: now - 240000, updatedAt: now - 18000, error: null }
const detail = { task, events: [
  { id: 'e1', taskId: task.id, kind: 'user', text: '读取文件夹里的访谈记录，整理核心主题，并附一份引用表。', createdAt: now - 230000 },
  { id: 'e2', taskId: task.id, kind: 'tool_call', text: '查看了 8 份访谈记录', createdAt: now - 190000 },
  { id: 'e3', taskId: task.id, kind: 'text', text: '已经完成主题归纳，并把逐条引用整理成 CSV。', createdAt: now - 20000 },
], artifacts: [
  { id: 'a2', taskId: task.id, name: '访谈主题摘要.md', mime: 'text/markdown', size: 12640, sha256: 'f2d-example', createdAt: now - 18000, approvedAt: null },
  { id: 'a1', taskId: task.id, name: '引用索引.csv', mime: 'text/csv', size: 8402, sha256: 'b19-example', createdAt: now - 19000, approvedAt: now - 10000 },
] }
initWorkbenchPage({
  pollMs: 60000,
  invoke: async () => null,
  invokeWorkbenchApi: async (method, path) => {
    if (method === 'GET' && path === '/v1/workbench') return { tasks: [task], providers: [{ id: 'claude', displayName: 'Claude' }, { id: 'codex', displayName: 'Codex' }], defaultProvider: 'codex', canWechat: true }
    if (method === 'GET' && path.startsWith('/v1/workbench/task')) return detail
    if (method === 'GET' && path.startsWith('/v1/workbench/artifact')) return { name: '访谈主题摘要.md', mime: 'text/markdown', contentBase64: btoa('# 访谈主题摘要\n\n这是标注样例内容，不是真实模型输出。'), size: 36, sha256: 'f2d-example' }
    return { task }
  },
})

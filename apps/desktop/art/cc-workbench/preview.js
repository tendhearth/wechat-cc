import { initWorkbenchPage } from '../../src/modules/workbench.js'

export function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function makeFixtureApi(initialMode = 'completed', fixedNow = Date.now()) {
  const taskId = '7a3c9f2e'
  const summaryId = '7e38505a-2632-4d61-82cd-49880950cfed'
  const indexId = 'bf639152-ab76-4f45-8714-32bb07687939'
  const summarySha = 'f2d44fe977a9d108e0af544e46965b8b3eedbb3c833b973bddad970abe16d721'
  const indexSha = 'b190b3b6d38d529b32ec0ffea6f175651ae7cb6bbdc2f409ac38e0f8f54d861c'
  let mode = initialMode
  let task = makeTask(mode === 'running' ? 'running' : 'completed')
  let events = completedEvents()
  let artifacts = completedArtifacts()

  function makeTask(status, overrides = {}) {
    return { id: taskId, title: '整理访谈主题和引用', path: '/Users/demo/Documents/interviews', providerId: 'codex', status, createdAt: fixedNow - 240000, updatedAt: fixedNow - 18000, error: null, ...overrides }
  }
  function completedEvents() {
    return [
      { id: '8554593f-586d-4b32-a9fa-2ca22e6e5983', taskId, kind: 'user', text: '读取文件夹里的访谈记录，整理核心主题，并附一份引用表。', createdAt: fixedNow - 230000 },
      { id: 'b5c35aa8-1a08-40c5-b95c-bb495863a496', taskId, kind: 'tool_call', text: '查看了 8 份访谈记录', createdAt: fixedNow - 190000 },
      { id: '638c75fd-c94a-4a74-a722-51dbf1a60940', taskId, kind: 'text', text: '已经完成主题归纳，并把逐条引用整理成 CSV。', createdAt: fixedNow - 20000 },
    ]
  }
  function completedArtifacts() {
    return [
      { id: summaryId, taskId, name: '访谈主题摘要.md', mime: 'text/markdown', size: 12640, sha256: summarySha, createdAt: fixedNow - 18000, approvedAt: null },
      { id: indexId, taskId, name: '引用索引.csv', mime: 'text/csv', size: 8402, sha256: indexSha, createdAt: fixedNow - 19000, approvedAt: fixedNow - 10000 },
    ]
  }
  function setState(nextMode) {
    mode = nextMode
    if (mode === 'empty') return
    if (mode === 'running') {
      task = makeTask('running', { updatedAt: fixedNow })
      events = completedEvents().slice(0, 2)
      artifacts = []
      return
    }
    task = makeTask('completed')
    events = completedEvents()
    artifacts = completedArtifacts()
  }
  async function api(method, path, body = {}) {
    const url = new URL(path, 'http://fixture.local')
    if (method === 'GET' && url.pathname === '/v1/workbench') return { tasks: mode === 'empty' ? [] : [task], providers: [{ id: 'claude', displayName: 'Claude' }, { id: 'codex', displayName: 'Codex' }], defaultProvider: 'codex', canWechat: true }
    if (method === 'GET' && url.pathname === '/v1/workbench/task') return { task, events, artifacts }
    if (method === 'GET' && url.pathname === '/v1/workbench/artifact') {
      const artifact = artifacts.find(item => item.id === url.searchParams.get('artifactId')) ?? artifacts[0]
      const content = artifact?.id === indexId ? 'quote,theme\n“样例引用”,协作\n' : '# 访谈主题摘要\n\n这是标注样例内容，不是真实模型输出。'
      return { name: artifact?.name ?? '访谈主题摘要.md', mime: artifact?.mime ?? 'text/markdown', contentBase64: utf8Base64(content), size: new TextEncoder().encode(content).length, sha256: artifact?.sha256 ?? summarySha }
    }
    if (method === 'POST' && url.pathname === '/v1/workbench/create') {
      task = { ...makeTask('running'), id: 'c0ffee12', title: String(body.title || body.text || '新任务').slice(0, 40), path: String(body.path || ''), providerId: String(body.providerId || 'codex'), updatedAt: fixedNow }
      events = [{ id: '71deefdb-f897-44f8-a15a-733df5879b3c', taskId: task.id, kind: 'user', text: String(body.text || ''), createdAt: fixedNow }]
      artifacts = []
      mode = 'running'
      return { task }
    }
    if (method === 'POST' && url.pathname === '/v1/workbench/continue') {
      task = { ...task, status: 'running', updatedAt: fixedNow }
      events = [...events, { id: '3fd4797f-bbe1-4e26-bf28-9a0659931357', taskId: task.id, kind: 'user', text: String(body.text || ''), createdAt: fixedNow }]
      mode = 'running'
      return { task }
    }
    if (method === 'POST' && url.pathname === '/v1/workbench/cancel') {
      task = { ...task, status: 'cancelled', updatedAt: fixedNow }
      return { task }
    }
    if (method === 'POST' && url.pathname === '/v1/workbench/approve') {
      artifacts = artifacts.map(item => item.id === body.artifactId && item.sha256 === body.sha256 ? { ...item, approvedAt: fixedNow } : item)
      return { ok: true }
    }
    throw new Error(`fixture has no response for ${method} ${path}`)
  }
  setState(initialMode)
  return { api, setState }
}

if (typeof document !== 'undefined' && document.getElementById('workbench-root')) {
  const mode = new URLSearchParams(location.search).get('state') || 'completed'
  const fixture = makeFixtureApi(mode)
  initWorkbenchPage({ pollMs: 60000, invoke: async () => null, invokeWorkbenchApi: fixture.api })
}

import { makeNodes, projects } from './fixtures.js'

export function descendants(nodes, id) {
  const result = [], seen = new Set()
  function visit(nodeId) {
    if (seen.has(nodeId)) return
    seen.add(nodeId)
    const node = nodes.find(n => n.id === nodeId)
    if (node) result.push(node)
    for (const child of nodes.filter(n => n.parentId === nodeId)) visit(child.id)
  }
  visit(id)
  return result
}

export function createStore() {
  const values = Object.fromEntries(Object.keys(projects).map(id => [id, {
    id, nodes: makeNodes(id), selected: id === 'desktop' ? 'codex' : 'claude',
    draft: '', messages: [], expanded: new Set(), outputs: new Set(), mainTab: 'collaboration', detailTab: 'activity',
    panel: true, connected: true, scenario: 'running', fullStop: false, receipt: true, scroll: 0, detailScroll: 0,
  }]))
  return {
    projectId: 'desktop',
    current() { return values[this.projectId] },
    select(id) { if (values[id]) this.projectId = id },
    scenario(name) {
      const state = this.current()
      state.nodes = makeNodes(state.id)
      state.connected = name !== 'disconnected'
      state.scenario = name
      state.mainTab = 'collaboration'
      state.fullStop = false
      state.receipt = true
      if (name === 'permission') {
        state.nodes.find(n => n.id === 'codex-test').status = 'permission'
        state.nodes.find(n => n.id === 'codex-test').summary = '测试需要启动本机临时服务，等待授权。'
        state.selected = 'codex-test'
        state.panel = true
        state.expanded.add('codex')
      } else if (name === 'completed') {
        state.nodes.forEach(n => { n.status = 'completed'; n.received = true })
        state.nodes.find(n => n.id === 'codex').summary = '修改已完成，相关测试已通过。'
        state.nodes.find(n => n.id === 'codex-test').summary = '示例测试通过，结果已交回 Codex。'
        state.nodes.find(n => n.id === 'review').summary = '复核结束，未发现阻塞项；候选成果已保留。'
        state.mainTab = 'artifacts'
        state.selected = 'review'
      } else {
        state.mainTab = 'collaboration'
        state.selected = 'codex'
      }
    },
  }
}

export function overallStatus(state) {
  if (!state.connected) return 'unknown'
  const statuses = state.nodes.map(n => n.status)
  if (statuses.includes('stopping')) return 'stopping'
  if (state.fullStop && !statuses.some(s => ['running', 'queued', 'permission'].includes(s))) return 'stopped'
  if (statuses.some(s => ['blocked', 'stopped'].includes(s))) return 'blocked'
  if (statuses.includes('permission')) return 'permission'
  if (statuses.every(s => s === 'completed')) return 'completed'
  return 'running'
}

export function requestStop(state, id) {
  if (!state.connected) return false
  const scope = id ? descendants(state.nodes, id) : state.nodes
  if (!id) state.fullStop = true
  let changed = false
  for (const node of scope) {
    if (['running', 'queued', 'permission', 'blocked'].includes(node.status)) {
      node.status = 'stopping'
      node.summary = '停止请求已发出，等待执行端确认。'
      changed = true
    }
  }
  return changed
}

export function acknowledgeStops(state) {
  if (!state.connected) return
  for (const node of state.nodes.filter(n => n.status === 'stopping')) {
    node.status = 'stopped'
    node.summary = '执行端已确认停止。已经产生的文件仍然保留。'
  }
}

export function decidePermission(state, id, allow) {
  if (!state.connected) return false
  const node = state.nodes.find(n => n.id === id)
  if (!node || node.status !== 'permission') return false
  node.status = allow ? 'running' : 'blocked'
  node.summary = allow ? '已收到本次授权，继续运行测试。' : '你拒绝了本次授权，等待调整验证方式。'
  return true
}

export function handoffRecord(state, nodeId) {
  const node = state.nodes.find(n => n.id === nodeId)
  if (!node) throw new Error('Unknown handoff target')
  const parent = state.nodes.find(n => n.id === node.parentId)
  return {
    from: parent ? parent.owner : 'CC',
    to: `${node.owner} · ${node.title}`,
    request: node.id === 'review' ? '对照原始约束复核本版修改与测试结果。' : node.id === 'codex' ? '依据排查结论完成修改，并返回验证结果。' : `完成「${node.title}」，将结论交回上一级。`,
    version: node.id === 'review' ? '修改快照 v1 · 测试报告 v1' : node.id === 'codex' ? '排查结论 v1 · 项目文件快照 v1' : '本项目原始要求 v1 · 修改约束 v1',
    received: node.received,
    receiptId: node.received ? `${state.id}/receipt/${node.id}` : null,
  }
}

export function artifactSummary(state) {
  switch (overallStatus(state)) {
    case 'completed': return '修改、测试和独立复核已经完成。原始记录与本版成果一起保留。'
    case 'stopped': return '执行已停止。已产生的修改仍然保留，未完成的测试与复核没有结论。'
    case 'unknown': return '连接中断。只显示最后收到的文件记录，尚不确定执行是否仍在继续。'
    case 'stopping': return '已请求停止，等待执行端确认。保留已有修改，不推定验证已经结束。'
    case 'blocked': return '部分修改已经保留，但有子任务受阻。后续验证和复核尚未完成。'
    case 'permission': return '实现子任务已留下修改。验证正在等待授权，尚无最终结论。'
    default: return '实现子任务已留下修改。整体仍在执行，测试与复核结论尚未齐全。'
  }
}

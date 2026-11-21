// @ts-check
/** @typedef {import('@wechat-cc/protocol').PlaceMapItemT} MapItem */
/** @typedef {import('../vendor/mind-elixir/MindElixir.js').MindNode} MindNode */

export const branches = {
  open: { label: '没解决的', color: 'var(--th-accent)' },
  active: { label: '在做的', color: 'var(--th-warn)' },
  decided: { label: '定了的', color: 'var(--th-ink)' },
  done: { label: '做过的', color: 'var(--th-ink-soft)' },
  noted: { label: '记下的', color: 'var(--th-hair)' },
}

/** @param {MapItem} item @returns {keyof typeof branches | undefined} */
export function mapBranch({kind, status}) {
  switch (kind) {
    case 'ask': return 'open'
    case 'task':
    case 'session':
      if (status === 'waiting') return 'open'
      if (status === 'working') return 'active'
      return 'done'
    case 'commitment': return status === 'live' ? 'open' : 'done'
    case 'decision': return status === 'live' ? 'decided' : undefined
    case 'fact': return status === 'live' ? 'noted' : undefined
    case 'progress':
    case 'conclusion': return 'done'
  }
}

/** @param {MapItem} item */
export const placedBranch = item => item.pin ?? mapBranch(item)

/** @param {string} line */
export function mapLabel(line) {
  const chars = [...line]
  return chars.length > 28 ? chars.slice(0, 28).join('') + '…' : line
}

/** @param {string} id */
export const leafId = id => 'l:' + encodeURIComponent(id)

/** @param {string} name @param {MapItem[]} items @param {(item:MapItem)=>string} agent */
export function mapData(name, items, agent) {
  const placed = items.filter(item => placedBranch(item))
  const children = placed.length ? Object.entries(branches).map(([key, {label, color}]) => {
    const leaves = placed.filter(item => placedBranch(item) === key).map(item => {
      const family = item.kind === 'session' || item.kind === 'task' ? agent(item) : ''
      return { id: leafId(item.id), topic: [family, mapLabel(item.line)].filter(Boolean).join(' · '),
        ...(item.pin ? { tags: ['你放的'] } : {}) }
    })
    return { id: `g:${key}`, topic: label, branchColor: color, style: { border: `1px solid ${color}` }, children: leaves }
  }) : []
  const total = children.reduce((weight, branch) => weight + Math.max(1, branch.children.length) + .6, 0)
  let before = 0
  const directed = children.map((branch, index) => {
    const weight = Math.max(1, branch.children.length) + .6
    /** @type {0 | 1} */ const direction = index === 0 || before + weight / 2 < total / 2 ? 1 : 0
    before += weight
    return { ...branch, direction }
  })
  return { nodeData: { id: 'root', topic: name, children: directed } }
}

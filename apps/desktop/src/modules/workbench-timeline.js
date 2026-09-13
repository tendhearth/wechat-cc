// @ts-check

import { icon } from './icons.js'

/** @typedef {import('./workbench.js').WorkbenchEvent} WorkbenchEvent */
/** @typedef {{status:string,runId?:string,renderMessage:(event:WorkbenchEvent)=>string,escapeHtml:(value:unknown)=>string,formatTime:(value:number)=>string}} TimelineOptions */

const activityTypes = /** @type {const} */ (['command', 'read', 'edit', 'search', 'tool', 'agent', 'system'])
const typeLabels = { command:'命令', read:'读取', edit:'修改', search:'搜索', tool:'工具', agent:'协作', system:'运行记录' }
const typeIcons = { command:'play', read:'archive', edit:'edit-02', search:'search-01', tool:'settings-01', agent:'user-group', system:'time-02' }
const statusLabels = { running:'进行中', completed:'已完成', failed:'失败', cancelled:'已停止', interrupted:'已中断' }

/** Selector-safe, lossless IDs keep each disclosure attached to its first event.
 * @param {string} prefix @param {WorkbenchEvent} event */
function disclosureId(prefix, event) {
  const identity = JSON.stringify([event.taskId, event.runId ?? '', event.id])
  return `wb-${prefix}-${Array.from(identity, character => character.codePointAt(0)?.toString(16)).join('-')}`
}

/** @param {WorkbenchEvent} event */
export function workbenchTimelineEventId(event) { return disclosureId('event', event) }

/** @typedef {{id:string,offset:number}} TimelineAnchor */

/** Capture the content being read, not a pixel position whose meaning changes
 * when operations above it fold. Hidden descendants of details are skipped.
 * @param {Element} root @param {Element|null} content @returns {TimelineAnchor|null} */
export function captureWorkbenchTimelineAnchor(root, content) {
  const viewport = content?.getBoundingClientRect?.()
  if (!viewport || viewport.height <= 0) return null
  /** @type {TimelineAnchor|null} */ let firstOperation = null
  for (const node of root.querySelectorAll?.('[data-timeline-anchor]') ?? []) {
    const rect = node.getBoundingClientRect?.()
    if (node.id && rect && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
      const anchor = { id:node.id, offset:rect.top - viewport.top }
      // A short operation at the viewport edge must not displace the reply
      // being read when the surrounding group changes its layout.
      if (node.classList?.contains('wb-message')) return anchor
      firstOperation ??= anchor
    }
  }
  return firstOperation
}

/** @param {Element} root @param {Element} content @param {TimelineAnchor|undefined} anchor */
export function restoreWorkbenchTimelineAnchor(root, content, anchor) {
  if (!anchor) return
  const node = root.querySelector(`#${anchor.id}`)
  if (!node) return
  // If the reader is inside a group at completion, keep that group readable.
  // Groups above the reader still fold; "latest content" closes this one too.
  node.closest('details[data-timeline-group]')?.setAttribute('open', '')
  const rect = node.getBoundingClientRect?.(), viewport = content.getBoundingClientRect?.()
  if (rect && viewport && rect.height > 0) content.scrollTop += rect.top - viewport.top - anchor.offset
}

/** @param {WorkbenchEvent} event */
function visibleIssue(event) {
  return event.kind === 'error' || ['failed', 'cancelled', 'interrupted'].includes(event.activity?.status ?? '')
}

/** Preserve arrival position while applying durable activity updates in place.
 * @param {WorkbenchEvent[]} events */
function coalesceActivities(events) {
  /** @type {WorkbenchEvent[]} */ const ordered = []
  /** @type {Map<string,number>} */ const positions = new Map()
  for (const event of events) {
    const key = event.activity && event.kind !== 'user' && event.kind !== 'text'
      ? JSON.stringify([event.runId ?? '', event.activity.id]) : null
    const position = key === null ? undefined : positions.get(key)
    const first = position === undefined ? undefined : ordered[position]
    if (position !== undefined && first && event.activity) {
      ordered[position] = { ...first, ...event, id:first.id, createdAt:first.createdAt, activity:{ ...first.activity, ...event.activity } }
    } else {
      if (key !== null) positions.set(key, ordered.length)
      ordered.push(event)
    }
  }
  return ordered
}

/** @param {WorkbenchEvent} event @param {TimelineOptions} options */
function renderOperation(event, options) {
  const { escapeHtml:escape, formatTime } = options
  const activity = event.activity
  const issue = visibleIssue(event)
  const type = activity?.type ?? (event.kind === 'system' ? 'system' : 'tool')
  const label = activity?.label || event.text
  const detail = activity?.detail && activity.detail !== label ? `<pre>${escape(activity.detail)}</pre>` : ''
  const agents = activity?.agentIds?.length ? `<p class="wb-operation-agents">协作执行者 · ${activity.agentIds.map(id => `<code>${escape(id)}</code>`).join('、')}</p>` : ''
  const parent = activity?.parentId ? `<p class="wb-operation-parent">上级操作 · <code>${escape(activity.parentId)}</code></p>` : ''
  const extra = detail + agents + parent
  const extraHtml = extra ? issue ? `<div class="wb-operation-detail">${extra}</div>`
    : `<details id="${disclosureId('activity', event)}" class="wb-operation-detail" data-timeline-disclosure><summary>查看详情</summary>${extra}</details>` : ''
  return `<article class="wb-operation" id="${workbenchTimelineEventId(event)}" data-timeline-anchor data-kind="${escape(event.kind)}" data-activity-type="${escape(type)}"${activity ? ` data-status="${escape(activity.status)}"` : ''}${issue ? ` role="${event.kind === 'error' || activity?.status === 'failed' ? 'alert' : 'status'}"` : ''}>
    <div class="wb-operation-line"><span class="wb-operation-type">${icon(event.kind === 'error' ? 'alert-02' : typeIcons[type], { size:13 })}<span class="wb-sr-only">${escape(event.kind === 'error' ? '错误' : typeLabels[type])}</span></span><span class="wb-operation-label">${escape(label)}</span>${activity ? `<span class="wb-operation-status">${escape(statusLabels[activity.status])}</span>` : ''}<time>${escape(formatTime(event.createdAt))}</time></div>${extraHtml}
  </article>`
}

/** @param {WorkbenchEvent[]} events @param {TimelineOptions} options */
function renderGroup(events, options) {
  const first = events[0]
  if (!first) return ''
  const live = ['running', 'cancelling'].includes(options.status)
    && (options.runId ? first.runId === options.runId : !first.runId)
  const rows = `<div class="wb-operation-list">${events.map(event => renderOperation(event, options)).join('')}</div>`
  // Live groups are not disclosures. Finishing a run therefore creates a new,
  // closed disclosure instead of preserving an automatically opened state.
  if (live) return `<div class="wb-operation-group" data-timeline-group data-run-id="${options.escapeHtml(first.runId)}">${rows}</div>`
  const counts = events.reduce((counts, event) => {
    const type = event.activity?.type ?? (event.kind === 'system' ? 'system' : 'tool')
    counts.set(type, (counts.get(type) ?? 0) + 1)
    return counts
  }, /** @type {Map<string,number>} */ (new Map()))
  const summary = activityTypes.filter(type => counts.has(type)).map(type => `${typeLabels[type]} ${counts.get(type)}`).join(' · ')
  return `<details id="${disclosureId('operations', first)}" class="wb-disclosure wb-operation-group" data-timeline-group data-timeline-disclosure data-run-id="${options.escapeHtml(first.runId)}"><summary><span>操作记录</span><small>${summary}</small></summary>${rows}</details>`
}

/** @param {WorkbenchEvent[]} events @param {TimelineOptions} options */
export function renderWorkbenchTimeline(events, options) {
  const html = []
  /** @type {WorkbenchEvent[]} */ let group = []
  const flush = () => { if (group.length) html.push(renderGroup(group, options)); group = [] }
  for (const event of coalesceActivities(events)) {
    if (event.kind === 'user' || event.kind === 'text') {
      flush(); html.push(options.renderMessage(event))
    } else if (visibleIssue(event)) {
      flush(); html.push(renderOperation(event, options))
    } else {
      if (group.length && group[0]?.runId !== event.runId) flush()
      group.push(event)
    }
  }
  flush()
  return html.join('')
}

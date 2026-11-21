// @ts-check
import { V1, v1 } from '../daemon-client.js'
import { branches, leafId, mapBranch, mapData, placedBranch } from './lab-map-model.js'
import { placeTime } from './places-strip.js'

/** @typedef {import('@wechat-cc/protocol').PlaceMapItemT} Item */
/** @typedef {import('@wechat-cc/protocol').PlaceMapResponseT} Response */
/** @typedef {import('@wechat-cc/protocol').PlaceMapBranchT} Branch */
/** @typedef {import('../vendor/mind-elixir/MindElixir.js').MindTopic} Topic */
/** @typedef {import('../vendor/mind-elixir/MindElixir.js').default} Mind */

const kinds = { decision:'决定', commitment:'说好要做的', progress:'进展', conclusion:'结果', fact:'记下的事', session:'会话', task:'任务', ask:'等你定' }
const sources = { chat:'和 CC 聊的', work:'交办的活', delegate:'交办的活', task:'交办的活', terminal:'终端会话' }
const hint = '点一条看它是什么、哪来的；按住一条拖到另一支上，就是把它挪过去。按住空白处能拖动整张图，捏合或按住 ⌘ 滚动能放大缩小。'
const deny = () => /** @type {const} */ (false)
/** @param {Topic} topic */
const isLeaf = topic => topic.nodeObj.id.startsWith('l:')
/** @param {Topic[]} nodes */
const movable = nodes => nodes.length > 0 && nodes.every(node => isLeaf(node) && !node.nodeObj.id.startsWith(leafId('a:')))

/** @param {() => boolean} canMove */
const mapGuards = canMove => ({
  addChild: deny, beginEdit: deny, copyNode: deny, copyNodes: deny, insertParent: deny,
  insertSibling: deny, moveDownNode: deny,
  /** @param {Topic[]} from @param {Topic} to */
  moveNodeIn: (from, to) => canMove() && movable(from) && to.nodeObj.id.startsWith('g:'),
  /** @param {Topic[]} from @param {Topic} to */
  moveNodeBefore: (from, to) => canMove() && movable(from) && isLeaf(to),
  /** @param {Topic[]} from @param {Topic} to */
  moveNodeAfter: (from, to) => canMove() && movable(from) && isLeaf(to),
  moveUpNode: deny, removeNodes: deny, reshapeNode: deny, rmSubline: deny, setNodeTopic: deny,
})
const theme = {
  name: 'Tendhearth', type: /** @type {const} */ ('light'),
  palette: Object.values(branches).map(branch => branch.color),
  cssVar: {
    '--node-gap-x': '18px', '--node-gap-y': '5px', '--main-gap-x': '24px', '--main-gap-y': '18px',
    '--root-radius': '999px', '--main-radius': '999px', '--topic-padding': '3px 4px',
    '--root-color': 'var(--th-on-accent)', '--root-bgcolor': 'var(--th-accent)', '--root-border-color': 'transparent',
    '--main-color': 'var(--th-ink)', '--main-bgcolor': 'var(--th-paper)', '--color': 'var(--th-ink)',
    '--bgcolor': 'var(--th-paper)', '--selected': 'var(--th-accent)', '--accent-color': 'var(--th-accent)',
  },
}

/** @type {Promise<typeof import('../vendor/mind-elixir/MindElixir.js')>|undefined} */ let modulePromise
/** @type {Promise<void>|undefined} */ let stylesheet

function loadMap() {
  modulePromise ??= import('../vendor/mind-elixir/MindElixir.js').catch(error => {
    modulePromise = undefined
    throw error
  })
  return Promise.all([modulePromise, loadStylesheet()]).then(([module]) => module.default)
}
function loadStylesheet() {
  return stylesheet ??= new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = new URL('../vendor/mind-elixir/MindElixir.css', import.meta.url).href
    link.onload = () => resolve()
    link.onerror = () => { link.remove(); stylesheet = undefined; reject() }
    document.head.append(link)
  })
}

/**
 * @param {{host:HTMLElement,key:string,call:import('./terminal-thread.js').Call,
 * agent:(item:Item)=>string,canJump:(item:Item)=>boolean,jump:(item:Item)=>void}} options
 */
export function mountLabMap({host, key, call, agent, canJump, jump}) {
  host.innerHTML = `<div class="lab-map-bar"><span>实验 <span class="lab-map-write-error" role="status"></span></span><button type="button" class="desk-text-button" data-map-fit hidden>回到中间</button></div>
    <div class="lab-map-state"><p class="lab-map-note" role="status">正在读取…</p><button type="button" class="desk-text-button" data-map-retry hidden>再试一次</button></div>
    <div class="lab-map-viewport" hidden><div></div></div>
    <div class="lab-map-details" aria-live="polite" hidden></div>`
  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (host.querySelector(selector))
  const viewport = find('.lab-map-viewport')
  const element = /** @type {HTMLDivElement} */ (viewport.firstElementChild)
  const details = find('.lab-map-details')
  const note = find('.lab-map-note')
  const writeError = find('.lab-map-write-error')
  const fitButton = find('[data-map-fit]')
  const retryButton = find('[data-map-retry]')
  /** @type {Mind|undefined} */ let mind
  /** @type {Response|undefined} */ let data
  /** @type {Item|undefined} */ let selected
  let stopped = false, loading = false, restoring = false

  let saving = false, needsRead = false, writeVersion = 0
  /** @type {{ graph:Mind, id:number, x:number, y:number }|undefined} */ let pan

  function fit() {
    if (!mind) return
    const { nodes, container } = mind
    const ratio = Math.max(nodes.offsetWidth / container.offsetWidth, nodes.offsetHeight / container.offsetHeight)
    if (ratio <= 1 / .82) mind.scaleFit()
    else { mind.scale(.82); mind.toCenter() }
  }

  function drawDetails() {
    details.replaceChildren()
    const item = selected
    const branch = item && placedBranch(item)
    const p = (/** @type {string} */ text, /** @type {string} */ className) => {
      const row = document.createElement('p')
      row.className = className
      row.textContent = text
      details.append(row)
    }
    if (!item || !branch) { p(hint, 'lab-map-meta'); return }
    p(item.line, 'lab-map-line')
    const date = item.from.at ? placeTime({ moving: false, updatedAt: item.from.at }, Date.now()) : ''
    const original = mapBranch(item)
    const placement = item.pin
      ? '你放的' + (original ? ` · 本来在「${branches[original].label}」` : '')
      : branches[branch].label
    p(item.pin ? placement : [placement, kinds[item.kind], sources[item.from.source], date].filter(Boolean).join(' · '), 'lab-map-meta')
    if (item.body) p('CC 记的：' + item.body, 'lab-map-body')
    if (canJump(item)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'desk-text-button'
      button.textContent = '去那条线上看 ›'
      button.dataset.mapJump = ''
      button.onclick = () => jump(item)
      details.append(button)
    }
    if (item.id.startsWith('a:')) {
      p('这件要你定，去那条线上答。', 'lab-map-meta')
      return
    }
    const moves = document.createElement('div')
    moves.className = 'lab-map-moves'
    const label = document.createElement('span')
    label.textContent = '挪到'
    moves.append(label)
    /** @param {string} text @param {Branch|null} target */
    const moveButton = (text, target) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'desk-text-button'
      button.dataset.mapPin = target ?? ''
      button.textContent = text
      button.setAttribute('aria-disabled', String(saving))
      button.onclick = () => { void placeItems([item], target) }
      moves.append(button)
    }
    for (const target of /** @type {Branch[]} */ (Object.keys(branches))) {
      if (target !== branch) moveButton(branches[target].label, target)
    }
    if (item.pin) moveButton('放回去', null)
    details.append(moves)
  }

  function redraw() {
    if (!mind || !data) return
    const focus = document.activeElement
    const focusedTopic = focus instanceof HTMLElement && element.contains(focus) ? focus.dataset.nodeid : undefined
    const focusedPin = focus instanceof HTMLElement && details.contains(focus) ? focus.dataset.mapPin : undefined
    const focusedJump = focus instanceof HTMLElement && details.contains(focus) && focus.hasAttribute('data-map-jump')
    const { transform, transformOrigin } = mind.map.style
    restoring = true
    try {
      mind.refresh(mapData(data.place.name, data.items, agent))
      prepareTopics()
      if (selected) mind.selectNode(mind.findEle(leafId(selected.id)))
      mind.map.style.transform = transform
      mind.map.style.transformOrigin = transformOrigin
    } finally { restoring = false }
    drawDetails()
    const action = focusedPin !== undefined
      ? details.querySelector(`[data-map-pin="${focusedPin}"]`)
      : focusedJump ? details.querySelector('[data-map-jump]') : null
    const topic = [...element.querySelectorAll('me-tpc')].find(el =>
      el.getAttribute('data-nodeid') === (focusedTopic ?? (selected ? 'me' + leafId(selected.id) : '')))
    if (focusedTopic || focusedPin !== undefined || focusedJump) {
      const target = action ?? topic ?? fitButton
      if (target instanceof HTMLElement) target.focus({ preventScroll:true })
    }
  }

  function prepareTopics() {
    if (!mind || !data) return
    for (const item of data.items) {
      if (!placedBranch(item)) continue
      const topic = mind.findEle(leafId(item.id))
      topic.tabIndex = 0
      topic.setAttribute('role', 'button')
    }
  }

  /** @param {Item[]} items @param {Branch|null} branch */
  async function placeItems(items, branch) {
    const graph = mind
    if (stopped || !graph || !data || saving) return
    const changed = items.filter(item => !item.id.startsWith('a:')
      && (branch === null ? item.pin : placedBranch(item) !== branch))
    const first = changed[0]
    if (!first) { redraw(); return }

    const ids = new Set(changed.map(item => item.id))
    const selectedId = selected?.id ?? first.id
    saving = true
    writeVersion++
    data = { ...data, items: data.items.map(item => ids.has(item.id) ? { ...item, pin: branch ?? undefined } : item) }
    selected = data.items.find(item => item.id === selectedId && placedBranch(item))
    redraw()
    const results = await Promise.allSettled(changed.map(async item => {
      const reply = /** @type {{ok?:boolean}|null} */ (await v1(call, V1.places.mapPin, { body: { key, itemId: item.id, branch } }))
      if (reply?.ok !== true) throw Error('place_map_pin_failed')
    }))
    if (stopped || mind !== graph) return

    const failed = new Map(changed.filter((_item, index) => results[index]?.status === 'rejected').map(item => [item.id, item]))
    saving = false
    if (failed.size) {
      data = { ...data, items: data.items.map(item => failed.get(item.id) ?? item) }
    }
    selected = data.items.find(item => item.id === (selected?.id ?? selectedId) && placedBranch(item))
    writeError.textContent = failed.size ? '没挪成，再试一次。' : ''
    redraw()
    if (failed.size < changed.length) {
      needsRead = true
      void read()
    }
  }

  function clear() {
    mind?.destroy()
    mind = undefined
    pan = undefined
    data = undefined
    selected = undefined
    viewport.hidden = details.hidden = fitButton.hidden = true
    details.replaceChildren()
  }

  async function read() {
    if (stopped || loading || saving || mind?.dragged || document.visibilityState !== 'visible') return
    const version = writeVersion
    const force = needsRead
    needsRead = false
    loading = true
    retryButton.hidden = true
    try {
      const [next, MindElixir] = await Promise.all([
        /** @type {Promise<Response>} */ (v1(call, V1.places.map, { query: { key } })),
        loadMap(),
      ])
      if (stopped || version !== writeVersion || mind?.dragged) { needsRead ||= force; return }
      if (next.place.key !== key) throw Error('place_not_found')
      if (!force && note.hidden && data?.revision === next.revision) return
      const tree = mapData(next.place.name, next.items, agent)
      if (!tree.nodeData.children.length) {
        clear()
        data = next
        note.textContent = 'CC 手上还没有这件事的条目。'
        note.hidden = false
        return
      }

      const kept = selected && next.items.find(item => item.id === selected?.id && placedBranch(item))
      data = next
      selected = kept
      note.hidden = true
      viewport.hidden = details.hidden = fitButton.hidden = false
      if (!mind) {
        mind = new MindElixir({ el: element, direction: 2, editable: true, contextMenu: false,
          toolBar: false, keypress: false, allowUndo: false, before: mapGuards(() => !saving && !stopped), theme })
        const error = mind.init(tree)
        if (error) { clear(); throw error }
        const graph = mind
        mind.container.tabIndex = -1
        prepareTopics()
        mind.bus.addListener('selectNodes', nodes => {
          if (restoring) return
          selected = data?.items.find(item => leafId(item.id) === nodes[0]?.id)
          drawDetails()
        })
        mind.bus.addListener('unselectNodes', () => {
          if (restoring) return
          selected = undefined
          drawDetails()
        })
        // Move hooks run asynchronously. Ignore operations from a graph that has been unmounted.
        graph.bus.addListener('operation', op => queueMicrotask(() => {
          if (op.name === 'expandNode' || stopped || mind !== graph || saving) return
          const target = op.name === 'moveNodeIn' ? op.toObj : op.toObj.parent
          const branch = /** @type {Branch} */ (target?.id.slice(2))
          if (!target?.id.startsWith('g:') || !Object.hasOwn(branches, branch)) return
          const ids = new Set(op.objs.map(node => node.id))
          void placeItems(data?.items.filter(item => ids.has(leafId(item.id))) ?? [], branch)
        }))
        fit()
        drawDetails()
      } else redraw()
    } catch {
      if (stopped || version !== writeVersion) return
      if (!mind || !data) clear()
      note.hidden = false
      note.textContent = '图没读出来。'
      retryButton.hidden = false
    } finally {
      loading = false
      if (needsRead && version !== writeVersion) void read()
    }
  }

  element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const topic = event.target
    if (!(topic instanceof HTMLElement) || topic.tagName !== 'ME-TPC') return
    event.preventDefault()
    event.stopPropagation()
    mind?.selectNode(topic)
    details.querySelector('button')?.focus()
  }, { capture:true })
  element.addEventListener('pointerdown', event => {
    const target = event.target
    if (!mind || event.button !== 0 || event.pointerType !== 'mouse' || !(target instanceof Element)) return
    const topic = target.closest('me-tpc')
    if (topic) {
      const id = topic.getAttribute('data-nodeid')
      if (saving || !id?.startsWith('mel:') || id.startsWith('me' + leafId('a:'))) {
        event.stopPropagation()
        if (topic instanceof HTMLElement) mind.selectNode(topic)
      }
      return
    }
    // Editable MindElixir reserves the blank canvas for box selection. Pan with its move API.
    event.stopPropagation()
    mind.container.setPointerCapture(event.pointerId)
    pan = { graph:mind, id:event.pointerId, x:event.clientX, y:event.clientY }
  }, { capture:true })
  element.addEventListener('pointermove', event => {
    if (!pan || pan.graph !== mind || pan.id !== event.pointerId) return
    pan.graph.move(event.clientX - pan.x, event.clientY - pan.y)
    pan.x = event.clientX
    pan.y = event.clientY
  })
  element.addEventListener('lostpointercapture', event => {
    if (pan?.id === event.pointerId) pan = undefined
  })
  fitButton.onclick = fit
  retryButton.onclick = () => { needsRead = true; void read() }
  document.addEventListener('visibilitychange', read)
  const timer = window.setInterval(read, 30_000)
  void read()
  return () => {
    stopped = true
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', read)
    clear()
    host.replaceChildren()
  }
}

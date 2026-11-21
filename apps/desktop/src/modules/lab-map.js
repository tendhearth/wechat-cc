// @ts-check
import { V1, v1 } from '../daemon-client.js'
import { branches, leafId, mapBranch, mapData } from './lab-map-model.js'

/** @typedef {import('@wechat-cc/protocol').PlaceMapItemT} Item */
/** @typedef {import('@wechat-cc/protocol').PlaceMapResponseT} Response */
/** @typedef {import('../vendor/mind-elixir/MindElixir.js').default} Mind */

const kinds = { decision:'决定', commitment:'说好要做的', progress:'进展', conclusion:'结果', fact:'记下的事', session:'会话', task:'任务', ask:'等你定' }
const sources = { chat:'和 CC 聊的', work:'交办的活', delegate:'交办的活', task:'交办的活', terminal:'终端会话' }
const hint = '点一条看它是什么、哪来的。按住空白处能拖动整张图，捏合或按住 ⌘ 滚动能放大缩小。'
const deny = () => /** @type {const} */ (false)
const before = {
  addChild: deny, beginEdit: deny, copyNode: deny, copyNodes: deny, insertParent: deny,
  insertSibling: deny, moveDownNode: deny, moveNodeAfter: deny, moveNodeBefore: deny,
  moveNodeIn: deny, moveUpNode: deny, removeNodes: deny, reshapeNode: deny, rmSubline: deny, setNodeTopic: deny,
}
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
  host.innerHTML = `<div class="lab-map-bar"><span>实验</span><button type="button" class="desk-text-button" data-map-fit hidden>回到中间</button></div>
    <p class="lab-map-note" role="status">正在读取…</p><button type="button" class="desk-text-button" data-map-retry hidden>再试一次</button>
    <div class="lab-map-viewport" hidden><div></div></div>
    <div class="lab-map-details" aria-live="polite" hidden></div>`
  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (host.querySelector(selector))
  const viewport = find('.lab-map-viewport')
  const element = /** @type {HTMLDivElement} */ (viewport.firstElementChild)
  const details = find('.lab-map-details')
  const note = find('.lab-map-note')
  const fitButton = find('[data-map-fit]')
  const retryButton = find('[data-map-retry]')
  /** @type {Mind|undefined} */ let mind
  /** @type {Response|undefined} */ let data
  /** @type {Item|undefined} */ let selected
  let stopped = false, loading = false, restoring = false

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
    const branch = item && mapBranch(item)
    const p = (/** @type {string} */ text, /** @type {string} */ className) => {
      const row = document.createElement('p')
      row.className = className
      row.textContent = text
      details.append(row)
    }
    if (!item || !branch) { p(hint, 'lab-map-meta'); return }
    p(item.line, 'lab-map-line')
    const date = item.from.at ? new Date(item.from.at).toLocaleDateString('zh-CN') : ''
    p([branches[branch].label, kinds[item.kind], sources[item.from.source], date].filter(Boolean).join(' · '), 'lab-map-meta')
    if (item.body) p('CC 记的：' + item.body, 'lab-map-body')
    if (canJump(item)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'desk-text-button'
      button.textContent = '去那条线上看 ›'
      button.onclick = () => jump(item)
      details.append(button)
    }
  }

  function clear() {
    mind?.destroy()
    mind = undefined
    data = undefined
    selected = undefined
    viewport.hidden = details.hidden = fitButton.hidden = true
    details.replaceChildren()
  }

  async function read() {
    if (stopped || loading || document.visibilityState !== 'visible') return
    loading = true
    retryButton.hidden = true
    try {
      const [next, MindElixir] = await Promise.all([
        /** @type {Promise<Response>} */ (v1(call, V1.places.map, { query: { key } })),
        loadMap(),
      ])
      if (stopped) return
      if (next.place.key !== key) throw Error('place_not_found')
      if (data?.revision === next.revision) return
      const tree = mapData(next.place.name, next.items, agent)
      if (!tree.nodeData.children.length) {
        clear()
        data = next
        note.textContent = 'CC 手上还没有这件事的条目。'
        note.hidden = false
        return
      }

      const kept = selected && next.items.find(item => item.id === selected?.id && mapBranch(item))
      data = next
      note.hidden = true
      viewport.hidden = details.hidden = fitButton.hidden = false
      if (!mind) {
        mind = new MindElixir({ el: element, direction: 2, editable: false, contextMenu: false,
          toolBar: false, keypress: false, allowUndo: false, before, theme })
        const error = mind.init(tree)
        if (error) throw error
        mind.container.tabIndex = -1
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
        fit()
      } else {
        const { transform, transformOrigin } = mind.map.style
        restoring = true
        try {
          mind.refresh(tree)
          if (kept) mind.selectNode(mind.findEle(leafId(kept.id)))
          mind.map.style.transform = transform
          mind.map.style.transformOrigin = transformOrigin
        } finally { restoring = false }
      }
      selected = kept
      drawDetails()
    } catch {
      if (stopped) return
      clear()
      note.hidden = false
      note.textContent = '图没读出来。'
      retryButton.hidden = false
    } finally { loading = false }
  }
  // MindElixir also pans from labels in read-only mode. Only blank space starts a mouse pan here.
  element.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && event.buttons === 1 && event.target instanceof Element
      && event.target.closest('me-tpc')) event.stopPropagation()
  }, {capture:true})
  fitButton.onclick = fit
  retryButton.onclick = () => { void read() }
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

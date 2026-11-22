// @ts-check
import { V1, v1 } from '../daemon-client.js'
import { branches, leafId } from './lab-map-model.js'
import { outlineData, outlineNotice, outlineSource } from './lab-outline-model.js'

/** @typedef {import('./lab-outline-model.js').Leaf} Leaf */
/** @typedef {import('./lab-outline-model.js').Source} Source */
/** @typedef {import('./lab-outline-model.js').Outline} Outline */
/** @typedef {import('@wechat-cc/protocol').PlaceMapResponseT} Response */
/** @typedef {import('../vendor/mind-elixir/MindElixir.js').default} Mind */

export const mapFitButton = `<button type="button" class="lab-map-fit" data-map-fit aria-label="回到中间" hidden>
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2.5m0 8v2.5M1.5 8H4m8 0h2.5"/>
  </svg>
</button>`

/** @param {keyof typeof branches} status */
export function mapStatusChip(status) {
  const chip = document.createElement('span')
  chip.className = 'lab-map-chip'
  chip.dataset.mapStatus = status
  chip.textContent = branches[status].label
  return chip
}

/** @param {HTMLElement} details @param {string} text */
export function mapCardTitle(details, text) {
  const top = document.createElement('div')
  top.className = 'lab-map-card-top'
  const line = document.createElement('p')
  line.className = 'lab-map-line'
  line.textContent = text
  top.append(line)
  details.append(top)
  return top
}

/** @param {() => void} jump */
export function mapJumpButton(jump) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'desk-text-button'
  button.textContent = '去线上看'
  button.onclick = jump
  return button
}

/**
 * @param {{ host:HTMLElement, key:string, call:import('./terminal-thread.js').Call,
 * loadMap:()=>Promise<typeof import('../vendor/mind-elixir/MindElixir.js').default>, theme:import('../vendor/mind-elixir/MindElixir.js').Options['theme'],
 * fitMap:(mind:Mind)=>void, canJumpSource:(source:Source)=>boolean, jumpSource:(source:Source)=>void }} options
 */
export function mountOutlineMap({host, key, call, loadMap, theme, fitMap, canJumpSource, jumpSource}) {
  host.innerHTML = `<div class="lab-map-bar"><span>实验</span></div>
    ${mapFitButton}
    <div class="lab-map-state lab-outline-state">
      <div><span class="lab-map-note" role="status">正在读取…</span> <button type="button" class="desk-text-button" data-outline-action hidden></button></div>
      <p class="lab-map-meta" data-outline-info hidden></p>
    </div>
    <div class="lab-map-viewport" hidden><div></div></div>
    <p class="lab-map-hint" hidden>点一条看它的出处</p>
    <div aria-live="polite"><div class="lab-map-details" hidden></div></div>`
  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (host.querySelector(selector))
  const note = find('.lab-map-note')
  const info = find('[data-outline-info]')
  const action = /** @type {HTMLButtonElement} */ (find('[data-outline-action]'))
  const fit = find('[data-map-fit]')
  const viewport = find('.lab-map-viewport')
  const element = /** @type {HTMLDivElement} */ (viewport.firstElementChild)
  const hint = find('.lab-map-hint')
  const details = find('.lab-map-details')
  /** @type {Mind|undefined} */ let mind
  /** @type {Leaf|undefined} */ let selected
  /** @type {Outline|undefined} */ let outline
  let stopped = false, posting = false, reading = false, readVersion = 0
  let graphVersion = '', timer = 0

  function drawDetails() {
    details.replaceChildren()
    details.hidden = !selected
    hint.hidden = Boolean(selected)
    if (!selected) return
    const top = mapCardTitle(details, selected.line)
    const chip = mapStatusChip(selected.status)
    if (!selected.sources.length) details.append(chip)
    for (const [index, source] of selected.sources.entries()) {
      const row = document.createElement('p')
      row.className = 'lab-map-meta'
      const display = outlineSource(source, canJumpSource(source), Date.now(), index === 0)
      if (index === 0) row.append(chip)
      const from = document.createElement('span')
      from.textContent = display.text + (display.missing ? '，那次会话已经翻不到了' : '')
      row.append(from)
      if (display.jump) {
        const button = mapJumpButton(() => {
          if (canJumpSource(source)) jumpSource(source)
          else drawDetails()
        })
        const target = index === 0 ? top : row
        target.append(button)
      }
      details.append(row)
    }
  }

  function clear() {
    mind?.destroy()
    mind = selected = undefined
    graphVersion = ''
    viewport.hidden = details.hidden = hint.hidden = fit.hidden = true
    details.replaceChildren()
  }

  /** @param {Outline} next */
  function showNotice(next) {
    outline = next
    const { text, action: label, reason } = outlineNotice(next, Date.now(), document.documentElement.hasAttribute('data-desk-wide'))
    note.textContent = text
    action.textContent = label
    action.hidden = !label
    action.onclick = label ? start : null
    info.textContent = next.state === 'none' && next.canRun
      ? 'CC 会读这件事最近几次会话里你说的和它说的，分成几块。要用模型；内容没变不会重复算，一天梳理成一次为止。'
      : reason ?? ''
    info.hidden = !info.textContent
  }

  function schedule() {
    window.clearTimeout(timer)
    if (!stopped) timer = window.setTimeout(read, outline?.state === 'running' ? 3000 : 30_000)
  }

  async function start() {
    if (stopped || posting) return
    posting = true
    readVersion++
    reading = false
    window.clearTimeout(timer)
    clear()
    showNotice({ state: 'running', canRun: false })
    try { await v1(call, V1.places.mapOutline, { body: { key } }) }
    catch { /* Read the daemon's actual quota and outcome. */ }
    finally {
      posting = false
      if (!stopped) void read()
    }
  }

  async function read() {
    if (stopped || reading || posting || document.visibilityState !== 'visible') return
    reading = true
    const version = ++readVersion
    try {
      const next = /** @type {Response} */ (await v1(call, V1.places.map, { query: { key, outline: '1' } }))
      if (stopped || version !== readVersion) return
      if (next.place.key !== key || !next.outline) throw Error('outline_unavailable')
      showNotice(next.outline)
      if (next.outline.state !== 'ready' || !next.outline.aspects?.length) { clear(); return }
      const aspects = next.outline.aspects
      const revision = JSON.stringify([next.place.name, next.outline.at, aspects])
      if (revision === graphVersion) return
      const MindElixir = await loadMap()
      if (stopped || version !== readVersion) return
      clear()
      viewport.hidden = hint.hidden = fit.hidden = false
      const graph = new MindElixir({ el: element, direction: 2, editable: false, contextMenu: false,
        toolBar: false, keypress: false, allowUndo: false, before: {}, theme })
      mind = graph
      const error = graph.init(outlineData(next.place.name, aspects))
      if (error) throw error
      const leaves = new Map(aspects.flatMap(aspect => aspect.items.map(leaf => [leafId(leaf.id), leaf])))
      for (const [id, leaf] of leaves) {
        const topic = graph.findEle(id)
        topic.dataset.outlineStatus = leaf.status
        topic.tabIndex = 0
        topic.setAttribute('role', 'button')
      }
      graph.linkDiv()
      graph.bus.addListener('selectNodes', nodes => {
        if (mind !== graph) return
        selected = leaves.get(nodes[0]?.id ?? '')
        drawDetails()
      })
      graph.bus.addListener('unselectNodes', () => {
        if (mind !== graph) return
        selected = undefined
        drawDetails()
      })
      fitMap(graph)
      graphVersion = revision
    } catch {
      if (stopped || version !== readVersion) return
      clear()
      note.textContent = '图没读出来。'
      info.hidden = true
      action.hidden = false
      action.textContent = '再试一次'
      action.onclick = read
    } finally {
      if (version === readVersion) {
        reading = false
        schedule()
      }
    }
  }

  element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.dataset.outlineStatus) return
    event.preventDefault()
    mind?.selectNode(target)
    details.querySelector('button')?.focus()
  })
  fit.onclick = () => { if (mind) fitMap(mind) }
  document.addEventListener('visibilitychange', read)
  void read()
  return () => {
    stopped = true
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', read)
    clear()
    host.replaceChildren()
  }
}

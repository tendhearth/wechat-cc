// @ts-check
// pet-lab.js — 调试页:13 个状态、两态、道具、假 presence、reduced motion、warning 列表。不进正式窗口。
import { createPet } from './pet/pet.js'
import { presenceToPet } from './pet/bridge/presence-map.js'
import { BEHAVIORS, PROPS } from './pet/domain/types.js'

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const reduced = new URLSearchParams(location.search).has('reduced');
/** @type {HTMLInputElement} */ ($('lab-reduced')).checked = reduced
$('lab-reduced').addEventListener('change', (e) => { location.search = /** @type {HTMLInputElement} */ (e.target).checked ? '?reduced' : '' })

const pet = await createPet({ stage: $('pet-stage'), img: $('pet-sprite'), props: $('pet-props'), hint: $('pet-hint') }, { manifestUrl: './assets/pet/manifest.json', reducedMotion: reduced });
/** @type {any} */ (window).__pet = pet

const btn = (/** @type {string} */ label, /** @type {() => void} */ onClick) => { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', onClick); return b }
for (const f of /** @type {const} */ (['unlit', 'lit'])) $('lab-forms').appendChild(btn(f, () => pet.setForm(f)))
for (const b of BEHAVIORS) $('lab-behaviors').appendChild(btn(b, () => { const r = pet.setState(b); console.log('setState', b, r) }))
/** @type {Set<string>} */ const on = new Set()
for (const p of PROPS) {
  const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'
  c.addEventListener('change', () => { c.checked ? on.add(p) : on.delete(p); pet.setProps([...on], on.has('envelope') ? 3 : 0) })
  l.append(c, ` ${p}`); $('lab-props').appendChild(l)
}
/** @type {Record<string, any>} */
const fakes = {
  down: null,
  offline: { presence: 'offline', activity: { kind: 'idle', label: '', since: null }, news: { unread: 2, latest_kind: 'hunt', latest_title: 'x' } },
  degraded: { presence: 'degraded', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
  chatting: { presence: 'ok', activity: { kind: 'chatting', label: '在跟你聊', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
  working: { presence: 'ok', activity: { kind: 'working', label: '在忙', since: null }, news: { unread: 1, latest_kind: 'postcard', latest_title: 'y' } },
  visiting: { presence: 'ok', activity: { kind: 'visiting', label: '去串门', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
  idle: { presence: 'ok', activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } },
}
/** @type {any} */ let prev = null
for (const [name, p] of Object.entries(fakes)) $('lab-presence').appendChild(btn(name, () => { pet.applyIntent(presenceToPet(p, prev)); prev = p }))
$('lab-drag').addEventListener('click', () => { pet.beginDrag(); setTimeout(() => pet.endDrag(), 1000) })

const paint = () => { $('lab-state').textContent = JSON.stringify(pet.machine.snapshot(), null, 1); $('lab-warn').textContent = pet.warnings.length ? pet.warnings.join('\n') : '(无)' }
pet.machine.subscribe(paint); paint(); setInterval(paint, 1000)

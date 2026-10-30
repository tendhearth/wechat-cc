// Stage production companion UI with network/storage boundaries replaced only here.
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const qa = join(desktop, 'art/cc-v1/native-motion-qa')

export function prepareMotionNativeQA({ source = join(desktop, 'src'), destination = join(qa, 'dist') } = {}) {
  const input = resolve(source), output = resolve(destination)
  if (input === output || input.startsWith(output + sep)) throw Error('QA output must not contain production input')
  const kit = join(input, 'assets/pet/cc-v1')
  const manifestText = readFileSync(join(kit, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''))
  const registered = new Set(Object.keys(manifest.assets).map(path => resolve(kit, path)))
  const companion = readFileSync(join(input, 'companion-window.js'), 'utf8')
  const storageAnchor = 'storage = window.localStorage'
  if (companion.split(storageAnchor).length !== 2) throw Error('Companion storage boundary changed; update isolated QA staging')
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  cpSync(input, output, { recursive: true, filter: path => {
    if (['CC_MASTER_V1.png', 'CC_DESIGN_SHEET_V1.png'].includes(basename(path))) return false
    if (statSync(path).isDirectory()) return true
    if (/\.test\.[^.]+$/.test(path) || path.endsWith('.ts')) return false
    if (path.startsWith(kit + sep) && !['manifest.json', 'placeholder.js'].includes(basename(path))) return registered.has(resolve(path))
    return true
  } })
  for (const [from, to] of [['index.html', 'index.html'], ['native-qa.js', 'native-qa.js'], ['native-qa.css', 'native-qa.css'], ['qa-bridge.mjs', 'qa-bridge.mjs']]) cpSync(join(qa, from), join(output, to))
  writeFileSync(join(output, 'companion-window.js'), `import { captureQAObservation } from './qa-bridge.mjs'\n` + companion.replace(storageAnchor, 'storage = null /* QA: memory-only motion preferences */') + `
// QA-only refresh: a live fact change must not pretend the document resumed.
const reportQAState = (snapshot = pet.machine.snapshot()) => window.__TAURI__.event.emit('cc-motion-qa-observation', captureQAObservation(snapshot, preferences.snapshot().quiet, document.getElementById('pet-quiet')))
pet.machine.subscribe(reportQAState)
const qaQuietControl = document.getElementById('pet-quiet')
if (qaQuietControl) new MutationObserver(() => reportQAState()).observe(qaQuietControl, { attributes: true, attributeFilter: ['aria-pressed'] })
document.addEventListener('cc-motion-qa-refresh', () => {
  if (!document.hidden) Promise.all([poller.refresh(), petPoller.refresh()]).then(() => reportQAState())
})
window.__ccMotionQAReady = true
`)
  writeFileSync(join(output, 'api.js'), `import { createQAApi, createQAClock } from './qa-bridge.mjs'
const qaClock = createQAClock(Date.now)
Date.now = qaClock.now
export const qaApi = createQAApi()
export const invokeApi = qaApi.invokeApi
window.__TAURI__.event.listen('cc-motion-qa-wall-jump', ({payload}) => {
  qaApi.setScenario('completed')
  qaClock.setOffset(payload)
  document.dispatchEvent(new Event('cc-motion-qa-refresh'))
})
window.__TAURI__.event.listen('cc-motion-qa-scenario', ({payload}) => {
  qaApi.setScenario(payload)
  document.dispatchEvent(new Event('cc-motion-qa-refresh'))
})
`)
  writeFileSync(join(output, 'ipc.js'), `import { createQAInvoke } from './qa-bridge.mjs'
import { qaApi } from './api.js'
window.__ccMotionQACalls = []
let sequence = 0
export const invoke = createQAInvoke((command,args) => window.__TAURI__.core.invoke(command,args), () => qaApi.setScenario('idle'), receipt => {
  window.__ccMotionQACalls.push({ sequence: ++sequence, ...receipt })
  if (window.__ccMotionQACalls.length > 128) window.__ccMotionQACalls.shift()
})
`)
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(prepareMotionNativeQA())

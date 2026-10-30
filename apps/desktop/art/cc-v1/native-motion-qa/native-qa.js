import { createPet } from './pet/pet.js'
const $ = id => document.getElementById(id)
const tauri = window.__TAURI__
const invoke = tauri.core.invoke
const observations = []
const readWindow = async () => {
  const native = await tauri.window.Window.getByLabel('companion')
  const dataDirectory = await tauri.path.appDataDir()
  if (!native) return { open: false, dataDirectory }
  const [size, position, scale, visible, minimized] = await Promise.all([native.innerSize(), native.outerPosition(), native.scaleFactor(), native.isVisible(), native.isMinimized()])
  return { open: true, size: { width: size.width / scale, height: size.height / scale }, position, scale, visible, minimized, dataDirectory }
}
const snapshot = async message => {
  const behaviors = observations.map(item => item.behavior)
  const doneEntries = behaviors.filter((behavior, index) => behavior === 'done' && behaviors[index - 1] !== 'done').length
  // Keep actual notified behavior and applied controls visible before long geometry/history.
  $('native-state').textContent = JSON.stringify({ message, doneEntries, latest: observations.at(-1) ?? null,
    behaviorTrace: behaviors.join(' > '), ...await readWindow(), observations }, null, 2)
}
for (const [id, command, args] of [
  ['open','open_companion_window',{}], ['zoom-in','resize_companion_window',{direction:'in'}],
  ['zoom-out','resize_companion_window',{direction:'out'}], ['reset','reset_companion_position',{}], ['close','close_companion_window',{}],
]) $(id).onclick = async () => {
  try { $(id).disabled = true; await invoke(command,args); await snapshot(command+' returned') }
  catch (error) { $('native-state').textContent = String(error) }
  finally { $(id).disabled = false }
}
$('snapshot').onclick = () => snapshot('manual snapshot')
$('scenario').onchange = () => tauri.event.emit('cc-motion-qa-scenario',$('scenario').value)
await tauri.event.listen('cc-motion-qa-observation', ({payload}) => {
  observations.push(payload); if (observations.length > 32) observations.shift()
  snapshot('测试浮窗的真实状态回执')
})
$('advance-quiet').onclick = async () => {
  const quietOn = [...observations].reverse().find(item => item.quiet && item.quietPressed === 'true' && item.quietAction === '恢复动作')
  observations.length = 0
  if (quietOn) observations.push({ checkpoint: 'before wall jump', ...quietOn })
  await tauri.event.emit('cc-motion-qa-wall-jump', 2 * 60 * 60_000)
  await snapshot('仅模拟测试浮窗经过两小时，系统时间不变')
}
await tauri.event.listen('wechat-cc:navigate', () => snapshot('Find CC returned to isolated main window'))
await invoke('take_pending_navigate',{}).catch(()=>null)
const pets = []
const manifest = await (await fetch('./assets/pet/cc-v1/manifest.json')).json()
$('asset-state').textContent = `包状态 ${manifest.artStatus} · 与当前分支相同素材 · 不代表实时任务`
for (const behavior of Object.keys(manifest.forms.lit.states)) {
  const option = document.createElement('option'); option.value=behavior; option.textContent=behavior; $('behavior').append(option)
}
for (const stage of document.querySelectorAll('.pet-stage')) {
  pets.push(await createPet({stage,img:stage.querySelector('img'),props:stage.querySelector('.pet-props')},{
    manifestUrl:'./assets/pet/cc-v1/manifest.json',reducedMotion:false,
    schedule:(fn,ms)=>ms>=6000?null:setTimeout(fn,ms),cancel:clearTimeout,
  }))
}
pets[0].setForm('lit'); pets[0].machine.notifyAnimationEnded()
const replay = () => pets.forEach(pet => {
  pet.endDrag(); pet.setState('idle'); pet.machine.notifyAnimationEnded()
  if ($('behavior').value==='drag') pet.beginDrag(); else pet.setState($('behavior').value)
})
$('behavior').onchange=replay; $('replay').onclick=replay
$('size').onchange=()=>document.documentElement.style.setProperty('--qa-size',$('size').value+'px')
$('backdrop').onchange=()=>$('pair').dataset.backdrop=$('backdrop').value
$('reduce').onchange=()=>pets.forEach(pet=>pet.setReducedMotion($('reduce').checked))
window.addEventListener('pagehide',()=>pets.forEach(pet=>pet.destroy()))
await snapshot('native QA ready')

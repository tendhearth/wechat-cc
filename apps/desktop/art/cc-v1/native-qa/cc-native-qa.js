// Isolated native art QA: no daemon, presence, sidecar or user-state access.
import { createPet } from './pet/pet.js'
const qa = document.querySelector('#qa')
const params = new URLSearchParams(location.search)
const size = Number(params.get('size'))
const events = window.__TAURI__.event
if (!size) {
  document.body.classList.add('board')
  qa.innerHTML = '<h1>CC · 原生透明窗口验收</h1><p>48 / 96 / 128 / 256 CSS px · 每组 Light / Dark · 四个独立透明窗口</p><div class="controls"><button id="light">浅色底板</button><button id="dark">深色底板</button><button id="clear">透明</button><button id="idle">正身</button><button id="blink">眨眼</button><button id="sleep">睡觉</button><button id="loop">循环验收</button></div><div class="controls"><button data-focus="48">查看 48</button><button data-focus="96">查看 96</button><button data-focus="128">查看 128</button><button data-focus="256">查看 256</button></div><div id="results">等待四个透明窗口加载…</div><p id="status">静态正身 · 自动小动作与呼吸关闭，手动／循环播放保留</p>'
  const results = new Map()
  await events.listen('cc-qa-result', ({payload}) => {
    results.set(payload.size,payload)
    document.querySelector('#results').textContent = [...results].sort((a,b)=>a[0]-b[0]).map(([n,r])=>`${n}px · ${r.dimensions} · PNG ${r.frames} · 加载错误 ${r.errors} · ${r.state}`).join('\n')
  })
  for (const bg of ['light','dark','clear']) document.querySelector('#'+bg).onclick = () => {
    document.body.classList.toggle('dark',bg==='dark')
    events.emit('cc-qa-backdrop',bg)
  }
  for (const button of document.querySelectorAll('[data-focus]')) button.onclick = () => events.emit('cc-qa-focus',Number(button.dataset.focus))
  let timer = null
  const stop = () => { clearInterval(timer); timer = null; document.querySelector('#loop').textContent='循环验收' }
  for (const action of ['idle','blink','sleep']) document.querySelector('#'+action).onclick = () => { stop(); events.emit('cc-qa-action',action); document.querySelector('#status').textContent=action }
  document.querySelector('#loop').onclick = () => {
    if (timer) { stop(); events.emit('cc-qa-action','idle'); return }
    const sequence=['idle','blink','sleep','idle','dark','light','blink','idle']
    let i=0
    const tick=()=>{ const action=sequence[i++%sequence.length]; events.emit('cc-qa-action',action); document.querySelector('#status').textContent=`循环 ${Math.floor((i-1)/sequence.length)+1} · ${action}` }
    tick(); timer=setInterval(tick,1800); document.querySelector('#loop').textContent='停止循环'
  }
} else {
  qa.innerHTML='<section class="pair"><div class="pet-stage"><img class="pet-sprite" alt="Light CC"><div class="pet-props"></div></div><div class="pet-stage"><img class="pet-sprite" alt="Dark CC"><div class="pet-props"></div></div><div class="size-label"></div></section>'
  qa.style.setProperty('--size',`${size}px`)
  document.querySelector('.size-label').textContent=`${size}px · L / D`
  const pets=[], frames=new Set(); let errors=0
  const nativeWindow=window.__TAURI__.window.getCurrentWindow()
  await events.listen('cc-qa-backdrop',async ({payload:bg})=>{
    // Capture-friendly QA backdrop only; transparent mode restores the real window.
    document.body.style.backgroundColor=bg==='clear'?'transparent':bg==='dark'?'#20242b':'#fff'
  })
  await events.listen('cc-qa-focus',({payload:n})=>{ if(n===size) nativeWindow.setFocus() })
  for (const stage of document.querySelectorAll('.pet-stage')) {
    const img=stage.querySelector('img')
    img.addEventListener('load',()=>frames.add(img.currentSrc))
    img.addEventListener('error',()=>errors++)
    pets.push(await createPet({stage,img,props:stage.querySelector('.pet-props')},{manifestUrl:'./assets/pet/cc-v1/manifest.json',reducedMotion:false,
      // Suppress long random idle-move timers for repeatable captures; retain
      // real 125ms frame playback and one-shot/transition completion timers.
      schedule:(fn,ms)=>ms>=6000?null:setTimeout(fn,ms),cancel:clearTimeout}))
  }
  pets[0].setForm('lit')
  await events.listen('cc-qa-action', ({payload:action})=>{
    if (action==='idle') { pets.forEach(p=>p.setState('idle')); pets[0].setForm('lit'); pets[1].setForm('unlit') }
    else if (action==='dark'||action==='light') { pets.forEach(p=>{p.setState('idle');p.setForm(action==='dark'?'unlit':'lit')}) }
    else pets.forEach(p=>p.setState(action))
  })
  setInterval(()=>{
    const rect=document.querySelector('.pet-sprite').getBoundingClientRect()
    events.emit('cc-qa-result',{size,dimensions:`${rect.width}×${rect.height}`,frames:frames.size,errors,state:pets.map(p=>`${p.machine.snapshot().form}/${p.machine.snapshot().behavior}`).join(' + ')})
  },1000)
}

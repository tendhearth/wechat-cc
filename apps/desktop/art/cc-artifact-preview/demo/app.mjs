import {ready} from './lib/message.mjs'
document.querySelector('#note').textContent=ready
let n=0
document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent='浇水 · '+(++n)

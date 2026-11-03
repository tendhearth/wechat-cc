// Coordinated acting on the frozen CC model. Values are model-space, never pixels.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sole = () => ({ lift:0, stride:0, roll:0 })
const frame = ({pose={},eyeScale=1,crescent=0,gaze=0,lean=0,squash=1,rise=0,shift=0,left={},right={}}={}) => ({
  pose,eyeScale,crescent,gaze,body:{lean,squash,rise,shift},
  feet:{left:{...sole(),...left},right:{...sole(),...right}},
})
const hop = (rise, rest={}) => frame({...rest,rise,left:{lift:rise},right:{lift:rise}})
const carried = (lean=0, phase=1) => frame({pose:{excited:.3},eyeScale:1.1,squash:1.025,rise:.08,lean,
  left:{lift:.12,stride:.015*phase,roll:.12*phase},right:{lift:.13,stride:-.015*phase,roll:-.1*phase}})

const clips = [
  {id:'peek',title:'先看一眼，再探身',fps:12,count:14,loop:false,knots:[
    [0,frame()],[.15,frame({gaze:.07})],[.34,frame({gaze:.07,lean:.04,shift:.025,pose:{confused:.18}})],
    [.54,frame({gaze:-.05,lean:.02,shift:.01})],[.75,frame({gaze:-.05,lean:-.025,shift:-.02})],[1,frame()],
  ]},
  {id:'stretch',title:'压低，再伸个懒腰',fps:12,count:14,loop:false,knots:[
    [0,frame()],[.2,frame({squash:.93,eyeScale:.6,pose:{low:.12}})],
    [.5,frame({squash:1.06,eyeScale:.85,pose:{happy:.45}})],
    [.76,frame({squash:.98,pose:{happy:.15}})],[1,frame()],
  ]},
  {id:'walk',title:'交替抬脚的小步',fps:10,count:12,loop:true,knots:[
    [0,frame()],[.25,frame({lean:.025,shift:.035,squash:1.01,pose:{listening:.12},left:{lift:.1,stride:.1,roll:.12}})],
    [.5,frame()],[.75,frame({lean:-.025,shift:-.035,squash:1.01,pose:{listening:.12},right:{lift:.1,stride:-.1,roll:-.12}})],[1,frame()],
  ]},
  {id:'lift',title:'悬起后双脚轻垂',fps:12,count:12,loop:true,knots:[
    [0,carried(-.012)],[.5,carried(.012,-1)],[1,carried(-.012)],
  ]},
  {id:'land',title:'落地，回弹，站稳',fps:16,count:8,loop:false,knots:[
    [0,hop(.08,{squash:1.025,pose:{excited:.2},eyeScale:1.05})],
    [.3,frame({squash:.89,eyeScale:.6,pose:{low:.16}})],
    [.58,hop(.024,{squash:1.025})],[.82,frame({squash:.985})],[1,frame()],
  ]},
  {id:'celebrate',title:'做好后轻轻一跃',fps:16,count:12,loop:false,knots:[
    [0,frame()],[.13,frame({squash:.9,eyeScale:.75,pose:{happy:.12}})],
    [.42,hop(.12,{squash:1.035,pose:{happy:.65},crescent:1,lean:-.025})],
    [.64,frame({squash:.92,pose:{happy:.5},crescent:.85})],
    [.82,hop(.025,{pose:{happy:.2},crescent:.3})],[1,frame()],
  ]},
  {id:'work',title:'专注，轻换重心',fps:8,count:12,loop:true,knots:[
    [0,frame({pose:{listening:.9}})],[.28,frame({pose:{listening:1},lean:-.018,shift:-.015,gaze:.02})],
    [.5,frame({pose:{listening:.95},eyeScale:.12,squash:.995})],
    [.68,frame({pose:{listening:.92},lean:.012,shift:.012})],[1,frame({pose:{listening:.9}})],
  ]},
]

const interpolate = (a,b,t) => {
  if(typeof a==='number'||typeof b==='number') return Math.round(((a??0)+((b??0)-(a??0))*t)*1e6)/1e6
  return Object.fromEntries([...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].map(key=>[key,interpolate(a?.[key],b?.[key],t)]))
}

export function samplePerformance(id,time) {
  const clip=clips.find(c=>c.id===id)
  if(!clip) throw Error(`Unknown CC performance: ${id}`)
  if(!Number.isFinite(time)) throw Error('CC performance time must be finite')
  const t=Math.max(0,Math.min(1,time)), right=clip.knots.findIndex(([at])=>at>=t)
  const [end,b]=clip.knots[right]
  if(right===0||t===end) return structuredClone(b)
  const [start,a]=clip.knots[right-1], u=(t-start)/(end-start)
  const result=interpolate(a,b,u*u*(3-2*u))
  result.pose=Object.fromEntries(Object.entries(result.pose).filter(([,value])=>value!==0))
  return result
}

export function buildPerformancePlan() {
  return {schemaVersion:2,artStatus:'production-candidate',forms:['lit','unlit'],
    source:'apps/desktop/art/cc-v1/cc-v1.blend',
    canvas:{width:512,height:512,anchor:[.5,.91796875],safeBboxPx:[80,28,432,470]},
    clips:clips.map(({id,title,fps,count,loop})=>({id,title,fps,loop,
      frames:Array.from({length:count},(_,i)=>samplePerformance(id,i/(count-1))),
    })),
  }
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]) throw Error('Usage: node cc-performance-recipes.mjs OUTPUT.json')
  writeFileSync(process.argv[2],JSON.stringify(buildPerformancePlan(),null,2)+'\n')
}

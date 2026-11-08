// Coordinated acting on the frozen CC model. Values are model-space, never pixels.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sole = () => ({ lift:0, stride:0, roll:0 })
const frame = ({pose={},eyeScale=1,crescent=0,gaze=0,gazeUp=0,crestTilt=0,lean=0,squash=1,rise=0,shift=0,left={},right={}}={}) => ({
  pose,eyeScale,crescent,gaze,gazeUp,crestTilt,body:{lean,squash,rise,shift},
  feet:{left:{...sole(),...left},right:{...sole(),...right}},
})
const hop = (rise, rest={}) => frame({...rest,rise,left:{lift:rise},right:{lift:rise}})
const carried = (lean=0, phase=1) => frame({pose:{happy:.12},eyeScale:1.08,gazeUp:-.035,squash:1.015,rise:.18,lean,
  left:{lift:.06+.005*phase,stride:.02*phase,roll:.11*phase},right:{lift:.11-.005*phase,stride:-.02*phase,roll:-.1*phase}})
const peek = sign => [
  [0,frame()],[.1,frame({gaze:.07*sign})],[.2,frame({gaze:.07*sign})],
  [.4,frame({gaze:.07*sign,lean:.055*sign,shift:.045*sign,pose:{confused:.28}})],
  [.58,frame({gaze:.07*sign,lean:.055*sign,shift:.045*sign,pose:{confused:.28}})],
  [.72,frame({lean:.035*sign,shift:.03*sign,pose:{confused:.18}})],
  [.86,frame({lean:.02*sign,shift:.015*sign,pose:{confused:.07}})],[.96,frame()],[1,frame()],
]

const clips = [
  {id:'peek',title:'发现右边，停一拍再探身',fps:12,count:14,loop:false,knots:peek(1)},
  {id:'stretch',title:'压低，再伸个懒腰',fps:12,count:14,loop:false,knots:[
    [0,frame()],[.1,frame({eyeScale:.16})],[.25,frame({squash:.93,eyeScale:.16,pose:{low:.2}})],
    [.44,frame({squash:1.06,eyeScale:.16,pose:{happy:.12}})],
    [.64,frame({squash:1.06,eyeScale:.16,pose:{happy:.45}})],
    [.78,frame({pose:{happy:.32}})],[.94,frame({pose:{happy:.1}})],[1,frame()],
  ]},
  {id:'walk',title:'交替抬脚的小步',fps:10,count:12,loop:true,knots:[
    [0,frame()],[.1,frame({lean:.035,shift:.045,pose:{listening:.12}})],
    [.24,frame({lean:.035,shift:.045,squash:1.01,pose:{listening:.12},left:{lift:.105,stride:-.12,roll:-.14}})],
    [.36,frame({lean:.035,shift:.045,squash:1.01,pose:{listening:.12},left:{lift:.105,stride:-.12,roll:-.14}})],
    [.48,frame()],[.55,frame({lean:-.03,shift:-.04,pose:{listening:.12}})],
    [.72,frame({lean:-.035,shift:-.045,squash:1.01,pose:{listening:.12},right:{lift:.105,stride:.12,roll:.14}})],
    [.84,frame({lean:-.035,shift:-.045,squash:1.01,pose:{listening:.12},right:{lift:.105,stride:.12,roll:.14}})],[1,frame()],
  ]},
  {id:'lift',title:'悬起后双脚轻垂',fps:12,count:12,loop:true,knots:[
    [0,carried(-.012)],[.5,carried(.012,-1)],[1,carried(-.012)],
  ]},
  {id:'land',title:'落地，回弹，站稳',fps:16,count:8,loop:false,knots:[
    [0,hop(.08,{squash:1.025,pose:{excited:.2},eyeScale:1.05})],
    [.24,frame({squash:.89,eyeScale:.6,pose:{low:.25}})],
    [.44,hop(.024,{squash:1.025,pose:{low:.12}})],[.62,frame({squash:.985,pose:{happy:.25}})],
    [.76,frame({pose:{happy:.28}})],[.9,frame({pose:{happy:.12}})],[1,frame()],
  ]},
  {id:'celebrate',title:'做好后轻轻一跃',fps:16,count:12,loop:false,knots:[
    [0,frame()],[.12,frame({squash:.9,eyeScale:.75,pose:{low:.12}})],
    [.4,hop(.12,{squash:1.035,pose:{happy:.2},crescent:.9,lean:-.025})],
    [.59,frame({squash:.91,pose:{happy:.55},crescent:1})],
    [.72,hop(.018,{pose:{happy:.65},crescent:.8})],
    [.8,frame({pose:{happy:.45},crescent:.7})],[.9,frame({pose:{happy:.2},crescent:.3})],[1,frame()],
  ]},
  {id:'work',title:'专注，轻换重心',fps:8,count:12,loop:true,knots:[
    [0,frame({pose:{listening:.9},gaze:.03,gazeUp:-.03})],
    [.28,frame({pose:{listening:1},eyeScale:.9,lean:-.015,shift:-.01,gaze:.03,gazeUp:-.03})],
    [.5,frame({pose:{listening:.95},eyeScale:.12,squash:.995,gaze:.03,gazeUp:-.03})],
    [.68,frame({pose:{listening:.92},eyeScale:.95,lean:.01,shift:.01,gaze:.03,gazeUp:-.03})],
    [1,frame({pose:{listening:.9},gaze:.03,gazeUp:-.03})],
  ]},
  {id:'peek-left',title:'发现左边，停一拍再探身',fps:12,count:14,loop:false,knots:peek(-1)},
  {id:'curiosity',title:'自己的 C，好像悄悄动了一下',fps:12,count:36,loop:false,knots:[
    [0,frame()],[2/35,frame()],
    [5/35,frame({pose:{happy:.65},crestTilt:.8})],
    [6/35,frame({pose:{happy:.65},crestTilt:.8})],
    [7/35,frame({gaze:.07,gazeUp:.14,pose:{happy:.65},crestTilt:.8,eyeScale:1.08})],
    [10/35,frame({gaze:.07,gazeUp:.14,pose:{happy:.65},crestTilt:.8,eyeScale:1.08})],
    [11/35,hop(.11,{gaze:.07,gazeUp:.14,pose:{happy:.65},crestTilt:.8,eyeScale:1.15,lean:-.035,squash:1.035})],
    [13/35,hop(.11,{gaze:.07,gazeUp:.14,pose:{happy:.65},crestTilt:.8,eyeScale:1.15,lean:-.035,squash:1.035})],
    [14/35,frame({gaze:.07,gazeUp:.14,pose:{happy:.65},crestTilt:.8,eyeScale:1.15,lean:-.06,shift:-.04,squash:.92})],
    [19/35,frame({gaze:.07,gazeUp:.14,pose:{happy:.65},crestTilt:.8,eyeScale:1.15,lean:-.06,shift:-.04,squash:.92})],
    [21/35,frame({gaze:.07,gazeUp:.14,pose:{happy:.4},crestTilt:-.28,eyeScale:1.15,lean:-.06,shift:-.04,squash:.92})],
    [23/35,frame({gaze:-.07,gazeUp:.14,pose:{happy:.4},crestTilt:-.28,eyeScale:1.1,lean:-.03,shift:-.01,squash:.985})],
    [25/35,frame({gaze:-.04,gazeUp:.14,eyeScale:1.08})],
    [27/35,frame({gaze:-.04,gazeUp:.14,eyeScale:1.08})],
    [29/35,frame()],[30/35,frame({eyeScale:.12})],[32/35,frame()],[1,frame()],
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
  return {schemaVersion:4,artStatus:'production-candidate',forms:['lit','unlit'],
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

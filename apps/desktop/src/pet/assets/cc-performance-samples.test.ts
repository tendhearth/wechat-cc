import {expect,it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'

const desktop=resolve(__dirname,'../../..')
const folder=join(desktop,'art/cc-v1/performance/samples')
const bytes=(name:string)=>readFileSync(join(folder,name))
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex')

it('ships nine exact paired previews with real WebP frame counts, loop policy and catalog timing',()=>{
  const pinned=JSON.parse(bytes('catalog.json').toString())
  const current=JSON.parse(readFileSync(join(desktop,'art/cc-v1/performance/catalog.json'),'utf8'))
  const summary=JSON.parse(bytes('summary.json').toString())
  expect(pinned.clips).toHaveLength(9)
  expect(pinned.clips).toEqual(current.clips)
  expect(pinned.source).toEqual(current.source)
  expect(summary.catalogSha256).toBe(digest(bytes('catalog.json')))
  expect(summary.sourceSha256).toBe(pinned.source.sha256)
  expect(summary.displaySize).toBe(128)
  expect(summary.clips.map((clip:any)=>clip.id)).toEqual(pinned.clips.map((clip:any)=>clip.id))
  let samples=0
  for(const [i,clip] of pinned.clips.entries()){
    const exported=summary.clips[i],image=bytes(`${clip.id}.webp`)
    expect(digest(image)).toBe(exported.webpSha256)
    expect(image.toString('ascii',0,4)).toBe('RIFF')
    expect(image.toString('ascii',8,12)).toBe('WEBP')
    expect(image.readUInt32LE(4)+8).toBe(image.length)
    const delays:number[]=[];let loops:number|undefined
    for(let offset=12;offset+8<=image.length;){
      const type=image.toString('ascii',offset,offset+4),size=image.readUInt32LE(offset+4)
      const payload=image.subarray(offset+8,offset+8+size)
      if(type==='ANMF')delays.push(payload.readUIntLE(12,3))
      if(type==='ANIM')loops=payload.readUInt16LE(4)
      offset+=8+size+(size%2)
    }
    expect(delays).toHaveLength(clip.frames.lit.length)
    expect(delays).toEqual(exported.webpDelaysMs)
    expect(loops).toBe(clip.loop?0:1)
    let elapsed=0
    for(const [frame,delay] of delays.entries()){
      expect(delay).toBeGreaterThan(0);elapsed+=delay
      expect(Math.abs(elapsed-(frame+1)*1000/clip.fps)).toBeLessThanOrEqual(.5)
    }
    expect(exported.frameCount).toBe(delays.length)
    expect(exported.webpDurationMs).toBe(elapsed)
    expect(exported.fps).toBe(clip.fps);expect(exported.loop).toBe(clip.loop)
    expect(bytes(`${clip.id}-poster.png`).subarray(1,4).toString()).toBe('PNG')
    samples+=delays.length
  }
  expect(samples).toBe(134)
})

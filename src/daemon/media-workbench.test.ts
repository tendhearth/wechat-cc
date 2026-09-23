import {afterEach,describe,expect,it,vi} from 'vitest'
import {createDecipheriv} from 'node:crypto'
import {buildMediaItemFromArtifact,WORKBENCH_ARTIFACT_MAX_BYTES} from './media'

const realFetch=globalThis.fetch
afterEach(()=>{globalThis.fetch=realFetch;vi.useRealTimers()})

function server(){
  const calls:{url:string;init:RequestInit}[]=[]
  globalThis.fetch=vi.fn(async(url,init)=>{
    calls.push({url:String(url),init:init!})
    if(String(url).includes('getuploadurl'))return new Response(JSON.stringify({upload_full_url:'https://cdn.invalid/upload'}))
    return new Response('',{headers:{'x-encrypted-param':'download-q'}})
  }) as unknown as typeof fetch
  return calls
}

describe('buildMediaItemFromArtifact',()=>{
  it.each([
    ['photo.png','image/png',2,'image_item'],
    ['clip.mp4','video/mp4',5,'video_item'],
    ['report.pdf','application/pdf',4,'file_item'],
  ] as const)('uploads verified bytes once and builds strict %s media',async(name,mime,type,family)=>{
    const calls=server(),bytes=Buffer.from('artifact bytes')
    const item=await buildMediaItemFromArtifact({bytes,name:`nested/${name}`,mime,toUserId:'owner',baseUrl:'https://api.invalid',token:'token'})
    expect(item.type).toBe(type);expect(item).toHaveProperty(family)
    const request=JSON.parse(String(calls[0]!.init.body)),key=Buffer.from(request.aeskey,'hex')
    const encrypted=Buffer.from(calls[1]!.init.body as Uint8Array),decipher=createDecipheriv('aes-128-ecb',key,null)
    expect(Buffer.concat([decipher.update(encrypted),decipher.final()])).toEqual(bytes)
    if(item.type===4)expect(item.file_item).toMatchObject({file_name:name,len:String(bytes.length)})
    expect(calls).toHaveLength(2)
  })

  it('rejects content above 8 MiB before network',async()=>{
    server();await expect(buildMediaItemFromArtifact({bytes:new Uint8Array(WORKBENCH_ARTIFACT_MAX_BYTES+1),name:'x.bin',mime:'application/octet-stream',toUserId:'owner',baseUrl:'https://api.invalid',token:'token'})).rejects.toThrow('artifact_too_large')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('allows the exact 8 MiB boundary',async()=>{server();await expect(buildMediaItemFromArtifact({bytes:new Uint8Array(WORKBENCH_ARTIFACT_MAX_BYTES),name:'x.bin',mime:'application/octet-stream',toUserId:'owner',baseUrl:'https://api.invalid',token:'token'})).resolves.toMatchObject({type:4,file_item:{len:String(WORKBENCH_ARTIFACT_MAX_BYTES)}})})

  it('does not start upload when already cancelled',async()=>{server();const ctrl=new AbortController();ctrl.abort();await expect(buildMediaItemFromArtifact({bytes:Buffer.from('x'),name:'x.bin',mime:'application/octet-stream',toUserId:'owner',baseUrl:'https://api.invalid',token:'token',signal:ctrl.signal})).rejects.toMatchObject({name:'AbortError'});expect(globalThis.fetch).not.toHaveBeenCalled()})

  it('logically cancels a late raw upload and ignores its eventual result',async()=>{
    const ctrl=new AbortController();let finish!:(value:Response)=>void,calls=0
    globalThis.fetch=vi.fn(async(url)=>{calls++;if(String(url).includes('getuploadurl'))return new Response(JSON.stringify({upload_full_url:'https://cdn.invalid/upload'}));return new Promise<Response>(resolve=>finish=resolve)}) as unknown as typeof fetch
    const pending=buildMediaItemFromArtifact({bytes:Buffer.from('x'),name:'x.bin',mime:'application/octet-stream',toUserId:'owner',baseUrl:'https://api.invalid',token:'token',signal:ctrl.signal})
    await vi.waitFor(()=>expect(calls).toBe(2));ctrl.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});finish(new Response('',{headers:{'x-encrypted-param':'late'}}));await Promise.resolve();expect(calls).toBe(2)
  })

  it('does not start a new CDN post when getuploadurl resolves after cancellation',async()=>{
    const ctrl=new AbortController();let finish!:(value:Response)=>void;const urls:string[]=[]
    globalThis.fetch=vi.fn(async url=>{urls.push(String(url));return new Promise<Response>(resolve=>finish=resolve)}) as unknown as typeof fetch
    const pending=buildMediaItemFromArtifact({bytes:Buffer.from('x'),name:'x.bin',mime:'application/octet-stream',toUserId:'owner',baseUrl:'https://api.invalid',token:'token',signal:ctrl.signal})
    await vi.waitFor(()=>expect(urls).toHaveLength(1));ctrl.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'})
    finish(new Response(JSON.stringify({upload_full_url:'https://cdn.invalid/upload'})));await new Promise(resolve=>setTimeout(resolve,0))
    expect(urls).toEqual(['https://api.invalid/ilink/bot/getuploadurl'])
  })
})

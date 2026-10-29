import {describe,expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {readOwnerChatFile} from './converse-media.js'
import {renderReadingFile} from './workbench-markdown.js'
import {Window} from 'happy-dom'
const data=Buffer.from('owner file content'),sha256=createHash('sha256').update(data).digest('hex')
const chunk=(offset:number,end:number)=>({name:'note.txt',mime:'text/plain',size:data.length,sha256,offset,nextOffset:end,contentBase64:data.subarray(offset,end).toString('base64')})
describe('persisted conversation attachments',()=>{
 it('reads bounded chunks by stored identity with continuation version and validates final hash',async()=>{
  const paths:string[]=[];const result=await readOwnerChatFile(async(_m,path)=>{paths.push(path);const offset=Number(new URL(path,'http://test').searchParams.get('offset'));return chunk(offset,Math.min(data.length,offset+8))},'saved-id',2)
  expect(Buffer.from(result.bytes)).toEqual(data);expect(paths).toHaveLength(3);expect(paths[1]).toContain('sha256='+sha256);expect(paths[1]).toContain('size='+data.length);expect(paths.every(p=>p.includes('id=saved-id&i=2'))).toBe(true)
 })
 it('rejects changed versions, bad ranges, excessive sizes, corrupted bytes and read failures',async()=>{
  for(const bad of [{...chunk(0,data.length),sha256:'a'.repeat(64)},{...chunk(0,data.length),offset:1},{...chunk(0,data.length),size:21*1024*1024},{...chunk(0,data.length),nextOffset:0}])await expect(readOwnerChatFile(async()=>bad,'id',0)).rejects.toThrow()
  let n=0;await expect(readOwnerChatFile(async()=>++n===1?chunk(0,8):{...chunk(8,data.length),name:'replaced.txt'},'id',0)).rejects.toThrow('file_changed')
  await expect(readOwnerChatFile(async()=>{throw Error('not_found')},'id',0)).rejects.toThrow('not_found')
 })
 it('keeps txt/json/csv exact and renders Markdown with an exact inspectable CRLF source',()=>{
  const win=new Window(),text='\n# literal\r\n {"key":"**value**"}\r\n';const host=win.document.createElement('div')
  for(const [name,mime] of [['raw.txt','text/plain'],['raw.json','application/json'],['raw.csv','text/csv']]){host.innerHTML=renderReadingFile(name!,mime!,text);expect(host.querySelector('h1')).toBeNull();expect(host.querySelector('pre')?.textContent).toBe(text)}
  host.innerHTML=renderReadingFile('note.md','text/markdown',text);expect(host.querySelector('h1')?.textContent).toBe('literal');expect(host.querySelector('details pre')?.textContent).toBe(text)
 })
})

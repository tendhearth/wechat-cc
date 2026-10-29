import {fileChunkResponse} from '../../features/phone/mobile-chat'
import {afterEach,describe,expect,it} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,truncateSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {makeOwnerChatFileReader,ownerChatReadingEvent} from './owner-chat-reading'
import {mattersRoutes} from '../internal-api/routes-matters'
import type {MessageRecord} from '../../lib/messages-store'
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})))
const row=(path:string):MessageRecord=>({id:'out',chatId:'owner',direction:'out',kind:'file',text:'',ts:new Date(1).toISOString(),source:'desktop',extras:JSON.stringify({attachments:[{kind:'file',name:'photo.png',path}],narration:['核对过了']})})
describe('stored owner chat reading',()=>{
 it('retains attachment-only rows, omits paths and never guesses inbound references',()=>{
  const out=ownerChatReadingEvent(row('/private/photo.png'));expect(out.messageId).toBe('out');expect(out.replyExtras?.attachments).toEqual([{kind:'file',name:'photo.png'}]);expect(JSON.stringify(out)).not.toContain('/private')
  expect(ownerChatReadingEvent({...row('/private/x'),direction:'in',text:'hello\n[图片 ×1]'}).replyExtras).toBeUndefined()
 })
 it('reads only owner outgoing records, rejects invalid and missing persisted targets, and reports changed versions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cc-owner-reader-'));dirs.push(dir);const path=join(dir,'photo.png');writeFileSync(path,'first')
  let record=row(path);const read=makeOwnerChatFileReader({readChunk:fileChunkResponse,ownerChatId:()=> 'owner',message:async()=>record});const input={id:'out',i:0,offset:0}
  const first=await read(input);expect(first.status).toBe(200);expect(first.body.contentBase64).toBe(Buffer.from('first').toString('base64'))
  record={...row(path),chatId:'other'};expect((await read(input)).status).toBe(404)
  record={...row(path),direction:'in'};expect((await read(input)).status).toBe(404)
  record=row(path);expect((await read({...input,i:3})).status).toBe(404);expect((await read({...input,id:'../private'})).status).toBe(404)
  expect((await read({...input,sha256:'a'.repeat(64)})).status).toBe(409)
  const link=join(dir,'linked');symlinkSync(path,link);record=row(link);expect((await read(input)).status).toBe(404)
  record=row(join(dir,'missing'));expect((await read(input)).status).toBe(404)
  record=row(path);truncateSync(path,21*1024*1024);expect((await read(input)).status).toBe(413)
 })
 it('rejects query paths, chat identities, duplicates and malformed ranges before touching the reader',async()=>{
  let calls=0;const handler=mattersRoutes({matters:{ownerChatFile:async()=>{calls++;return{status:200,body:{}}}}} as any)['GET /v1/matter/owner-chat/file']!
  for(const query of ['id=x&i=0&path=/etc/passwd','id=x&i=0&chatId=other','id=x&id=y&i=0','id=x&i=-1','id=x&i=0&offset=-1','id=x&i=0&sha256=no','id=x&i=0&size=999999999'])expect((await handler(new URLSearchParams(query),null)).status).toBe(400)
  expect(calls).toBe(0);expect((await handler(new URLSearchParams('id=out&i=0&offset=0'),null)).status).toBe(200)
 })
})


it('incoming reads require actual app-upload identity and a stored reference inside the configured inbox',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cc-incoming-reader-'));dirs.push(dir);const inbox=join(dir,'inbox');mkdirSync(inbox)
 const path=join(inbox,'app-desktop-123-1.png');writeFileSync(path,'upload')
 const good={...row(path),id:'app:desktop:123:in',direction:'in' as const,source:'desktop'};let record=good
 const read=makeOwnerChatFileReader({ownerChatId:()=> 'owner',message:async()=>record,inboxDir:inbox,readChunk:fileChunkResponse}),input={id:good.id,i:0,offset:0}
 expect((await read(input)).status).toBe(200)
 for(const changes of [{id:'forged'},{source:'live'},{chatId:'other'},{extras:row(join(dir,'outside.png')).extras},{extras:undefined}]){record={...good,...changes};expect((await read(input)).status).toBe(404)}
 record={...good,extras:JSON.stringify({attachments:[{kind:'unknown'}, {kind:'file',name:'photo.png',path}],narration:[]})};expect((await read(input)).status).toBe(404)
 record=good;expect(ownerChatReadingEvent(record,inbox).replyExtras?.attachments).toEqual([{kind:'file',name:'photo.png'}])
})

it('a symlinked parent directory on the recorded path still reads; a symlinked final component never does',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cc-owner-parent-link-'));dirs.push(dir);const real=join(dir,'real');mkdirSync(real);writeFileSync(join(real,'photo.png'),'via parent link')
 const alias=join(dir,'alias');symlinkSync(real,alias);symlinkSync(join(real,'photo.png'),join(real,'swapped.png'))
 let record=row(join(alias,'photo.png'));const read=makeOwnerChatFileReader({readChunk:fileChunkResponse,ownerChatId:()=> 'owner',message:async()=>record}),input={id:'out',i:0,offset:0}
 const ok=await read(input);expect(ok.status).toBe(200);expect(ok.body.contentBase64).toBe(Buffer.from('via parent link').toString('base64'))
 record=row(join(alias,'swapped.png'));expect((await read(input)).status).toBe(404)
 const inbox=join(alias,'inbox');mkdirSync(inbox);const up=join(inbox,'app-desktop-9-1.png');writeFileSync(up,'upload')
 record={...row(up),id:'app:desktop:9:in',direction:'in',source:'desktop'}
 const readIn=makeOwnerChatFileReader({readChunk:fileChunkResponse,ownerChatId:()=> 'owner',message:async()=>record,inboxDir:inbox}),inInput={id:'app:desktop:9:in',i:0,offset:0}
 expect((await readIn(inInput)).status).toBe(200)
 rmSync(up);symlinkSync(join(real,'photo.png'),up);expect((await readIn(inInput)).status).toBe(404)
})

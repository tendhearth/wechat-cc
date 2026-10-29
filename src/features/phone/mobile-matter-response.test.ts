import {expect,it} from 'vitest'
import {mobileMatterDetailResponse} from './mobile-matter-response'

it('budgets the escaped tunnel response envelope as well as the original JSON bytes',async()=>{
  // Inner JSON fits 300 KiB, but a second JSON string plus encryption base64
  // would exceed a 512 KiB relay frame. Never return partial decision content.
  const response=mobileMatterDetailResponse({events:[{text:'"'.repeat(110_000)}]})
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ok:false,error:'detail_too_large'})
})

it('an owner chat whose reply narration overflows the frame drops narration from the oldest replies first instead of 413-ing',async()=>{
  const narration=Array.from({length:20},(_,i)=>`${i}`.padEnd(4000,'旁'))
  const events=Array.from({length:6},(_,i)=>({kind:'text',text:`回复 ${i}`,createdAt:i+1,messageId:`m${i}`,replyExtras:{attachments:[{kind:'file',name:`f${i}.pdf`}],narration}}))
  const response=mobileMatterDetailResponse({matter:{id:'c0ffee01'},events})
  expect(response.status).toBe(200)
  const body=await response.json() as {ok:boolean,events:Array<{text:string,replyExtras:{attachments:Array<{name:string}>,narration?:string[]}}>}
  expect(body.ok).toBe(true)
  expect(body.events.map(e=>e.text)).toEqual(events.map(e=>e.text))
  expect(body.events.map(e=>e.replyExtras.attachments.map(a=>a.name))).toEqual(events.map((_,i)=>[`f${i}.pdf`]))
  expect(body.events.at(-1)!.replyExtras.narration).toEqual(narration)
  expect(body.events[0]!.replyExtras.narration).toBeUndefined()
  const kept=body.events.map(e=>e.replyExtras.narration!==undefined)
  expect(kept.indexOf(true)).toBeGreaterThan(0)
  expect(kept.slice(kept.indexOf(true)).every(Boolean)).toBe(true)
})

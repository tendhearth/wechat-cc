/** Leave room for the tunnel's JSON envelope and encrypted base64 frame under
 * the relay's 512 KiB ceiling. Decision descriptions are never truncated. */
const MAX_MOBILE_DETAIL_BYTES=300*1024
/** Would this JSON body, once the legacy tunnel wraps it ({rid,status,body}
 * stringified again, then sealed + base64url), risk the 512 KiB relay frame?
 * The 300 KiB framed budget leaves ~400 KiB on the wire after base64. */
export function framedTooLarge(body:string):boolean {
  // The tunnel serializes this JSON body again as a string. Quotes and
  // backslashes can double its size before encryption's base64 expansion.
  const framed=JSON.stringify({rid:'r'.repeat(64),status:200,body})
  return Buffer.byteLength(framed,'utf8')>MAX_MOBILE_DETAIL_BYTES
}
/** Reply narration (up to 20 × 4000 chars per owner-chat row, device tokens only) is the one optional bulk in a detail.
 * When the frame would overflow, drop it from the oldest replies first; text, attachments and decisions stay whole. */
function withoutOldNarration(detail:unknown):string {
  let body=JSON.stringify({ok:true,...detail as object})
  const events=(detail as {events?:unknown}|null)?.events
  if(!framedTooLarge(body)||!Array.isArray(events))return body
  const copy=[...events] as unknown[]
  const narrated=copy.map((e,i)=>({e:e as {createdAt?:unknown,replyExtras?:{narration?:unknown}}|null,i}))
    .filter(({e})=>!!e&&typeof e==='object'&&!!e.replyExtras&&typeof e.replyExtras==='object'&&e.replyExtras.narration!==undefined)
    .sort((a,b)=>(typeof a.e!.createdAt==='number'&&typeof b.e!.createdAt==='number'?a.e!.createdAt-b.e!.createdAt:0)||a.i-b.i)
  for(const {e,i} of narrated){
    const {narration:_dropped,...replyExtras}=e!.replyExtras!
    copy[i]={...e,replyExtras}
    body=JSON.stringify({ok:true,...detail as object,events:copy})
    if(!framedTooLarge(body))break
  }
  return body
}
export function mobileMatterDetailResponse(detail:unknown):Response {
  const body=withoutOldNarration(detail)
  const tooLarge=framedTooLarge(body)
  return new Response(tooLarge?JSON.stringify({ok:false,error:'detail_too_large'}):body,{
    status:tooLarge?413:200,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},
  })
}

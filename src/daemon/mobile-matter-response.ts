/** Leave room for the tunnel's JSON envelope and encrypted base64 frame under
 * the relay's 512 KiB ceiling. Decision descriptions are never truncated. */
const MAX_MOBILE_DETAIL_BYTES=300*1024
export function mobileMatterDetailResponse(detail:unknown):Response {
  const body=JSON.stringify({ok:true,...detail as object})
  // The tunnel serializes this JSON body again as a string. Quotes and
  // backslashes can double its size before encryption's base64 expansion.
  const framed=JSON.stringify({rid:'r'.repeat(64),status:200,body})
  const tooLarge=Buffer.byteLength(framed,'utf8')>MAX_MOBILE_DETAIL_BYTES
  return new Response(tooLarge?JSON.stringify({ok:false,error:'detail_too_large'}):body,{
    status:tooLarge?413:200,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},
  })
}

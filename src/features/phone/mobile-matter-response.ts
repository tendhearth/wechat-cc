import {framedTooLargeFor,withoutOldNarrationFor} from '../../domain/matters/phone-scope'

/** Leave room for the tunnel's JSON envelope and encrypted base64 frame under
 * the relay's 512 KiB ceiling. Decision descriptions are never truncated. */
export const MAX_MOBILE_DETAIL_BYTES=300*1024
/** Would this JSON body, once the legacy tunnel wraps it ({rid,status,body}
 * stringified again, then sealed + base64url), risk the 512 KiB relay frame?
 * The 300 KiB framed budget leaves ~400 KiB on the wire after base64. */
export function framedTooLarge(body:string):boolean {
  return framedTooLargeFor(body,MAX_MOBILE_DETAIL_BYTES)
}
/** Reply narration (up to 20 × 4000 chars per owner-chat row, device tokens only) is the one optional bulk in a detail.
 * When the frame would overflow, drop it from the oldest replies first; text, attachments and decisions stay whole.
 * (P3c-1:裁法搬到 domain/matters/phone-scope.ts,`GET /v1/matter` 按 caller.frameBudget 用同一份。) */
export function mobileMatterDetailResponse(detail:unknown):Response {
  const body=withoutOldNarrationFor(detail,MAX_MOBILE_DETAIL_BYTES,d=>({ok:true,...d}))
  const tooLarge=framedTooLarge(body)
  return new Response(tooLarge?JSON.stringify({ok:false,error:'detail_too_large'}):body,{
    status:tooLarge?413:200,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},
  })
}

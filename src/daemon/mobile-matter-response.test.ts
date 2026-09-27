import {expect,it} from 'vitest'
import {mobileMatterDetailResponse} from './mobile-matter-response'

it('budgets the escaped tunnel response envelope as well as the original JSON bytes',async()=>{
  // Inner JSON fits 300 KiB, but a second JSON string plus encryption base64
  // would exceed a 512 KiB relay frame. Never return partial decision content.
  const response=mobileMatterDetailResponse({events:[{text:'"'.repeat(110_000)}]})
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ok:false,error:'detail_too_large'})
})

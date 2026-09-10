import { expect,it } from 'vitest'
import { ccBox,ccContains,waterContains } from './aquarium-layout.js'
it.each([[96,72],[256,192],[600,300],[300,600]])('preserves square CC pixels and its foot anchor on a %i×%i stage',(w,h)=>{
 const box=ccBox(w,h)
 expect(box.width).toBe(box.height)
 expect(box.y+box.height*470/512).toBeCloseTo(h*.806)
 expect(ccContains(.258,.75,w,h)).toBe(true)
 expect(ccContains(.8,.5,w,h)).toBe(false)
})
it('keeps attention inside the actual water instead of the rim, plants outside glass or character',()=>{
 expect(waterContains(.6,.52)).toBe(true)
 for(const [x,y] of [[.2,.65],[.6,.38],[.86,.52],[.6,.78]])expect(waterContains(x!,y!)).toBe(false)
})

import {it,expect} from 'vitest'
import {composeCcInk} from './cc-ink-compose'
import {safeSvg} from './svg-sanitize'
const scene='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320"><rect width="480" height="320" fill="#fff7e6"/></svg>'
it('composes a fixed dark CC after the scene and passes the SVG gate',()=>{
 const result=composeCcInk(JSON.stringify({form:'dark',pose:'happy',sceneSvg:scene}),'postcard')!
 expect(result).toContain('#343330')
 expect(result).toContain('translate(12 138) scale(0.5)')
 expect(result.indexOf('<rect')).toBeLessThan(result.indexOf('translate('))
 expect(safeSvg(result)).toBe(result)
})
it('rejects unknown selections, scripts, malformed nesting and legacy freeform characters',()=>{
 for(const payload of [scene,JSON.stringify({form:'bear',pose:'happy',sceneSvg:scene}),JSON.stringify({form:'light',pose:'invented',sceneSvg:scene}),JSON.stringify({form:'light',pose:'happy',sceneSvg:scene.replace('<rect','</g><rect')}),JSON.stringify({form:'light',pose:'happy',sceneSvg:scene.replace('</svg>','<script>alert(1)</script></svg>')})]) expect(composeCcInk(payload,'postcard')).toBeNull()
})
it('requires dimensions appropriate to the output and accepts JSON fences',()=>{
 const p=JSON.stringify({form:'light',pose:'company',sceneSvg:scene})
 expect(composeCcInk(p,'sticker')).toBeNull()
 expect(composeCcInk('```json\n'+p+'\n```','postcard')).not.toBeNull()
})

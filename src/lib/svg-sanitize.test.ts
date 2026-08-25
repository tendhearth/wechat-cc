import { describe, expect, it } from 'vitest'
import { safeSvg } from './svg-sanitize'

const OK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
  <circle cx="160" cy="120" r="60" fill="none" stroke="#5a3f2d" stroke-width="4"/>
  <path d="M100 200 q60 40 120 0" stroke="#b0563a" fill="none" stroke-linecap="round"/>
  <g opacity="0.8"><rect x="40" y="40" width="10" height="10" fill="#f5ead8"/></g>
</svg>`

describe('safeSvg', () => {
  it('accepts a plain shape-only SVG', () => {
    expect(safeSvg(OK)).toBe(OK)
  })

  it('rejects script/event/href/style vectors outright (null, not cleaned)', () => {
    expect(safeSvg('<svg><script>alert(1)</script></svg>')).toBeNull()
    expect(safeSvg('<svg onload="alert(1)"><circle r="5"/></svg>')).toBeNull()
    expect(safeSvg('<svg><a href="javascript:x"><circle r="5"/></a></svg>')).toBeNull()
    expect(safeSvg('<svg><image href="http://x/y.png"/></svg>')).toBeNull()
    expect(safeSvg('<svg><use xlink:href="#p"/></svg>')).toBeNull()
    expect(safeSvg('<svg><foreignObject><body/></foreignObject></svg>')).toBeNull()
    expect(safeSvg('<svg><style>*{display:none}</style></svg>')).toBeNull()
    expect(safeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBeNull()
  })

  it('rejects unknown elements and unknown attributes', () => {
    expect(safeSvg('<svg><iframe/></svg>')).toBeNull()
    expect(safeSvg('<svg><circle r="5" data-x="1"/></svg>')).toBeNull()
  })

  it('rejects non-SVG or empty input', () => {
    expect(safeSvg('')).toBeNull()
    expect(safeSvg('hello')).toBeNull()
    expect(safeSvg('<div>hi</div>')).toBeNull()
  })
})

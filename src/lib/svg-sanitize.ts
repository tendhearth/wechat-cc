/**
 * svg-sanitize.ts — strict allowlist gate for LLM-generated SVG
 * (2026-08-25, CC 手绘小像). The portrait SVG is injected into the desktop
 * webview as markup, so a hostile/hallucinated payload is an XSS vector.
 *
 * Posture: REJECT, never clean. Anything outside the allowlist — an unknown
 * element, an unknown attribute, any script/href/style/entity construct —
 * invalidates the whole document (returns null) and the caller falls back
 * to no portrait. Rejecting is trivially safe; "cleaning" is where SVG
 * sanitizers historically go wrong.
 */

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'title', 'desc',
])

const ALLOWED_ATTRS = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'opacity', 'fill-opacity', 'stroke-opacity', 'transform',
])

// Constructs that must not appear anywhere, even inside text/comments —
// cheap belt-and-braces on top of the element/attr allowlists.
const FORBIDDEN = /<!(?:DOCTYPE|ENTITY)|<!\[CDATA\[|<\?|javascript:|\bon[a-z]+\s*=|href|xlink/i

/** Returns the input unchanged when it passes the allowlist, else null. */
export function safeSvg(raw: string): string | null {
  const svg = raw.trim()
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) return null
  if (FORBIDDEN.test(svg)) return null

  // Every tag must be an allowed element.
  for (const m of svg.matchAll(/<\s*\/?\s*([A-Za-z][\w:-]*)/g)) {
    if (!ALLOWED_ELEMENTS.has(m[1]!)) return null
  }
  // Every attribute inside every tag must be allowed. Walk tag bodies only
  // (between < and >) so prose inside <title> can't false-positive.
  for (const tag of svg.matchAll(/<[^>]+>/g)) {
    for (const attr of tag[0].matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"/g)) {
      if (!ALLOWED_ATTRS.has(attr[1]!)) return null
    }
    // Attributes must be double-quoted — an unquoted or single-quoted value
    // would slip past the attribute scan above.
    if (/=\s*[^"\s>]/.test(tag[0]) || /=\s*'/.test(tag[0])) return null
  }
  return svg
}

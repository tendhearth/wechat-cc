import templates from './cc-ink-templates.json'
import {safeSvg} from './svg-sanitize'

type Kind = 'sticker' | 'postcard'

/** Background cannot close the wrapper which isolates its transforms/paint. */
function balanced(svg: string): boolean {
  const stack: string[]=[]
  if (svg.replace(/<[^>]*>/g,'').match(/[<>]/)) return false
  for(const token of svg.match(/<[^>]*>/g) ?? []) {
    const match=token.match(/^<(\/)?([a-z]+)\b[^>]*>$/)
    if(!match) return false
    const name=match[2]!
    if(match[1]) { if(token!==`</${name}>` || stack.pop()!==name) return false }
    else if(!token.endsWith('/>')) stack.push(name)
  }
  return stack.length===0
}

/** Model draws only the surroundings; the character is always an approved template. */
export function composeCcInk(raw: string, kind: Kind): string | null {
  if(raw.length>100_000) return null
  try {
    const p=JSON.parse(raw.trim().replace(/^```json\s*/i,'').replace(/```\s*$/,''))
    if(!p || typeof p!=='object' || !['light','dark'].includes(p.form) || typeof p.pose!=='string' || typeof p.sceneSvg!=='string') return null
    const key=`${p.form}:${p.pose}`
    if(!Object.hasOwn(templates,key)) return null
    const body=templates[key as keyof typeof templates]
    const scene=safeSvg(p.sceneSvg)
    if(!scene || !balanced(scene)) return null
    const width=kind==='postcard'?480:320
    const root=scene.match(/^<svg\b([^>]*)>([\s\S]*)<\/svg>$/)
    if(!root || !new RegExp(`\\bviewBox="0 0 ${width} 320"`).test(root[1]!)) return null
    // No nested viewport: the drawing uses our one fixed coordinate system.
    if(/<\/?svg\b/.test(root[2]!)) return null
    const placement=kind==='postcard'?'translate(12 138) scale(0.5)':'translate(0 0)'
    return safeSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 320"><g>${root[2]}</g><g transform="${placement}">${body}</g></svg>`)
  } catch { return null }
}

export function ccInkOutputInstructions(kind: Kind): string {
 const width=kind==='postcard'?480:320
 return `只输出 JSON,不要解释。结构:{"form":"light 或 dark","pose":"received / happy / thinking / cheering / goodnight / company 之一","sceneSvg":"一个 SVG 字符串"}。\n`+
 `sceneSvg 只画场景和小道具,不要画你自己或任何替代 CC 的吉祥物。程序会叠上固定 CC,不要重画身体、眼睛、脚或 C。\n`+
 `SVG 根元素为 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 320">。属性双引号,在 JSON 字符串中正确转义。\n`+
 `只允许 g/path/circle/ellipse/rect/line/polyline/polygon/title;禁止 text/image/use/script/style/class/id/href/动画和嵌套 svg。\n`+
 (kind==='postcard'?'给左下角 x=45..140,y=160..285 留出安静的落脚处;场景主体放右侧。':'背景透明,装饰只放上方或两侧,中间 x=65..260,y=50..285 留给 CC。')
}

/** A deliberately narrow projection. Never forward persona prose or other memory documents. */
export interface CheckupPersona { name: string; userTitle?: string; selfTitle?: string; habit?: string; tone?: string }
export function extractCheckupPersona(content: string): CheckupPersona {
  const result: CheckupPersona = {name:'CC'}
  const fields: Record<string,keyof CheckupPersona> = {名字:'name',名称:'name',称呼用户:'userTitle',对用户的称呼:'userTitle',自称:'selfTitle',口头禅:'habit',固定口头习惯:'habit',口吻:'tone'}
  let allowed=true,fenced=false
  for(const line of content.split(/\r?\n/)) {
    if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue}
    if(fenced||/^\s*>/.test(line))continue
    const heading=/^\s*#{1,6}\s+(.+?)\s*$/.exec(line)
    if(heading){allowed=/^(人设|身份|角色|称呼|口吻|基本设定|说话方式)$/.test(heading[1]!);continue}
    if(!allowed)continue

    const match=/^\s*(?:[-*]\s*)?(名字|名称|称呼用户|对用户的称呼|自称|口头禅|固定口头习惯|口吻)\s*[:：]\s*[「“"]?([\p{L}\p{N}·]{1,16})[」”"]?\s*$/u.exec(line)
    if(!match){if(line.trim())allowed=false;continue}
    const key=fields[match[1]!]!,value=match[2]!
    if(key==='tone'&&!['温柔','简洁','亲切','活泼','平静','严谨','幽默'].includes(value))continue
    result[key]=value
  }
  return result
}
export function checkupPersonaText(p:CheckupPersona):string {
  return [`名字：${p.name}`,p.userTitle&&`称呼用户：${p.userTitle}`,p.selfTitle&&`自称：${p.selfTitle}`,p.habit&&`固定口头习惯：${p.habit}`,p.tone&&`口吻：${p.tone}`].filter(Boolean).join('\n')
}

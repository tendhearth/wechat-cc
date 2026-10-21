/**
 * 工作区脚本到手机的投影(2026-10-20,PR-C):只给状态 + 端口 + 批没批 + 最后几行输出。
 * 脚本原文只进桌面详情(确认框要逐字给主人看),这里一个字都不带;路径一律剥掉。
 * 输出在落库前已经过 redactSecrets(service/scripts.ts),这里再去颜色码、剥绝对路径、截短。
 */
export const PHONE_SCRIPT_LINES=8
const LINE_MAX=200

export interface PhoneScripts {port?:number;setup?:string;run?:string;approved?:boolean;lastLines?:string[]}
/** 工作台详情里 worktree.scripts 的样子(不 import 工作台类型,免得 matters 反向依赖)。 */
type ScriptsLike={configured?:unknown;approved?:unknown;setup?:unknown;run?:unknown}|null|undefined
type EventLike={activity?:{id?:unknown;output?:unknown}}

const ANSI=/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g
// 绝对路径:行首或空白 / 引号 / 括号 / 等号之后的 /xxx(不碰 http://host/ 里的 //),以及 C:\xxx
const POSIX_PATH=/(^|[\s'"(=\[])(\/[^\s'"()\]]+)/g
const WIN_PATH=/(^|[\s'"(=\[])([A-Za-z]:\\[^\s'"()\]]+)/g
const tailName=(p:string)=>{const parts=p.split(/[\\/]+/).filter(Boolean);return parts.length?`…/${parts[parts.length-1]}`:'…'}

/** 一行给手机看的输出:去颜色码和控制符、已知根目录换成「.」、其余绝对路径只留最后一段。 */
export function phoneLine(line:string,roots:readonly string[]):string {
  let s=line.replace(ANSI,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'')
  for(const root of roots)if(root&&root.length>1)s=s.split(root).join('.')
  s=s.replace(POSIX_PATH,(_m,pre:string,p:string)=>pre+tailName(p)).replace(WIN_PATH,(_m,pre:string,p:string)=>pre+tailName(p))
  return [...s].slice(0,LINE_MAX).join('')
}

/** 最近那条脚本活动(run_id = script-<uuid>)的最后几行;没有 ⇒ undefined。 */
export function scriptTail(events:readonly EventLike[],roots:readonly string[]):string[]|undefined {
  for(let i=events.length-1;i>=0;i--){
    const a=events[i]?.activity
    if(!a||typeof a.id!=='string'||!a.id.startsWith('script-'))continue
    if(typeof a.output!=='string')return undefined
    // \r 刷新的进度条只留最后那一截
    const lines=a.output.split(/\r?\n/).map(l=>l.split('\r').pop()??'').map(l=>phoneLine(l,roots)).filter(l=>l.trim())
    return lines.length?lines.slice(-PHONE_SCRIPT_LINES):undefined
  }
  return undefined
}

/** 配了脚本才有;状态按字符串原样给(手机认不得的当「不确定」)。 */
export function phoneScripts(scripts:ScriptsLike,port:unknown,events:readonly EventLike[],roots:readonly string[]):PhoneScripts {
  const out:PhoneScripts={}
  if(typeof port==='number'&&Number.isInteger(port))out.port=port
  if(!scripts||scripts.configured!==true)return out
  if(typeof scripts.setup==='string')out.setup=scripts.setup
  if(typeof scripts.run==='string')out.run=scripts.run
  out.approved=scripts.approved===true
  const lines=scriptTail(events,roots)
  if(lines)out.lastLines=lines
  return out
}

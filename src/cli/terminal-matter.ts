import {readJsonFile} from '../lib/read-json-file'
import {ledgerBrief} from '../adapters/store/matter-ledger'
import type {MatterNotesPage} from '../ports/matters'
import type {TerminalCredential} from '../features/terminal'

export const TERMINAL_DETACHED='这个终端已经从那件事上摘下来了，或者 CC 重启过；要的话让主人重新挂一次'
/** No discovery, environment token, fallback credential or raw HTTP error output. */
export async function terminalMatter(action:'notes'|'note',path:string,options:{before?:string;text?:string;fetchImpl?:typeof fetch}={}):Promise<string>{
  let cred:TerminalCredential
  try{
    cred=readJsonFile<TerminalCredential>(path)
    const url=new URL(cred.api)
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!cred.token||!cred.participationId||!/^[a-f0-9]{8}$/.test(cred.matterId))throw Error()
  }catch{throw Error(TERMINAL_DETACHED)}
  if(options.before!==undefined&&(!/^\d+$/.test(options.before)||!Number.isSafeInteger(Number(options.before))||Number(options.before)<1))throw Error('翻页游标无效')
  if(action==='note'&&(!options.text?.trim()||options.text.length>1000))throw Error('备注需要 1 到 1000 字')
  const call=async(method:string,route:string,body?:unknown)=>{
    let response:Response
    try{response=await (options.fetchImpl??fetch)(`${cred.api}${route}`,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${cred.token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})}catch{throw Error(TERMINAL_DETACHED)}
    if(response.status===401||response.status===403)throw Error(TERMINAL_DETACHED)
    if(!response.ok)throw Error('记录本操作没成功，请检查文字长度和备注额度后重试')
    return response.json()
  }
  const query=new URLSearchParams({matter:cred.matterId,...(options.before?{before:options.before}:{})})
  // Scope check before writing too: a forged matterId must never redirect a note.
  const page=await call('GET',`/v1/matter/notes?${query}`) as MatterNotesPage
  if(action==='note'){await call('POST','/v1/matter/note',{text:options.text});return '备注已写入'}
  // The server already budgets each page. A second truncation here would lose
  // notes while its cursor advances beyond them. Keep every note on this page.
  return `${ledgerBrief(page.notes,Infinity)||'记录本暂无记录'}\n共 ${page.notesTotal} 条${page.truncated?`；还有记录，向前翻页：--before ${page.nextBefore}`:''}`
}

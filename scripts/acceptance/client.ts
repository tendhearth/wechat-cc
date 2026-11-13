/** Only an explicitly marked temporary daemon is addressable. No production fallback. */
import {readFileSync,existsSync,appendFileSync} from 'node:fs'
import {join} from 'node:path'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit temporary state marker required')
const [method,path,payload]=process.argv.slice(2)
const control=path?.startsWith('/test/')
const info=JSON.parse(readFileSync(join(dir,control?'ready.json':'internal-api-info.json'),'utf8'))
const base=control?info.controlUrl:info.baseUrl
if(new URL(base).hostname!=='127.0.0.1')throw Error('loopback required')
const headers:Record<string,string>={'content-type':'application/json'}
if(!control)headers.authorization='Bearer '+readFileSync(join(dir,process.env.ACCEPTANCE_AUTH==='file'?'internal-token':'internal-operator-token'),'utf8').trim()
const started=performance.now()
const r=await fetch(base+(control?path.replace('/test',''):path),{method:method??'GET',headers,...(payload?{body:payload}:{}),signal:AbortSignal.timeout(660000)})
const raw=await r.text()
let body;try{body=JSON.parse(raw)}catch{body={nonJsonResponse:true,length:raw.length}}
// API tokens should never be returned, but enforce redaction at this boundary too.
const text=JSON.stringify({status:r.status,ms:Math.round(performance.now()-started),body}).replace(/\b[a-f0-9]{64}\b/g,'[HEX64]')
console.log(text)
appendFileSync(join(dir,'api-evidence.jsonl'),JSON.stringify({at:new Date().toISOString(),method,path,result:JSON.parse(text)})+'\n')

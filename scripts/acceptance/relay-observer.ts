/** Opt-in, read-only tracing of the original pure functions. No result substitution. */
import {appendFileSync,readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'

export function installRelayObserver(dir:string){
 if(!dir.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only'))||!existsSync(join(dir,'.relay-acceptance')))throw Error('explicit relay acceptance marker required')
 const output=join(dir,'relay-decisions.jsonl')
 const observe=(kind:string,input:unknown,result:unknown)=>{
  try{appendFileSync(output,JSON.stringify({at:new Date().toISOString(),kind,input,result})+'\n')}
  catch{console.error('RELAY_OBSERVER_FAILURE: acceptance evidence invalid')}
 }
 // Bun's ESM exports are read-only. An opt-in loader adds a call observer around
 // these two pure exports, leaving their bodies and returned values intact.
 // It runs before bootDaemon is imported; no source file is written.
 ;(globalThis as any).__acceptanceRelayObserve=observe
 Bun.plugin({name:'acceptance-relay-observer',setup(build){
  build.onLoad({filter:/[\\/]src[\\/]domain[\\/]relay-decision\.ts$/},args=>{
   let contents=readFileSync(args.path,'utf8')
   for(const name of ['decideRelay','decideResume']){
    const signature='export function '+name+'('
    if(contents.split(signature).length!==2)throw Error('relay observer source shape changed')
    contents=contents.replace(signature,'function original_'+name+'(')
    contents+=`\nexport function ${name}(input: Parameters<typeof original_${name}>[0]): ReturnType<typeof original_${name}> { const result=original_${name}(input); (globalThis as any).__acceptanceRelayObserve('${name}',input,result); return result }\n`
   }
   return {contents,loader:'ts'}
  })
 }})
}

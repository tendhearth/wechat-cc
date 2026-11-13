import { defineCommand } from 'citty'
import { checkupReview } from '@wechat-cc/protocol'
import { STATE_DIR } from '../../lib/config'
export const checkupCmd=defineCommand({
  meta:{name:'checkup',description:'本机 CC 体检，只用编造对话；不上传结果'},
  args:{full:{type:'boolean',description:'完整版（更长的编造日常）'},provider:{type:'string',description:'后端，默认主人对话当前的后端'},model:{type:'string',description:'模型，默认主人对话当前的模型'},estimate:{type:'boolean',description:'只看请求与 token 估计，不发模型请求'},json:{type:'boolean',description:'JSON 结果'}},
  async run({args}) {
    const { readApiInfo }=await import('../../lib/api-info')
    const { runCheckupCli }=await import('../checkup')
    const api=readApiInfo(STATE_DIR)
    if(!api){console.error('体检没开始：家里的电脑后台暂时连不上。');process.exitCode=2;return}
    const abort=new AbortController(),cancel=()=>abort.abort()
    process.once('SIGINT',cancel)
    try {
      const result=await runCheckupCli({
        async request(method,path,body){
          const r=await fetch(`${api.baseUrl}${path}`,{method,headers:{authorization:`Bearer ${api.operatorToken}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10_000)})
          const value=await r.json() as {error?:string}
          if(!r.ok)throw new Error(value.error??'checkup_unavailable')
          return value
        },
        estimate:q=>{if(!args.json)console.error(`${args.full?'完整版':'短版'}：${q.summary}${q.windowKnown?'':'窗口未知，按保守大小估算。'} Ctrl-C 可取消。`)},
        sleep:ms=>new Promise(r=>setTimeout(r,ms)),
      },{full:!!args.full,estimateOnly:!!args.estimate,...typeof args.provider==='string'?{providerId:args.provider}:{},...typeof args.model==='string'?{model:args.model}:{},signal:abort.signal})
      if(args.json)console.log(JSON.stringify(result,null,2))
      else if(result.view){
        const v=result.view,review=v.review??checkupReview(v)
        console.log([review.title,review.status,...review.rows.map(r=>`${r.label}  ${r.detail}  ${r.grade}`),review.care].filter(Boolean).join('\n'))
      }
      if(result.view?.attempt?.status==='failed')process.exitCode=1
      else if(result.view?.attempt?.status==='cancelled')process.exitCode=130
    } catch(e){console.error(`体检没测成：${e instanceof Error?e.message:'unavailable'}`);process.exitCode=abort.signal.aborted?130:1}
    finally{process.removeListener('SIGINT',cancel)}
  },
})

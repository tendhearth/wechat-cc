import {readLegReply,readStatusLine} from './relay-decision'

export type CandidateStatus='queued'|'running'|'waiting'|'completed'|'failed'|'cancelled'|'interrupted'
export interface CandidateResult {
  files:{path:string;added:number|null;removed:number|null}[]|null
  partial?:boolean
  statusLine:string|null
  tests:string[]
}

export const parseParallelChoice=(text:string)=>{
  const match=/^用[ \t]*([^\s][^\r\n]{0,79}?)\s*那版(?:\s+任务\s+([a-f0-9]{8}))?[。.!！]?$/i.exec(text.trim())
  return match?{name:match[1]!.trim(),matterId:match[2]?.toLowerCase()}:null
}

export const candidateTerminal=(status:CandidateStatus)=>!['queued','running','waiting'].includes(status)
export const groupSettled=(members:readonly {status:CandidateStatus}[])=>members.length>=2&&members.every(m=>candidateTerminal(m.status))

export function candidateStatus(status:string,reply:string,question:boolean,stillOpen:boolean):CandidateStatus{
  if(status==='failed'||status==='cancelled'||status==='interrupted')return status
  if(status!=='completed')return 'interrupted'
  if(question)return stillOpen?'waiting':'interrupted'
  const result=readLegReply(reply)
  if(result==='asked')return 'interrupted'
  return result==='done'?'completed':'failed'
}

export function candidateResult(reply:string,files:CandidateResult['files']):CandidateResult{
  const status=readStatusLine(reply)
  const tests=reply.split('\n').map(line=>line.trim().replace(/^[#*\- ]+/, ''))
    .flatMap((line,i,lines)=>{
      if(!/^(实际完成的验证|已完成的验证|完成的验证|验证情况|测试结果|tests?( results?)?|verification( done| performed)?)[*\s]*[：:]/i.test(line))return []
      const value=line.replace(/^[^：:]*[：:]\s*/,'')
      if(value)return [value]
      const section=lines.slice(i+1,i+5)
      const boundary=section.findIndex(line=>!line||/^(状态|未完成的验证|未做的验证|改动|交付|files? changed|unverified)\s*[：:]/i.test(line)||/[：:]\s*$/.test(line))
      return boundary===-1?section:section.slice(0,boundary)
    }).slice(0,4).map(line=>line.slice(0,240))
  return {files,statusLine:status?{done:'状态：做完',asked:'状态：要问主人',blocked:'状态：没做完',empty:null}[status]:null,tests}
}

export const candidateLabels:Record<CandidateStatus,string>={
  queued:'排队',running:'在做',waiting:'等你回答',completed:'做完',failed:'没做成',cancelled:'已停',interrupted:'已停或中断',
}

export function compareCandidates(title:string,position:number,members:readonly {name:string;status:CandidateStatus;taskId:string|null;result:CandidateResult|null}[]):string{
  const lines=members.map(({name,status,taskId,result})=>{
    const files=result?.files
    const counts=files?.every(file=>file.added!==null&&file.removed!==null)
      ? `，+${files.reduce((n,f)=>n+f.added!,0)} / −${files.reduce((n,f)=>n+f.removed!,0)} 行`:''
    const paths=files?.slice(0,8).map(file=>file.path).join('、')
    return [
      `${name} · ${candidateLabels[status]} · ${files?`${result?.partial?'已统计 ':''}${files.length} 个文件${counts||'，部分行数未取得'}`:'改动统计未取得'}`,
      ...(paths?[`  ${paths}${files!.length>8?'等':''}`]:[]),
      ...(result?.statusLine?[`  ${result.statusLine}`]:[]),
      ...(result?.tests.length?[`  验证（执行者报告）：${result.tests.join('、')}`]:[]),
      ...(taskId?[`  工作区：任务 ${taskId}（合回：任务 ${taskId} 合回）`]:[]),
    ].join('\n')
  })
  const example=members.find(m=>m.taskId&&m.status==='completed')??members.find(m=>m.taskId)
  return [`「${title}」第 ${position} 棒的并行对照`,...lines,
    example?`选定后可以说「用 ${example.name} 那版」。`:'这组没有可合回的工作区。'].join('\n')
}

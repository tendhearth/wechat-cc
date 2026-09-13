import {randomUUID} from 'node:crypto'
import type {AgentUserInputAnswers,AgentUserInputRequest} from '../agent-provider'

const object=(value:unknown):value is Record<string,unknown> => !!value&&typeof value==='object'&&!Array.isArray(value)
const text=(value:unknown,max:number):value is string => typeof value==='string'&&value.trim().length>0&&value.length<=max

export function validateUserInputRequest(value:unknown):AgentUserInputRequest {
  const bad=()=>{throw new Error('invalid_question')}
  if(!object(value)||!Array.isArray(value.questions)||!value.questions.length||value.questions.length>4||JSON.stringify(value).length>20_000)return bad()
  const ids=new Set<string>()
  const questions=value.questions.map(q=>{
    if(!object(q)||!text(q.id,120)||ids.has(q.id)||!text(q.header,120)||!text(q.question,4000)||!Array.isArray(q.options)||q.options.length>8||
      (q.multiSelect!==undefined&&typeof q.multiSelect!=='boolean')||(q.allowOther!==undefined&&typeof q.allowOther!=='boolean'))return bad()
    ids.add(q.id)
    const labels=new Set<string>()
    const options=q.options.map(o=>{
      if(!object(o)||!text(o.label,300)||labels.has(o.label)||typeof o.description!=='string'||o.description.length>1000)return bad()
      labels.add(o.label);return{label:o.label,description:o.description}
    })
    if(!options.length&&!q.allowOther)return bad()
    return{id:q.id,header:q.header,question:q.question,options,multiSelect:!!q.multiSelect,allowOther:!!q.allowOther}
  })
  return{questions}
}

export function validateUserInputAnswers(request:AgentUserInputRequest,value:unknown):AgentUserInputAnswers {
  const bad=()=>{throw new Error('invalid_answer')}
  if(!object(value)||JSON.stringify(value).length>20_000||Object.keys(value).length!==request.questions.length)return bad()
  const pairs=request.questions.map(q=>{
    if(!Object.hasOwn(value,q.id))return bad()
    const answers=value[q.id]
    if(!Array.isArray(answers)||answers.length<1||answers.length>(q.multiSelect?8:1)||new Set(answers).size!==answers.length)return bad()
    if(answers.some(a=>!text(a,4000)||(!q.allowOther&&!q.options.some(o=>o.label===a))))return bad()
    return[q.id,[...answers]] as [string,string[]]
  })
  return Object.fromEntries(pairs)
}

export interface PendingUserInput extends AgentUserInputRequest {id:string;taskId:string;createdAt:number}
export function makeRunUserInput(opts:{taskId:string;audit?:(event:{type:'request'|'answer'|'closed';request:PendingUserInput;answers?:AgentUserInputAnswers|null})=>void}) {
  let closed=false
  const entries=new Map<string,{view:PendingUserInput;finish:(answers:AgentUserInputAnswers|null)=>void}>()
  const audit=(event:Parameters<NonNullable<typeof opts.audit>>[0])=>{try{opts.audit?.(event);return true}catch{return false}}
  return{
    request(raw:AgentUserInputRequest,signal?:AbortSignal):Promise<AgentUserInputAnswers|null>{
      if(closed||signal?.aborted)return Promise.resolve(null)
      const spec=validateUserInputRequest(raw)
      if(entries.size>=8)throw new Error('question_limit')
      const view={...spec,id:randomUUID(),taskId:opts.taskId,createdAt:Date.now()}
      return new Promise(resolve=>{
        const onAbort=()=>finish(null)
        const finish=(answers:AgentUserInputAnswers|null)=>{
          if(!entries.delete(view.id))return
          signal?.removeEventListener('abort',onAbort)
          const ok=audit({type:answers?'answer':'closed',request:structuredClone(view),answers})
          resolve(ok?answers:null)
        }
        entries.set(view.id,{view,finish})
        signal?.addEventListener('abort',onAbort,{once:true})
        if(!audit({type:'request',request:structuredClone(view)}))finish(null)
      })
    },
    pending:()=>Array.from(entries.values(),e=>structuredClone(e.view)),
    resolve(id:string,raw:unknown){
      const entry=entries.get(id);if(!entry)return false
      entry.finish(raw===null?null:validateUserInputAnswers(entry.view,raw));return true
    },
    close(){closed=true;for(const entry of entries.values())entry.finish(null)},
  }
}
export type RunUserInput=ReturnType<typeof makeRunUserInput>

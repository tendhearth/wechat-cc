import type {ServiceDeps} from './ctx'

/** Same bounded topic lookup for pushed context and on-demand matter context. */
export async function readTopicBrief(brief:ServiceDeps['topicBrief'],task:{id:string;ownerChatId?:string|null;title:string},text:string):Promise<string|null>{
  if(!brief)return null
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([
    Promise.resolve().then(()=>brief({matterId:task.id,ownerChatId:task.ownerChatId??null,title:task.title,text})).catch(()=>null),
    new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),2_000)}),
  ])}finally{clearTimeout(timer)}
}

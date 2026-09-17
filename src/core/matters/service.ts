import type {ListMatters,Matter,MatterBinding,MatterSession,MatterStore} from './store'

/**
 * matters/service.ts — 各表面共用的"一件事"读写面:列表、详情、往一件事说话。
 *
 * 这是统一入口的实体:手机端、桌面、微信管家最终都只调这三个。事件仍从各自的表拼
 * (工作台任务从 workbench 详情取),这里不复制数据。`say` 按 kind 路由:
 * task → 工作台续接;chat → 现有的 app 对话通道(只对主人的 chat)。
 */
export interface MatterTaskView {id:string;title:string;status:string;phase?:string;providerId:string;path:string;error:string|null;updatedAt:number}
export interface MatterEvent {kind:string;text:string;createdAt:number}
export interface MatterDetail {matter:Matter;bindings:MatterBinding[];sessions:MatterSession[];task:MatterTaskView|null;events:MatterEvent[]}
export interface MattersServiceDeps {
  store:MatterStore
  workbench?:{
    detail(id:string):{task:MatterTaskView;events:Array<{kind:string;text:string;createdAt:number}>}
    continueTask(id:string,text:string):MatterTaskView
  }
  /** 对主人的 chat 说话(app 对话通道)。只在 chat 类 matter 绑着主人的微信时可用。 */
  chat?:{ownerChatId():string|null;say(text:string):Promise<{reply:string}>}
  now?:()=>number
}
export interface MattersService {
  list(filter?:ListMatters):Matter[]
  detail(id:string):MatterDetail
  say(id:string,text:string):Promise<{kind:'task';task:MatterTaskView}|{kind:'chat';reply:string}>
}
const ID=/^[a-f0-9]{8}$/

export function makeMattersService(deps:MattersServiceDeps):MattersService {
  const require=(id:string):Matter=>{if(!ID.test(id))throw new Error('invalid_matter_id');const m=deps.store.get(id);if(!m)throw new Error('matter_not_found');return m}
  return {
    list:filter=>deps.store.list(filter),
    detail(id){
      const matter=require(id)
      let task:MatterTaskView|null=null,events:MatterEvent[]=[]
      if(matter.kind==='task'&&deps.workbench){
        try{const d=deps.workbench.detail(matter.id);task=d.task;events=d.events.slice(-50).map(e=>({kind:e.kind,text:e.text,createdAt:e.createdAt}))}
        catch{/* 任务记录不在了也不让详情整个失败:matter 本身还在 */}
      }
      return {matter,bindings:deps.store.bindings(id),sessions:deps.store.sessions(id),task,events}
    },
    async say(id,text){
      const matter=require(id)
      if(typeof text!=='string'||!text.trim())throw new Error('invalid_text')
      if(matter.kind==='task'){
        if(!deps.workbench)throw new Error('workbench_not_wired')
        const task=deps.workbench.continueTask(matter.id,text)
        deps.store.setStatus(matter.id,'open')
        return {kind:'task',task}
      }
      if(matter.kind==='chat'){
        if(!deps.chat)throw new Error('chat_not_wired')
        const owner=deps.chat.ownerChatId()
        const boundToOwner=!!owner&&deps.store.bindings(id).some(b=>b.surface==='wechat'&&b.surfaceKey===owner)
        if(!boundToOwner)throw new Error('matter_say_unsupported')
        const {reply}=await deps.chat.say(text)
        deps.store.touch(id)
        return {kind:'chat',reply}
      }
      throw new Error('matter_say_unsupported')
    },
  }
}

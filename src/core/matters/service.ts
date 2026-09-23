import type {ListMatters,Matter,MatterBinding,MatterSession,MatterStore} from './store'

/**
 * matters/service.ts — 各表面共用的"一件事"读写面:列表、详情、往一件事说话。
 *
 * 这是统一入口的实体:手机端、桌面、微信管家最终都只调这三个。事件仍从各自的表拼
 * (工作台任务从 workbench 详情取),这里不复制数据。`say` 按 kind 路由:
 * task → 工作台续接;chat → 现有的 app 对话通道(只对主人的 chat)。
 */
export interface MatterTaskView {id:string;title:string;status:string;phase?:string;providerId:string;path:string;error:string|null;updatedAt:number}
export interface MatterEvent {kind:string;text:string;createdAt:number;source?:string}
export interface MatterDetail {matter:Matter;bindings:MatterBinding[];sessions:MatterSession[];task:MatterTaskView|null;events:MatterEvent[]}
export interface MattersServiceDeps {
  store:MatterStore
  workbench?:{
    detail(id:string):{task:MatterTaskView;events:Array<{kind:string;text:string;createdAt:number}>}
    continueTask(id:string,text:string):MatterTaskView
  }
  /** 对主人的 chat 说话(app 对话通道),surface 记这句是从哪个表面来的;recent 读该 chat 的消息流(微信 / 桌面 / 手机三处进同一条)。 */
  chat?:{ownerChatId():string|null;say(text:string,surface?:'desktop'|'phone'):Promise<{reply:string}>;recent?(chatId:string,limit:number):Promise<MatterEvent[]>}
  now?:()=>number
}
export interface MattersService {
  list(filter?:ListMatters):Matter[]
  detail(id:string):Promise<MatterDetail>
  /** 主人那条对话(没有就建),并记下是从哪个表面看的;没配主人 → null。 */
  ownerChat(surface:'desktop'|'phone'):Promise<MatterDetail|null>
  say(id:string,text:string,surface?:'desktop'|'phone'):Promise<{kind:'task';task:MatterTaskView}|{kind:'chat';reply:string}>
}
const ID=/^[a-f0-9]{8}$/

export function makeMattersService(deps:MattersServiceDeps):MattersService {
  const require=(id:string):Matter=>{if(!ID.test(id))throw new Error('invalid_matter_id');const m=deps.store.get(id);if(!m)throw new Error('matter_not_found');return m}
  return {
    list:filter=>deps.store.list(filter),
    async detail(id){
      const matter=require(id)
      let task:MatterTaskView|null=null,events:MatterEvent[]=[]
      if(matter.kind==='chat'&&deps.chat?.recent){
        const chatId=deps.store.bindings(id).find(b=>b.surface==='wechat')?.surfaceKey
        if(chatId){try{events=(await deps.chat.recent(chatId,50)).sort((a,b)=>a.createdAt-b.createdAt)}catch{/* 读不到消息流,详情本身还在 */}}
      }
      if(matter.kind==='task'&&deps.workbench){
        try{const d=deps.workbench.detail(matter.id);task=d.task;events=d.events.slice(-50).map(e=>({kind:e.kind,text:e.text,createdAt:e.createdAt}))}
        catch{/* 任务记录不在了也不让详情整个失败:matter 本身还在 */}
      }
      return {matter,bindings:deps.store.bindings(id),sessions:deps.store.sessions(id),task,events}
    },
    async ownerChat(surface){
      const owner=deps.chat?.ownerChatId();if(!owner)return null
      const m=deps.store.ensureChat(owner);deps.store.bind(m.id,surface,surface==='desktop'?'app':'pwa')
      return this.detail(m.id)
    },
    async say(id,text,surface){
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
        const {reply}=await deps.chat.say(text,surface)
        deps.store.touch(id)
        return {kind:'chat',reply}
      }
      throw new Error('matter_say_unsupported')
    },
  }
}

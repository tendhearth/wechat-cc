/**
 * 「一件事」的口(架构终态 E5):matter 的形状与 store、对主人聊天那件事「说一句」的回执。实现在
 * src/adapters/store/matters-store.ts、say-receipts.ts(SQLite);app 的「一件事」服务只经这里认它们。只有类型,没有逻辑。
 */

export type MatterKind='chat'|'task'|'companion'
export type MatterStatus='open'|'replied'|'done'|'archived'
export type MatterSurface='wechat'|'desktop'|'phone'|'cli'
export type MatterSessionRole='main'|'review'|'handoff'
/**
 * 一件事从哪个表面来的(v77,2026-10-19):创建时写一次,此后永不更新(库里有触发器拦着)。
 * 与 MatterSurface(在哪露过面,matter_bindings)不是一回事:app = 原生手机 App(中继 v2 密封帧),
 * web = 浏览器 /m 页(局域网直连或 v1 隧道),cli = 从终端会话导入,companion = CC 自己起的。
 * 不知道 ⇒ 不写(null),界面就不画 —— 旧行一律 null,不回填、不猜。
 */
export type MatterOrigin='wechat'|'desktop'|'app'|'web'|'cli'|'companion'
export interface Matter {id:string;kind:MatterKind;title:string;projectPath:string|null;status:MatterStatus;ownerChatId:string|null;originMatterId:string|null;originMessageId:string|null;createdAt:number;updatedAt:number;/** 出生地(只在知道时带)。 */origin?:MatterOrigin;/** 参与过这件事的执行者(列表才带):正在做的在前,其余按最近 —— 手机/桌面画成叠在一起的圆头像。 */agents?:string[];/** 执行者 id → 正式名字(收敛清单 ⑥):服务层按 registry 填,三端不存名字表。 */agentNames?:Record<string,string>}
export interface MatterBinding {matterId:string;surface:MatterSurface;surfaceKey:string;lastSeenAt:number}
export interface MatterSession {matterId:string;providerId:string;sessionId:string;role:MatterSessionRole;createdAt:number}
export interface CreateMatter {id?:string;kind:MatterKind;title:string;projectPath?:string|null;ownerChatId?:string|null;status?:MatterStatus;originMatterId?:string|null;originMessageId?:string|null;/** 出生地:只在建行时写这一次;不知道就别给(null)。 */origin?:MatterOrigin|null}
export interface ListMatters {kind?:MatterKind;statuses?:MatterStatus[];since?:number;limit?:number;/** 只要在这个表面露过面的 */surface?:MatterSurface}

export interface MatterStore {
  create(input:CreateMatter):Matter
  get(id:string):Matter|null
  list(filter?:ListMatters):Matter[]
  setStatus(id:string,status:MatterStatus):void
  rename(id:string,title:string):void
  touch(id:string):void
  bind(id:string,surface:MatterSurface,surfaceKey:string):void
  bindings(id:string):MatterBinding[]
  findBySurface(surface:MatterSurface,surfaceKey:string):Matter|null
  addSession(id:string,providerId:string,sessionId:string,role:MatterSessionRole):void
  sessions(id:string):MatterSession[]
  /** ensureChat 的只读半边:只查这个微信 chat 的 kind='chat' matter,不建、不刷新露面时间(读路径用)。 */
  findChat(chatId:string):Matter|null
  /** 一个微信 chat 对应一条 kind='chat' 的 matter:有就刷新露面时间,没有就建(origin 只在这次建行时写)。 */
  ensureChat(chatId:string,title?:string,origin?:MatterOrigin|null):Matter
  /** 工作台任务与 matter 一对一、id 相同:把 workbench_tasks.matter_id 补上(新任务;存量靠 v60 回填)。 */
  linkTask(taskId:string):void
  /** 每件事有哪些执行者参与过(2026-10-19 头像叠):任务本身的执行者在前,再按最近的审阅 / 返工交接、会话。没有的 id 不出现。 */
  agents(ids:string[]):Map<string,string[]>
  /** 一页里每件事的出生地(工作台列表一次查完);不知道的 id 不出现。 */
  origins(ids:string[]):Map<string,MatterOrigin>
}

export type SayReceiptStatus='pending'|'replied'
export interface SayReceipt {requestId:string;matterId:string;textHash:string;status:SayReceiptStatus;reply:string|null;createdAt:number}
export interface SayReceipts {
  get(requestId:string):SayReceipt|null
  /** 登记一句新话;已有同 id 的回执 ⇒ 返回它、不改(调用方判冲突)。 */
  reserve(input:{requestId:string;matterId:string;textHash:string}):{fresh:boolean;receipt:SayReceipt}
  settle(requestId:string,reply:string):void
  drop(requestId:string):void
}

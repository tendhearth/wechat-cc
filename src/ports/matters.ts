import type {TurnUsage} from '../domain/turn-usage'

/**
 * 「一件事」的口(架构终态 E5):matter 的形状与 store、对主人聊天那件事「说一句」的回执。实现在
 * src/adapters/store/matters-store.ts、say-receipts.ts(SQLite);app 的「一件事」服务只经这里认它们。只有类型,没有逻辑。
 */

/** chat = 和人的对话;task = 一起做;terminal = 终端会话;act = CC 自己做的事(信、早报、打猎…)。设计稿 §3.1。 */
export type MatterKind='chat'|'task'|'terminal'|'act'
/** 谁发起的:陪伴和干活的区别只在这一个字段(v92)。peer = A2A / 笔友的对端。 */
export type MatterInitiator='owner'|'cc'|'peer'
/**
 * 统一状态(v92):open → working ⇄ waiting(等你)→ done | failed | cancelled;归档是另一列(archivedAt),和它正交。
 * 由 MatterLog 维护(轮开始 / 结束、等你的步出现 / 了结)。读这一侧到 M6 才切过来;在那之前出口照旧读 MatterStatus。
 */
export type MatterState='open'|'working'|'waiting'|'done'|'failed'|'cancelled'
/** 旧状态(v60):出口(/v1/matter、/m/api、App)照旧读它,M6 删。 */
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
export interface CreateMatter {id?:string;kind:MatterKind;/** 不给 ⇒ owner。 */initiator?:MatterInitiator;title:string;projectPath?:string|null;ownerChatId?:string|null;status?:MatterStatus;originMatterId?:string|null;originMessageId?:string|null;/** 出生地:只在建行时写这一次;不知道就别给(null)。 */origin?:MatterOrigin|null}
export interface ListMatters {kind?:MatterKind;statuses?:MatterStatus[];since?:number;limit?:number;/** 只要在这个表面露过面的 */surface?:MatterSurface}

export interface MatterStore {
  create(input:CreateMatter):Matter
  get(id:string):Matter|null
  list(filter?:ListMatters):Matter[]
  /** 旧状态;顺手把 archived_at 与统一状态里能确定的那半边(做完 / 重新打开)跟上,working / waiting 只归 MatterLog。 */
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

/**
 * 一轮 / 一步(v92,设计稿 2026-10-31 §3.1):一轮 = 执行者的一个回合(一次输入 → 一次回应);一步 = 你说的话 / CC 说的话 /
 * 工具调用 / 权限卡 / 提问 / 成果 / 送达 / 系统 / 错误。正文在 messages 的(对话里说的话)只引 messageId,不抄。
 * seq 每件事单调;cursor 全库单调,每写一次(含更新)前进 —— 订阅按 cursor 取变化。
 */
export type MatterTurnStatus='running'|'completed'|'failed'|'cancelled'|'interrupted'
export type MatterItemKind='user_message'|'agent_message'|'tool_call'|'permission'|'question'|'artifact'|'delivery'|'system'|'error'
export type MatterItemStatus='started'|'completed'|'failed'
/** 显式的结局:working / waiting 不能直接设,只能由轮与「等你」的步推出来。 */
export type MatterOutcome='open'|'done'|'failed'|'cancelled'
export interface MatterTurn {id:string;matterId:string;seq:number;runId:string|null;executor:string;model:string|null;nativeSessionId:string|null;status:MatterTurnStatus;errorCode:string|null;usage:TurnUsage|null;policy:Record<string,unknown>|null;startedAt:number;endedAt:number|null;cursor:number}
export interface MatterItem {id:number;matterId:string;turnId:string|null;seq:number;kind:MatterItemKind;status:MatterItemStatus;key:string|null;messageId:string|null;payload:Record<string,unknown>;createdAt:number;updatedAt:number;cursor:number}
export interface StartTurn {matterId:string;executor:string;model?:string|null;nativeSessionId?:string|null;runId?:string|null;/** 编译好的策略摘要(放行档、模型选择…),原样存。 */policy?:Record<string,unknown>|null}
export interface FinishTurn {
  status:Exclude<MatterTurnStatus,'running'>
  usage?:TurnUsage|null;errorCode?:string|null;nativeSessionId?:string|null
  /** 这一轮结束后这件事落到哪。不给 ⇒ open(球回到主人手里)。还有别的轮在跑 ⇒ 不生效。 */
  matterState?:MatterOutcome
}
export interface WriteItem {
  matterId:string;turnId?:string|null;kind:MatterItemKind;status:MatterItemStatus
  /** 同一步的 started → completed 用同一把 key 合成一行(执行者自己的 item id / 工具调用 id)。不给 ⇒ 每次一行新的。 */
  key?:string|null
  messageId?:string|null
  /** 给了就整个换掉;不给 ⇒ 留着原来的。 */
  payload?:Record<string,unknown>
  /** 逐字流:接在 payload.text 后面(截在 40000 字)。 */
  appendText?:string
}

/**
 * 一件事的轮与步只经这一个口写(M1):一起做的服务、对话的协调器、终端会话的 hub、CC 自己做的事,M2–M5 依次切过来。
 * 每次调用一个事务;统一状态(MatterState)由这里维护:有开着的权限卡 / 提问 ⇒ waiting,否则有轮在跑 ⇒ working,
 * 否则回到上一次的结局(轮结束时给的 matterState,默认 open)。轮结束时还开着的步一律记 failed。
 */
export interface MatterLog {
  startTurn(input:StartTurn):MatterTurn
  /** 幂等:已经结束的轮原样返回,不改。 */
  finishTurn(turnId:string,input:FinishTurn):MatterTurn
  /** 同一把 key 已经做完 / 失败 ⇒ 迟到的 started 原样返回,不倒回;所属的轮已经结束 ⇒ started 记成 failed。 */
  writeItem(input:WriteItem):MatterItem
  /** 显式结局;还有轮在跑 ⇒ 拒(matter_has_running_turn)。 */
  setState(matterId:string,state:MatterOutcome):void
  state(matterId:string):{state:MatterState;archivedAt:number|null}|null
  turns(matterId:string):MatterTurn[]
  /** 按 seq;给了 afterCursor 只要这之后写过的。 */
  items(matterId:string,opts?:{afterCursor?:number}):MatterItem[]
}

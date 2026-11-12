import type {TurnUsage} from '../domain/turn-usage'
import type {LegacyMatterStatus} from '../domain/matters/wire-status'

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
 * 由 MatterLog 维护(轮开始 / 结束、等你的步出现 / 了结)。线上的旧 status 从它推(domain/matters/legacy-status.ts,v102 删了那一列)。
 */
export type MatterState='open'|'working'|'waiting'|'done'|'failed'|'cancelled'
/**
 * 一件事的归档 / 结局怎么跟上(v102 前叫 setStatus、还写旧 status 列):archived ⇒ 记归档时间;done ⇒ 取消归档、统一状态 done
 * (没做成 / 停下了不改写);open ⇒ 取消归档、结局清回 open。working / waiting 只归 MatterLog。
 */
export type MatterLifecycle='archived'|'done'|'open'
export type MatterSurface='wechat'|'desktop'|'phone'|'cli'
export type MatterSessionRole='main'|'review'|'handoff'
export interface MatterAgent {matterId:string;runId:string;executor:string;brief:string;position:number;status:'queued'|'running'|'completed'|'failed';createdAt:number;endedAt:number|null}
export interface MatterNote {id:number;matterId:string;runId:string|null;author:string;kind:'plan'|'note'|'artifact';text:string;createdAt:number}
/**
 * 一件事从哪个表面来的(v77,2026-10-19):创建时写一次,此后永不更新(库里有触发器拦着)。
 * 与 MatterSurface(在哪露过面,matter_bindings)不是一回事:app = 原生手机 App(中继 v2 密封帧),
 * web = 浏览器 /m 页(局域网直连或 v1 隧道),cli = 从终端会话导入,companion = CC 自己起的。
 * 不知道 ⇒ 不写(null),界面就不画 —— 旧行一律 null,不回填、不猜。
 */
export type MatterOrigin='wechat'|'desktop'|'app'|'web'|'cli'|'companion'
export interface Matter {id:string;kind:MatterKind;title:string;projectPath:string|null;/** 统一状态(M6b 起上线);新客户端读它和 archivedAt。线上的旧 status 不在这里:出口经 domain/matters/legacy-status.ts 的 wireMatter 现算(wire-compat.ts 那一行)。 */state?:MatterState;archivedAt?:number|null;ownerChatId:string|null;originMatterId:string|null;originMessageId:string|null;createdAt:number;updatedAt:number;/** 出生地(只在知道时带)。 */origin?:MatterOrigin;/** 参与过这件事的执行者(列表才带):正在做的在前,其余按最近 —— 手机/桌面画成叠在一起的圆头像。 */agents?:string[];/** 执行者 id → 正式名字(收敛清单 ⑥):服务层按 registry 填,三端不存名字表。 */agentNames?:Record<string,string>;/** CC 自己做的事(M5c):发起方 + 最近那一轮。 */act?:MatterAct}
/**
 * CC 自己做的事那一件(kind='act',M5c):手机「CC 最近在忙」那一组与详情页的时间线。只在点名 kind=act 的列表与 act 的详情里带。
 * who = 发起方(letters / brief / memory / hunt / atelier / stickers,取自轮的 policy.who);步的 payload 只留数字、真假、短字符串。
 */
export interface MatterActStep {kind:string;status:string;at:number;payload?:Record<string,unknown>}
export interface MatterActTurn {id:string;status:string;errorCode?:string|null;/** 记忆整理:schedule / owner(主人当面叫的)。 */trigger?:string;startedAt:number;endedAt:number|null;steps:MatterActStep[]}
export interface MatterAct {who?:string;latest?:MatterActTurn}
export interface MatterBinding {matterId:string;surface:MatterSurface;surfaceKey:string;lastSeenAt:number}
export interface MatterSession {matterId:string;providerId:string;sessionId:string;role:MatterSessionRole;createdAt:number}
export interface CreateMatter {id?:string;kind:MatterKind;/** 不给 ⇒ owner。 */initiator?:MatterInitiator;title:string;projectPath?:string|null;ownerChatId?:string|null;originMatterId?:string|null;originMessageId?:string|null;/** 出生地:只在建行时写这一次;不知道就别给(null)。 */origin?:MatterOrigin|null}
export interface ListMatters {q?:string;project?:string;state?:MatterState;before?:{at:number;id:string};kind?:MatterKind;/** 线上 `?status=` 的筛选(旧状态,wire-compat.ts 第一行):SQL 里按 legacy-status 的式子筛,LIMIT 之前。 */legacy?:LegacyMatterStatus[];since?:number;limit?:number;/** 只要在这个表面露过面的 */surface?:MatterSurface}

export interface MatterStore {
  create(input:CreateMatter):Matter
  get(id:string):Matter|null
  list(filter?:ListMatters):Matter[]
  /** 归档 / 取消归档,顺手把统一状态里能确定的那半边(做完 / 重新打开)跟上;见 MatterLifecycle。 */
  setLifecycle(id:string,to:MatterLifecycle):void
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
  /** 每件事有哪些执行者参与过(2026-10-19 头像叠):任务本身的执行者在前,再按最近的审阅 / 返工交接、会话。没有的 id 不出现。 */
  agents(ids:string[]):Map<string,string[]>
  /** 一页里每件事的出生地(工作台列表一次查完);不知道的 id 不出现。 */
  origins(ids:string[]):Map<string,MatterOrigin>
  /** 一页里每件事线上的旧状态(wire-compat.ts 第一行;式子在 domain/matters/legacy-status.ts)。没有的 id 不出现。 */
  legacyStatuses(ids:string[]):Map<string,LegacyMatterStatus>
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
export interface StartTurn {matterId:string;executor:string;model?:string|null;nativeSessionId?:string|null;runId?:string|null;/** 这一轮真正开始的时刻(调用方记的,比如排在会话锁后面之前);不给 ⇒ 现在。 */startedAt?:number;/** 编译好的策略摘要(放行档、模型选择…),原样存。 */policy?:Record<string,unknown>|null}
export interface FinishTurn {
  status:Exclude<MatterTurnStatus,'running'>
  usage?:TurnUsage|null;errorCode?:string|null;nativeSessionId?:string|null
  /** 这一轮真正结束的时刻;不给 ⇒ 现在。只管 ended_at,这件事的 updated_at 照旧是写的那一刻。 */
  endedAt?:number
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
  /** 轮开始以后才知道的:执行者自报的实际模型、策略摘要里补的一项(一起做 M2b)。给了 policy 就整个换掉;不碰状态。 */
  updateTurn(turnId:string,patch:{model?:string|null;policy?:Record<string,unknown>|null}):MatterTurn
  /** 非步的变化(状态、权限卡、成果批准、补充回执…)也推进这件事的游标,订阅的人才看得见(P1a);不写行、不碰状态。返回新游标。 */
  touch(matterId:string):number
  /** 同一把 key 已经做完 / 失败 ⇒ 迟到的 started 原样返回,不倒回;所属的轮已经结束 ⇒ started 记成 failed。 */
  writeItem(input:WriteItem):MatterItem
  /** 显式结局;还有轮在跑 ⇒ 拒(matter_has_running_turn)。 */
  setState(matterId:string,state:MatterOutcome):void
  state(matterId:string):{state:MatterState;archivedAt:number|null}|null
  turns(matterId:string):MatterTurn[]
  /** 同一把 key 的那一步(逐字流拼接前要先看上一段)。 */
  item(matterId:string,key:string):MatterItem|null
  /** 按 seq;给了 afterCursor 只要这之后写过的。 */
  items(matterId:string,opts?:{afterCursor?:number}):MatterItem[]
}

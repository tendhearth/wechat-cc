/**
 * 微信侧和等待行共用的三个类型,从 service.ts 挪出来断环(spec 2026-09-27-workbench-service-split §2):
 * wechat-control.ts 只需要这三个类型,不该反向 import 整个 service。
 */
import type { WaitingFor } from '../../adapters/workbench/scheduler'
import type { MatterOrigin } from '../../ports/matters'

export interface CreateWechatTask {ownerChatId:string;accountId:string;requestId:string;commandHash:string;projectId:string;providerId?:string;text:string;/** 独立工作区(2026-10-07):「任务 新建 <项目> 独立 <要求>」 */isolation?:boolean;/** 「独立@<分支>」:从这个本地分支开始(10-08) */base?:string;originMessageId?:string;/** 标题(10-20 两家对比:「… · @claude」好在列表里分清);省略 ⇒ 取要求开头 */title?:string;/** 出生地(2026-10-19):省略 ⇒ wechat(微信入站);App 一轮里的「任务」命令由 daemon 填 desktop / app / web,不知道 ⇒ null。 */origin?:MatterOrigin|null}
export interface SendWechatArtifact {ownerChatId:string;accountId:string;requestId:string;commandHash:string;taskId:string;artifactId:string}
/** 等待行给主人看的那份:除了「挡路的是谁、为什么」,还要说清「挡路的那位是不是已经答复、
 *  是不是正数着秒自己让开」——不然「答复完了」和「文件夹空了」这两件事在等待行里还是分不开
 *  (docs/superpowers/specs/2026-09-21-one-folder-one-session-design.md，任务 2 的由来)。
 *  `holderWriting=false` 且 `closeInMs` 不是 null 时,才是「快让开了,可以现在就收工」那句话
 *  该出现的时候;`writer_not_closed` 那种 holder 永远不安静,这两个字段用不上也盖不掉老文案。 */
export interface TaskWaitingFor extends WaitingFor { holderWriting: boolean; closeInMs: number | null }

/**
 * 工作台零件的口(架构终态 E5):附件、成果、权限卡与提问卡、对正在跑的任务「补一句」。实现在 src/adapters/workbench/
 * (attachments / permissions / user-input)与 src/adapters/store/workbench/(store / live-inputs);app 的「一件事」服务
 * 只经这里认它们的形状。只有类型,没有逻辑。
 */
import type { AgentExecutionChoice, AgentUserInputRequest } from './agent-provider'

export interface Attachment {id:string;name:string;mime:string;size:number;sha256:string}
export interface Artifact { id: string; taskId: string; name: string; mime: string; size: number; sha256: string; createdAt: number; approvedAt: number | null }

export type PermissionDecision = 'allow' | 'deny'
export interface PendingWorkbenchPermission {
  id: string
  taskId: string
  tool: string
  description: string
  createdAt: number
}

export interface PendingUserInput extends AgentUserInputRequest {id:string;taskId:string;createdAt:number}

export type LiveInputStatus='pending'|'sending'|'delivered'|'held'|'withdrawn'
export interface LiveInput {id:string;taskId:string;runId:string;text:string;status:LiveInputStatus;createdAt:number;error:string|null;attachments?:Attachment[];execution?:AgentExecutionChoice}

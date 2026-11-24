import { type PermissionDisplay } from '@wechat-cc/protocol'
/**
 * 工作台零件的口(架构终态 E5):附件、成果、权限卡与提问卡、对正在跑的任务「补一句」。实现在 src/adapters/workbench/
 * (attachments / permissions / user-input)与 src/adapters/store/workbench/(store / live-inputs);app 的「一件事」服务
 * 只经这里认它们的形状。
 */
import type { AgentExecutionChoice, AgentUserInputRequest } from './agent-provider'

export interface Attachment {id:string;name:string;mime:string;size:number;sha256:string}
export interface Artifact { id: string; taskId: string; name: string; mime: string; size: number; sha256: string; createdAt: number; approvedAt: number | null }

export type PermissionDecision = 'allow' | 'deny' | 'allow_task'
export interface PermissionScript { path: string; content: string; sha256?: string; error?: string; truncated?: boolean }
/** 手机详情超出帧预算时用的原描述。Symbol 字段只在进程内传递。 */
export const legacyPermissionDescription = Symbol('legacyPermissionDescription')
/** Source details for WeChat's approval eligibility. Symbols stay off the wire. */
export const wechatPermissionSource = Symbol('wechatPermissionSource')
export interface PendingWorkbenchPermission {
  id: string
  taskId: string
  tool: string
  description: string
  [legacyPermissionDescription]?: string
  [wechatPermissionSource]?: { description: string; cwd?: string; command?: string; paths?: readonly string[]; display?: PermissionDisplay; incomplete?: true }
  createdAt: number
  display?: PermissionDisplay
  cwd?: string
  /** The description includes the execution snapshot notice. */
  showSnapshotNotice?: boolean
  canAllowTask?: boolean
  canDenyWithReason?: boolean
  scripts?: PermissionScript[]
}

export interface PendingUserInput extends AgentUserInputRequest {id:string;taskId:string;createdAt:number}

export type LiveInputStatus='pending'|'sending'|'delivered'|'held'|'withdrawn'
export interface LiveInput {id:string;taskId:string;runId:string;text:string;status:LiveInputStatus;createdAt:number;error:string|null;attachments?:Attachment[];execution?:AgentExecutionChoice}

/** Local-only butler checkup. No conversations, credentials or model answers. */
import z from 'zod'
export interface CheckupTarget {
  provider: string
  address: string
  model: string
  windowTokens: number
  windowKnown: boolean
}
export interface CheckupEstimate {
  targetKey: string
  requests: number
  maxRequests: number
  inputTokens: number
  outputTokens: number
  windowKnown: boolean
}
export const CHECKUP_QUALITIES = ['memory','tracking','honesty','discretion','stance','privacy','persona'] as const
export type CheckupQuality = typeof CHECKUP_QUALITIES[number]
export interface CheckupRatio { passed:number; total:number; ratio:number|null }
export interface CheckupInterview {
  version: 'interview-v1'
  name: string
  delegationAvailable?: boolean
  reliableDay: string | null
  reliableTokens?: number | null
  qualities: Record<CheckupQuality,CheckupRatio>
  business: CheckupRatio
}
export interface CheckupProfile {
  interview?: CheckupInterview
  provider: string
  addressHash: string
  model: string
  windowTokens: number
  windowKnown: boolean
  reliableFillRatio: number
  stages: Array<{ fillRatio: number; accuracy: number; trackingAccuracy?: number }>
  memory: 'good' | 'fair' | 'weak'
  tools: 'stable' | 'flaky'
  toolAccuracy: number
  firstTextMedianMs: number | null
  completionMedianMs: number
  testedAt: string
  ccVersion: string
  short: boolean
  seed: number
}
export interface CheckupAttempt {
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  completedRequests: number
  totalRequests: number
  startedAt: string
  finishedAt?: string
  errorCode?: string
}
export interface CheckupReview {title:string;rows:Array<{key:string;label:string;detail:string;grade:string}>;status:string;care:string}
export interface CheckupView {
  target: CheckupTarget
  name?: string
  review?: CheckupReview
  profile: CheckupProfile | null
  attempt: CheckupAttempt | null
  suspectedChanged: boolean
  periodicProbe: boolean
}
export interface ContextBudget {
  windowTokens: number
  reliableFillRatio: number
  source: 'measured' | 'default'
}

const Target = z.object({provider:z.string(),address:z.string(),model:z.string(),windowTokens:z.number().int().positive(),windowKnown:z.boolean()})
const Ratio = z.object({passed:z.number(),total:z.number(),ratio:z.number().nullable()})
const Interview = z.object({version:z.literal('interview-v1'),name:z.string(),delegationAvailable:z.boolean().optional(),reliableDay:z.string().nullable(),reliableTokens:z.number().nonnegative().nullable().optional(),qualities:z.object({memory:Ratio,tracking:Ratio,honesty:Ratio,discretion:Ratio,stance:Ratio,privacy:Ratio,persona:Ratio}),business:Ratio})
const Profile = z.object({interview:Interview.optional(),provider:z.string(),addressHash:z.string(),model:z.string(),windowTokens:z.number(),windowKnown:z.boolean(),reliableFillRatio:z.number(),stages:z.array(z.object({fillRatio:z.number(),accuracy:z.number(),trackingAccuracy:z.number().optional()})),memory:z.enum(['good','fair','weak']),tools:z.enum(['stable','flaky']),toolAccuracy:z.number(),firstTextMedianMs:z.number().nullable(),completionMedianMs:z.number(),testedAt:z.string(),ccVersion:z.string(),short:z.boolean(),seed:z.number()})
const Attempt = z.object({status:z.enum(['running','completed','failed','cancelled']),completedRequests:z.number(),totalRequests:z.number(),startedAt:z.string(),finishedAt:z.string().optional(),errorCode:z.string().optional()})
export const CheckupViewSchema: z.ZodType<CheckupView> = z.object({target:Target,name:z.string().optional(),review:z.object({title:z.string(),rows:z.array(z.object({key:z.string(),label:z.string(),detail:z.string(),grade:z.string()})),care:z.string(),status:z.string()}).optional(),profile:Profile.nullable(),attempt:Attempt.nullable(),suspectedChanged:z.boolean(),periodicProbe:z.boolean()})
export const CheckupEstimateSchema: z.ZodType<CheckupEstimate> = z.object({targetKey:z.string(),requests:z.number(),maxRequests:z.number(),inputTokens:z.number(),outputTokens:z.number(),windowKnown:z.boolean()})
export const CHECKUP_RESPONSES = {
  'GET /v1/checkup':CheckupViewSchema,
  'POST /v1/checkup/estimate':CheckupEstimateSchema,
  'POST /v1/checkup/run':CheckupViewSchema,
  'POST /v1/checkup/cancel':CheckupViewSchema,
  'POST /v1/checkup/settings':CheckupViewSchema,
}

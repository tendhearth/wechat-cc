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
export interface CheckupProfile {
  provider: string
  addressHash: string
  model: string
  windowTokens: number
  windowKnown: boolean
  reliableFillRatio: number
  stages: Array<{ fillRatio: number; accuracy: number }>
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
export interface CheckupView {
  target: CheckupTarget
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
const Profile = z.object({provider:z.string(),addressHash:z.string(),model:z.string(),windowTokens:z.number(),windowKnown:z.boolean(),reliableFillRatio:z.number(),stages:z.array(z.object({fillRatio:z.number(),accuracy:z.number()})),memory:z.enum(['good','fair','weak']),tools:z.enum(['stable','flaky']),toolAccuracy:z.number(),firstTextMedianMs:z.number().nullable(),completionMedianMs:z.number(),testedAt:z.string(),ccVersion:z.string(),short:z.boolean(),seed:z.number()})
const Attempt = z.object({status:z.enum(['running','completed','failed','cancelled']),completedRequests:z.number(),totalRequests:z.number(),startedAt:z.string(),finishedAt:z.string().optional(),errorCode:z.string().optional()})
export const CheckupViewSchema: z.ZodType<CheckupView> = z.object({target:Target,profile:Profile.nullable(),attempt:Attempt.nullable(),suspectedChanged:z.boolean(),periodicProbe:z.boolean()})
export const CheckupEstimateSchema: z.ZodType<CheckupEstimate> = z.object({targetKey:z.string(),requests:z.number(),maxRequests:z.number(),inputTokens:z.number(),outputTokens:z.number(),windowKnown:z.boolean()})
export const CHECKUP_RESPONSES = {
  'GET /v1/checkup':CheckupViewSchema,
  'POST /v1/checkup/estimate':CheckupEstimateSchema,
  'POST /v1/checkup/run':CheckupViewSchema,
  'POST /v1/checkup/cancel':CheckupViewSchema,
  'POST /v1/checkup/settings':CheckupViewSchema,
}

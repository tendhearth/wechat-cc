import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CheckupViewSchema, type CheckupAttempt, type CheckupProfile, type CheckupTarget, type ContextBudget } from '@wechat-cc/protocol'
import { DEFAULT_CHECKUP_WINDOW, DEFAULT_RELIABLE_FILL } from '../../domain/butler-checkup'
import { readJsonObject, updateJsonFile } from '../../lib/json-file'

export function checkupAddress(address: string): string {
  if (!address || address === 'default') return 'default'
  try { const url = new URL(address); return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}` } catch { return 'unknown' }
}
export const addressHash = (address: string): string => createHash('sha256').update(checkupAddress(address)).digest('hex')
export const checkupKey = (t: Pick<CheckupTarget,'provider'|'address'|'model'>): string => createHash('sha256').update(JSON.stringify([t.provider,addressHash(t.address),t.model])).digest('hex')
function validProfile(v: unknown): v is CheckupProfile {
  if (!v || typeof v !== 'object') return false
  const p = v as CheckupProfile
  return typeof p.provider === 'string' && typeof p.model === 'string' && typeof p.addressHash === 'string'
    && Number.isInteger(p.windowTokens) && p.windowTokens >= 1024 && Number.isFinite(p.reliableFillRatio) && p.reliableFillRatio >= 0 && p.reliableFillRatio <= .8
    && ['good','fair','weak'].includes(p.memory) && ['stable','flaky'].includes(p.tools)
    && Array.isArray(p.stages) && typeof p.testedAt === 'string' && Number.isFinite(Date.parse(p.testedAt))
}
export function makeCheckupStore(stateDir: string) {
  const profilesPath = join(stateDir,'checkup','profiles.json'), settingsPath = join(stateDir,'checkup','settings.json')
  return {
    attempt(target:CheckupTarget):CheckupAttempt|null {
      const value=readJsonObject(join(stateDir,'checkup','attempts.json'))[checkupKey(target)]
      // Reuse the wire validator; no arbitrary error text survives this boundary.
      const parsed=CheckupViewSchema.safeParse({target,profile:null,attempt:value,suspectedChanged:false,periodicProbe:false})
      return parsed.success?parsed.data.attempt:null
    },
    saveAttempt(target:CheckupTarget,attempt:CheckupAttempt) { updateJsonFile(join(stateDir,'checkup','attempts.json'), raw=>{raw[checkupKey(target)]=attempt}) },
    profile(target: CheckupTarget): CheckupProfile | null {
      const value=readJsonObject(profilesPath)[checkupKey(target)]
      const parsed=CheckupViewSchema.safeParse({target,profile:value,attempt:null,suspectedChanged:false,periodicProbe:false})
      const p=parsed.success?parsed.data.profile:null
      return validProfile(p) && p.provider === target.provider && p.model === target.model && p.addressHash === addressHash(target.address) ? p : null
    },
    save(target: CheckupTarget, profile: CheckupProfile) { updateJsonFile(profilesPath, raw => { raw[checkupKey(target)] = profile }) },
    readSettings() { return readJsonObject(settingsPath) },
    settings(periodicProbe: boolean) { updateJsonFile(settingsPath, raw => { raw.periodicProbe = periodicProbe }) },
    probe(target: CheckupTarget): { testedAt: string; lastAttemptAt?:string; suspectedChanged: boolean } | null {
      const p = readJsonObject(join(stateDir,'checkup','probes.json'))[checkupKey(target)] as {testedAt?:unknown;lastAttemptAt?:unknown;suspectedChanged?:unknown}|undefined
      return p && typeof p.testedAt === 'string' && typeof p.suspectedChanged === 'boolean' ? { testedAt:p.testedAt,...typeof p.lastAttemptAt==='string'?{lastAttemptAt:p.lastAttemptAt}:{}, suspectedChanged:p.suspectedChanged } : null
    },
    saveProbe(target: CheckupTarget, value: {testedAt:string;lastAttemptAt?:string;suspectedChanged:boolean}) { updateJsonFile(join(stateDir,'checkup','probes.json'), raw => { raw[checkupKey(target)] = value }) },
    contextBudgetFor(provider: string | CheckupTarget, model: string): ContextBudget {
      const t = typeof provider === 'string' ? null : { ...provider, model }
      const p = t ? this.profile(t) : null
      return p ? { windowTokens:p.windowTokens,reliableFillRatio:p.reliableFillRatio,source:'measured' } : { windowTokens:t?.windowTokens ?? DEFAULT_CHECKUP_WINDOW,reliableFillRatio:DEFAULT_RELIABLE_FILL,source:'default' }
    },
  }
}
export type CheckupStore = ReturnType<typeof makeCheckupStore>

import z from 'zod'
import type { Lang } from '../i18n'
import type { PairingRecord } from './pairing'

export const PAIRING_KEY = 'tendhearth.pairing.v1'
export const PREFS_KEY = 'tendhearth.prefs.v1'
export type Prefs = { lang: Lang | null }

export type SecureStoreLike = {
  getItemAsync(key: string, options?: any): Promise<string | null>
  setItemAsync(key: string, value: string, options?: any): Promise<void>
  deleteItemAsync(key: string, options?: any): Promise<void>
}
export interface CredentialStore {
  load(): Promise<PairingRecord | null>
  save(r: PairingRecord): Promise<void>
  /** 只清配对(撤销 / 解除配对);偏好留着。 */
  clear(): Promise<void>
  loadPrefs(): Promise<Prefs>
  savePrefs(p: Prefs): Promise<void>
}

const Pairing = z.object({
  v: z.literal(1),
  daemonId: z.string().min(1),
  relayHost: z.string().min(1),
  relayUrl: z.string().startsWith('wss://'),
  deviceToken: z.string().regex(/^d[0-9a-f]{48}$/),   // device-store.ts:'d' + 24 字节 hex
  deviceId: z.string().regex(/^[0-9a-f]{8}$/),
  pairedAt: z.number(),
})
const PrefsSchema = z.object({ lang: z.enum(['en', 'zh-Hans']).nullable() })

export function makeCredentialStore(ss: SecureStoreLike, opts: Record<string, unknown> = {}): CredentialStore {
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const next = tail.then(fn, fn); tail = next.catch(() => {}); return next }
  async function read(key: string): Promise<unknown> {
    const raw = await ss.getItemAsync(key, opts)
    if (raw === null) return undefined
    try { return JSON.parse(raw) } catch { return null }
  }
  return {
    load: () => serial(async () => {
      const v = await read(PAIRING_KEY)
      if (v === undefined) return null
      const p = Pairing.safeParse(v)
      if (p.success) return p.data
      await ss.deleteItemAsync(PAIRING_KEY, opts)
      return null
    }),
    save: r => serial(() => ss.setItemAsync(PAIRING_KEY, JSON.stringify(r), opts)),
    clear: () => serial(() => ss.deleteItemAsync(PAIRING_KEY, opts)),
    async loadPrefs() {
      const p = PrefsSchema.safeParse(await read(PREFS_KEY))
      return p.success ? p.data : { lang: null }
    },
    savePrefs: p => ss.setItemAsync(PREFS_KEY, JSON.stringify(p), opts),
  }
}

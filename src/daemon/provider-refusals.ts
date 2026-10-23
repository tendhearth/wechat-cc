/**
 * 执行者此刻是不是「真被拒着」(2026-10-23,主人拍板;真机抓包那天 agy 在当前出口地区每一轮都被拒):
 * 开机探测只跑 `--version`,所以健康页一直说 agy 好好的 —— 这是 CC 在说假话。
 *
 * 判法只看**真回合**(不另外外呼探测):
 *  - 一轮以 `region_unavailable` 结束 ⇒ 记下这一家「被拒着」+ 从什么时候;
 *  - 同一家之后有一轮**真的完成了** ⇒ 清掉。`--version` 通过、开机注册成功都不算恢复。
 * 记在状态目录一个小文件里(重启不忘;回合记录表没有错误码那一栏,不为这个加迁移)。读坏了当没记,不挡开机。
 */
import { join } from 'node:path'
import { readJsonObject, writeJsonAtomic } from '../lib/json-file'

export const PROVIDER_REFUSALS_FILE = 'provider-refusals.json'

/** 会记成「被拒着」的码。只放换一家 / 换出口才好的那种;额度、限流这类自己会好,不记。 */
const STICKY_CODES = new Set(['region_unavailable'])

export interface ProviderRefusal { code: string; since: string }

export interface ProviderRefusals {
  /** 每一轮结束调一次(coordinator 的 TurnRecord 形状里的这几栏)。 */
  onTurn(t: { provider: string; outcome: string; errorCode?: string; endedAt: number }): void
  get(provider: string): ProviderRefusal | null
  all(): Record<string, ProviderRefusal>
}

export function makeProviderRefusals(o: { stateDir: string; log: (tag: string, line: string) => void }): ProviderRefusals {
  const path = join(o.stateDir, PROVIDER_REFUSALS_FILE)
  let state: Record<string, ProviderRefusal> = {}
  try {
    for (const [k, v] of Object.entries(readJsonObject(path))) {
      const r = v as Partial<ProviderRefusal> | null
      if (r && typeof r.code === 'string' && typeof r.since === 'string') state[k] = { code: r.code, since: r.since }
    }
  } catch (err) { o.log('PROVIDER_REFUSALS', `unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`) }
  const save = () => { try { writeJsonAtomic(path, state, { mode: 0o600 }) } catch (err) { o.log('PROVIDER_REFUSALS', `write failed: ${err instanceof Error ? err.message : String(err)}`) } }
  return {
    onTurn(t) {
      if (t.outcome === 'completed') {
        if (!state[t.provider]) return
        const { [t.provider]: gone, ...rest } = state
        state = rest
        o.log('PROVIDER_REFUSALS', `${t.provider} recovered (a real turn completed; was ${gone!.code} since ${gone!.since})`)
        save()
        return
      }
      if (!t.errorCode || !STICKY_CODES.has(t.errorCode)) return
      if (state[t.provider]?.code === t.errorCode) return
      state = { ...state, [t.provider]: { code: t.errorCode, since: new Date(t.endedAt).toISOString() } }
      o.log('PROVIDER_REFUSALS', `${t.provider} marked ${t.errorCode}`)
      save()
    },
    get: (provider) => state[provider] ?? null,
    all: () => ({ ...state }),
  }
}

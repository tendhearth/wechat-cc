/**
 * 自动升级的状态:`<STATE_DIR>/cli-upgrade.json`。只有 daemon 写;`wechat-cc cli status` 只读。
 *
 * 记什么:每个 CLI 最近一次看到的版本、查最新的结果与退避、最近一次升级(前后版本、结果)、
 * 坏版本名单(known-bad:升级后自检没过、已退回的版本;更新的版本出来之前不再升到它)、
 * 当前版本的自检状态、已经通知过主人的事(同一件事只说一次)。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import { CLI_IDS, type CliId } from './specs'

export type VerifyState = 'ok' | 'failed' | 'unverified' | 'unknown'
export type UpgradeSource = 'scheduled' | 'reactive' | 'manual' | 'external'
export type UpgradeResult = 'upgraded' | 'noop' | 'failed' | 'rolled_back' | 'rollback_failed' | 'unverified'

export interface UpgradeRecord {
  from: string | null
  to: string | null
  at: string
  source: UpgradeSource
  result: UpgradeResult
  detail?: string
}

export interface CliState {
  /** 最近一次 `--version` 看到的版本(null = 没装 / 打不出来)。 */
  installed: string | null
  /** 已接受的版本:自检过了,或者是我们第一次见到时就在用的。外部换了版本(CLI 自己的后台升级器)靠它发现。 */
  accepted: string | null
  latest: string | null
  latestSource?: string
  lastCheckAt: string | null
  lastCheckError: string | null
  /** 连续查最新失败的次数 —— 退避用。 */
  checkFailures: number
  /** 退避:这个时刻之前不再出门查。 */
  nextCheckAt: string | null
  /** 本地日历日(YYYY-MM-DD):今天的定时检查做过了没有。 */
  lastScheduledDay: string | null
  /** 有一次升级在等空闲(检查发现了新版本 / 报错触发)。 */
  pending: UpgradeSource | null
  /** 报错触发的检查:等下一拍去查(去抖后)。 */
  reactiveAt: string | null
  verify: VerifyState
  verifyDetail?: string
  /** 自检被网络守护挡下 ⇒ 稍后重试,这是上次试的时间。 */
  verifyAttemptAt?: string | null
  /** 当前这个未验证版本是从哪个版本换过来的(自检失败时退回它)。 */
  rollbackTo?: string | null
  lastUpgrade: UpgradeRecord | null
  knownBad: string[]
  notified: string[]
}

export type CliUpgradeState = Record<CliId, CliState>

export function emptyCliState(): CliState {
  return {
    installed: null, accepted: null, latest: null, lastCheckAt: null, lastCheckError: null,
    checkFailures: 0, nextCheckAt: null, lastScheduledDay: null, pending: null, reactiveAt: null,
    verify: 'unknown', lastUpgrade: null, knownBad: [], notified: [],
  }
}

const FILE = 'cli-upgrade.json'

export interface StateStore {
  load(): CliUpgradeState
  save(s: CliUpgradeState): void
}

function normalize(raw: unknown): CliUpgradeState {
  const out = {} as CliUpgradeState
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const id of CLI_IDS) {
    const r = (obj[id] && typeof obj[id] === 'object' ? obj[id] : {}) as Partial<CliState>
    const base = emptyCliState()
    out[id] = {
      ...base,
      ...r,
      knownBad: Array.isArray(r.knownBad) ? r.knownBad.filter((x): x is string => typeof x === 'string') : [],
      notified: Array.isArray(r.notified) ? r.notified.filter((x): x is string => typeof x === 'string').slice(-50) : [],
      checkFailures: typeof r.checkFailures === 'number' && r.checkFailures >= 0 ? r.checkFailures : 0,
    }
  }
  return out
}

export function makeFileStateStore(stateDir: string): StateStore {
  const path = join(stateDir, FILE)
  return {
    load() {
      try { return normalize(readJsonFile(path)) } catch { return normalize({}) }
    },
    save(s) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

export function makeMemoryStateStore(initial?: unknown): StateStore & { snapshot(): CliUpgradeState } {
  let s = normalize(initial ?? {})
  return {
    load: () => normalize(JSON.parse(JSON.stringify(s))),
    save: (n) => { s = normalize(JSON.parse(JSON.stringify(n))) },
    snapshot: () => s,
  }
}

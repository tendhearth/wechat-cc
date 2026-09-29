/**
 * 随身 CC 的长期设备令牌:落盘与注册表同步(梳理第 6 步,2026-09-29)。
 *
 * 文件仍是 `<stateDir>/settings-devices.json`(0600,上限 20 台),形状升级成
 * `{ "<token>": { id, created_at, last_seen_at, label? } }`;读到旧格式
 * (`{ "<token>": { created_at } }`)原地补齐。`id` = sha256(token) 前 8 位 hex ——
 * 撤销与展示都用它,秘钥本身不出现在界面和日志里。
 *
 * 设备令牌永不过期(导图 [定]:加主屏后一直能用),但能按台撤销。文件与内部 API 的
 * token-registry 的同步只在 `makeDeviceCredentials` 一处:面板与隧道都只认它。
 */
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'
import type { PanelTokens } from './internal-api/token-registry'

const DEVICES_FILE = 'settings-devices.json'
const MAX_DEVICES = 20
const TOUCH_WRITE_INTERVAL_MS = 5 * 60_000
const MAX_LABEL = 24

export interface DeviceRow { id: string; created_at: string; last_seen_at: string; label?: string }
type Stored = { id?: string; created_at: string; last_seen_at?: string; label?: string }

export interface DeviceStore {
  list(): DeviceRow[]
  tokens(): string[]
  pair(): { token: string; id: string } | null
  /** 返回被删的 token(调用方拿去撤注册表);不存在 ⇒ null。 */
  revoke(id: string): string | null
  /** 返回被删的全部 token。 */
  forgetAll(): string[]
  touch(id: string): void
  label(id: string, text: string): boolean
  idOf(token: string): string | null
}

export const deviceIdOf = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 8)
export const deviceSessionKey = (id: string): string => `device:${id}`

function cleanLabel(text: string): string {
  // eslint-disable-next-line no-control-regex
  return [...text.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, MAX_LABEL).join('')
}

export function makeDeviceStore(stateDir: string, now: () => number = () => Date.now()): DeviceStore {
  const path = join(stateDir, DEVICES_FILE)
  const lastWrite = new Map<string, number>()

  const read = (): Record<string, Stored> => {
    let raw: Record<string, Stored>
    try { raw = readJsonFile(path) as Record<string, Stored> } catch { return {} }
    if (!raw || typeof raw !== 'object') return {}
    let upgraded = false
    for (const [tok, row] of Object.entries(raw)) {
      if (!row || typeof row !== 'object' || typeof row.created_at !== 'string') { delete raw[tok]; upgraded = true; continue }
      if (!row.id) { row.id = deviceIdOf(tok); upgraded = true }
      if (!row.last_seen_at) { row.last_seen_at = row.created_at; upgraded = true }
    }
    if (upgraded) write(raw)
    return raw
  }
  const write = (rows: Record<string, Stored>) => {
    writeFileSync(path, JSON.stringify(rows, null, 2), { mode: 0o600 })
  }
  const toRow = (r: Stored): DeviceRow => {
    const row: DeviceRow = { id: r.id!, created_at: r.created_at, last_seen_at: r.last_seen_at! }
    if (r.label) row.label = r.label
    return row
  }
  const tokenFor = (rows: Record<string, Stored>, id: string) => Object.keys(rows).find(t => rows[t]!.id === id) ?? null

  return {
    list: () => Object.values(read()).map(toRow),
    tokens: () => Object.keys(read()),
    pair() {
      const rows = read()
      if (Object.keys(rows).length >= MAX_DEVICES) return null
      const token = 'd' + randomBytes(24).toString('hex')
      const id = deviceIdOf(token)
      const at = new Date(now()).toISOString()
      rows[token] = { id, created_at: at, last_seen_at: at }
      write(rows)
      return { token, id }
    },
    revoke(id) {
      const rows = read()
      const tok = tokenFor(rows, id)
      if (!tok) return null
      delete rows[tok]
      write(rows)
      lastWrite.delete(id)
      return tok
    },
    forgetAll() {
      const toks = Object.keys(read())
      write({})
      lastWrite.clear()
      return toks
    },
    touch(id) {
      const at = now()
      const prev = lastWrite.get(id)
      if (prev !== undefined && at - prev < TOUCH_WRITE_INTERVAL_MS) return
      const rows = read()
      const tok = tokenFor(rows, id)
      if (!tok) return
      rows[tok]!.last_seen_at = new Date(at).toISOString()
      write(rows)
      lastWrite.set(id, at)
    },
    label(id, text) {
      const rows = read()
      const tok = tokenFor(rows, id)
      if (!tok) return false
      const clean = cleanLabel(text)
      if (clean) rows[tok]!.label = clean
      else delete rows[tok]!.label
      write(rows)
      return true
    },
    idOf(token) {
      return read()[token]?.id ?? null
    },
  }
}

export interface DeviceCredentials {
  bootRegister(): void
  pair(): { token: string; id: string } | null
  revoke(id: string): boolean
  forgetAll(): void
  touch(id: string): void
  label(id: string, text: string): boolean
  list(): DeviceRow[]
  tokens(): string[]
}

/** 文件与注册表同时改的唯一一处。 */
export function makeDeviceCredentials(deps: { store: DeviceStore; tokens: PanelTokens; routeAllow: ReadonlySet<string> }): DeviceCredentials {
  const { store, tokens, routeAllow } = deps
  const register = (token: string, id: string) =>
    tokens.register(token, { tier: 'admin', origin: 'device', sessionKey: deviceSessionKey(id), routeAllow })
  return {
    bootRegister() {
      for (const token of store.tokens()) {
        const id = store.idOf(token)
        if (id) register(token, id)
      }
    },
    pair() {
      const got = store.pair()
      if (got) register(got.token, got.id)
      return got
    },
    revoke(id) {
      const tok = store.revoke(id)
      if (!tok) return false
      tokens.invalidateSession(deviceSessionKey(id))
      return true
    },
    forgetAll() {
      const ids = store.list().map(r => r.id)
      store.forgetAll()
      for (const id of ids) tokens.invalidateSession(deviceSessionKey(id))
    },
    touch: (id) => store.touch(id),
    label: (id, text) => store.label(id, text),
    list: () => store.list(),
    tokens: () => store.tokens(),
  }
}

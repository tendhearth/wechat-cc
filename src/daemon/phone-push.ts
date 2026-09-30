/**
 * phone-push.ts — daemon 这头的推送(spec 2026-09-30 §5)。
 *
 * 登记:手机经端到端隧道 POST /m/api/push/register 把 APNs / FCM token 交给自己的 daemon;这里落盘
 * `<stateDir>/phone-push.json`(0600)并经已登录的中继 socket 发 `{push_reg}`。每次登录(onLogin)
 * 都 resync 一遍:中继换过(staging → 生产)、或房间存储丢了也能自愈;顺手修剪已撤销的设备。
 *
 * 发送:用该设备的推送密钥(derivePushKey(设备令牌),子项目 1)把 `{ts,kind,title,body,taskId}`
 * sealPush,交给房间转 APNs / FCM。中继与苹果谷歌只看得到密文。
 *
 * 结果:房间回 `{push_result:{…,ref}}`,按 ref 结清等待者(test() 用);`{push_invalid}` ⇒ 删本地登记。
 */
import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { derivePushKey, pushTokenValid, sealPush, type PushPlatformT } from '@wechat-cc/protocol'
import { readJsonFile } from '../lib/read-json-file'

export type PushKind = 'permission' | 'question' | 'task_done' | 'task_failed' | 'test'
export interface PushPayload { kind: PushKind; title: string; body: string; taskId?: string }

export interface PhonePush {
  register(deviceId: string, platform: PushPlatformT, token: string): boolean
  unregister(deviceId: string): void
  forgetAll(): void
  registered(): string[]
  resync(): void
  notify(deviceId: string, p: PushPayload): boolean
  test(deviceId: string): Promise<{ ok: boolean; code: string }>
  onControl(msg: Record<string, unknown>): void
}

type Row = { platform: PushPlatformT; token: string; at: number }
const FILE = 'phone-push.json'
const TITLE_MAX = 60
const BODY_MAX = 300
const clip = (s: string, n: number) => [...s].slice(0, n).join('')

export function makePhonePush(deps: {
  stateDir: string
  send(msg: object): boolean
  deviceToken(deviceId: string): string | null
  deviceIds(): string[]
  onChange?: () => void
  now?: () => number
  resultTimeoutMs?: number
  log: (tag: string, line: string) => void
}): PhonePush {
  const path = join(deps.stateDir, FILE)
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.resultTimeoutMs ?? 15_000
  const pending = new Map<string, (r: { ok: boolean; code: string }) => void>()
  let refSeq = 0

  const read = (): Record<string, Row> => {
    try { const r = readJsonFile(path) as Record<string, Row>; return r && typeof r === 'object' ? r : {} } catch { return {} }
  }
  const write = (rows: Record<string, Row>) => {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  }
  const changed = () => { try { deps.onChange?.() } catch { /* 通知方自己的事 */ } }

  function drop(deviceId: string, tellRelay: boolean): void {
    const rows = read()
    if (!rows[deviceId]) return
    delete rows[deviceId]
    write(rows)
    if (tellRelay) deps.send({ push_unreg: { device: deviceId } })
    changed()
  }

  function sendPush(deviceId: string, p: PushPayload): string | null {
    if (!read()[deviceId]) return null
    const token = deps.deviceToken(deviceId)
    if (!token) { drop(deviceId, true); return null }
    const payload = { ts: now(), kind: p.kind, title: clip(p.title, TITLE_MAX), body: clip(p.body, BODY_MAX), ...(p.taskId ? { taskId: p.taskId } : {}) }
    const ref = `p${(refSeq++).toString(36)}${randomBytes(3).toString('hex')}`
    const ok = deps.send({ push: { device: deviceId, sealed: sealPush(derivePushKey(token), payload), collapseId: p.taskId ?? p.kind, ref } })
    return ok ? ref : ''
  }

  return {
    register(deviceId, platform, token) {
      if (!pushTokenValid(platform, token)) return false
      const rows = read()
      rows[deviceId] = { platform, token, at: now() }
      write(rows)
      deps.send({ push_reg: { device: deviceId, platform, token } })
      changed()
      return true
    },
    unregister(deviceId) { drop(deviceId, true) },
    forgetAll() {
      const rows = read()
      for (const id of Object.keys(rows)) deps.send({ push_unreg: { device: id } })
      write({})
      if (Object.keys(rows).length) changed()
    },
    registered: () => Object.keys(read()),
    resync() {
      const live = new Set(deps.deviceIds())
      const rows = read()
      let pruned = false
      for (const id of Object.keys(rows)) {
        if (live.has(id)) continue
        delete rows[id]
        deps.send({ push_unreg: { device: id } })
        pruned = true
      }
      if (pruned) { write(rows); changed() }
      for (const [id, r] of Object.entries(rows)) deps.send({ push_reg: { device: id, platform: r.platform, token: r.token } })
    },
    notify(deviceId, p) {
      const ref = sendPush(deviceId, p)
      return !!ref
    },
    test(deviceId) {
      const ref = sendPush(deviceId, { kind: 'test', title: 'CC', body: '这是一条测试通知' })
      if (ref === null) return Promise.resolve({ ok: false, code: 'not_registered' })
      if (ref === '') return Promise.resolve({ ok: false, code: 'relay_offline' })
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(ref); resolve({ ok: false, code: 'timeout' }) }, timeoutMs)
        pending.set(ref, (r) => { clearTimeout(timer); pending.delete(ref); resolve(r) })
      })
    },
    onControl(msg) {
      const r = msg.push_result as { device?: string; ok?: boolean; code?: string; ref?: string } | undefined
      if (r && typeof r.ok === 'boolean' && typeof r.code === 'string') {
        if (!r.ok) deps.log('PUSH', `push to ${r.device} failed: ${r.code}`)
        if (typeof r.ref === 'string') pending.get(r.ref)?.({ ok: r.ok, code: r.code })
        return
      }
      const inv = msg.push_invalid as { device?: string } | undefined
      if (inv && typeof inv.device === 'string') {
        deps.log('PUSH', `push token for ${inv.device} is no longer valid — unregistered`)
        drop(inv.device, false)
      }
    },
  }
}

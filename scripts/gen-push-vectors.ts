/**
 * gen-push-vectors.ts — 生成 packages/protocol/vectors/push.json。
 * 顶层 deviceToken/key/iv/payload/ct 是回归钉子(保持不变);cases 是 Swift / Kotlin
 * 解密实现的验收用例。运行:bun scripts/gen-push-vectors.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { derivePushKey, sealPush, b64uEncode, b64uDecode, PushPlaintext, pushDedupeKey, PUSH_DEDUPE_CAPACITY, PUSH_DEDUPE_TTL_MS } from '../packages/protocol/src/index'

const path = new URL('../packages/protocol/vectors/push.json', import.meta.url)
const old = JSON.parse(readFileSync(path, 'utf8'))
const deviceToken: string = old.deviceToken
const key = derivePushKey(deviceToken)
const iv = (n: number) => Uint8Array.from({ length: 12 }, (_, i) => (n + i) & 0xff)
const NOW = 1_700_000_000_000
const MIN = 60_000

const full = { ts: NOW - 1000, kind: 'permission', title: '需要你批准', body: '任务「整理下载文件夹」想执行一条命令', taskId: 't-42', requestId: 'r-7' }
// ok 用例的载荷必须过 PushPlaintext(原生端照着它写解析),kind 只用协议包里的 PushKind。
const late = { ts: NOW - 50 * MIN, kind: 'task_done', title: '任务完成了', body: '整理下载文件夹' }
PushPlaintext.parse(full)
PushPlaintext.parse(late)
const seal = (payload: { ts: number; [k: string]: unknown }, n: number) => sealPush(key, payload, iv(n))

// 能解开、但明文不合 PushPlaintext(kind 不认识)⇒ 原生端必须按「解不开」处理(显示占位)。
const badKind = { ts: NOW - 2000, kind: 'approval_needed', title: 'x', body: 'y' }

const tampered = seal({ ts: NOW }, 5)
const ctBytes = b64uDecode(tampered.ct)
ctBytes[0] = ctBytes[0]! ^ 0x01

const okFull = seal(full, 1)
const okLate = seal(late, 2)
const cases = [
  { name: 'ok', now: NOW, sealed: okFull, expect: 'ok', payload: full, dedupeKey: pushDedupeKey(full.ts, okFull.ct) },
  { name: 'ok-late-50min', now: NOW, sealed: okLate, expect: 'ok', payload: late, dedupeKey: pushDedupeKey(late.ts, okLate.ct) },
  { name: 'stale-past-61min', now: NOW, sealed: seal({ ts: NOW - 61 * MIN }, 3), expect: 'stale' },
  { name: 'stale-future-11min', now: NOW, sealed: seal({ ts: NOW + 11 * MIN }, 4), expect: 'stale' },
  { name: 'auth-wrong-key', wrongKey: true, now: NOW, sealed: seal({ ts: NOW }, 5), expect: 'auth' },
  { name: 'auth-tampered', now: NOW, sealed: { ...tampered, ct: b64uEncode(ctBytes) }, expect: 'auth' },
  { name: 'malformed-v2', now: NOW, sealed: { ...seal({ ts: NOW }, 6), v: 2 }, expect: 'malformed' },
  { name: 'invalid-kind', now: NOW, sealed: seal(badKind, 7), expect: 'invalid' },
]
const k1 = pushDedupeKey(full.ts, okFull.ct)
const k2 = pushDedupeKey(late.ts, okLate.ct)
const dedupe = {
  capacity: PUSH_DEDUPE_CAPACITY,
  ttlMs: PUSH_DEDUPE_TTL_MS,
  steps: [
    { key: k1, now: NOW, expect: 'new', note: '第一次见到 ok' },
    { key: k2, now: NOW, expect: 'new', note: '另一条' },
    { key: k1, now: NOW + 1000, expect: 'duplicate', note: 'APNs / FCM 重投同一条' },
    { key: k1, now: NOW + PUSH_DEDUPE_TTL_MS + 1, expect: 'new', note: '超过保留时长后被修剪' },
  ],
}

const out = {
  ...old,
  _generatedBy: String(old._generatedBy).replace(/ cases (与 dedupe )?是 Swift.*$/, '') + ' cases 与 dedupe 是 Swift / Kotlin 解密实现的验收用例(wrongKey 用 deviceToken+"x" 推导的密钥;expect=invalid ⇒ 能解开但明文不合 PushPlaintext)。',
  cases,
  dedupe,
}
writeFileSync(path, JSON.stringify(out, null, 2) + '\n')

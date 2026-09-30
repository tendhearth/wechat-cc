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
type Step = { key: string; now: number; expect: 'new' | 'duplicate'; note: string }
const pad = (p: string, i: number) => `${p}${String(i).padStart(3, '0')}`
const T0 = NOW + 10 * PUSH_DEDUPE_TTL_MS   // 远超前面步骤的条目,保证它们都被修剪
const T1 = T0 + 10 * PUSH_DEDUPE_TTL_MS
const T2 = T1 + 10 * PUSH_DEDUPE_TTL_MS
const steps: Step[] = [
  { key: k1, now: NOW, expect: 'new', note: '第一次见到 ok' },
  { key: k2, now: NOW, expect: 'new', note: '另一条' },
  { key: k1, now: NOW + 1000, expect: 'duplicate', note: 'APNs / FCM 重投同一条' },
  { key: k1, now: NOW + PUSH_DEDUPE_TTL_MS + 1, expect: 'new', note: '超过保留时长后被修剪' },
  // 边界:修剪是严格的(now - at > ttl);重复命中不刷新记下的时刻
  { key: 'edge', now: T0, expect: 'new', note: '边界:记下,at = T0(此前的条目都已被修剪)' },
  { key: 'edge', now: T0 + PUSH_DEDUPE_TTL_MS, expect: 'duplicate', note: '边界:正好 at + ttlMs ⇒ 还留着(修剪严格大于)' },
  { key: 'edge', now: T0 + PUSH_DEDUPE_TTL_MS + 1, expect: 'new', note: '边界:重复命中不刷新 at,所以 at + ttlMs + 1 已被修剪 ⇒ new' },
  // 容量:64 个互异键各不同时刻,第 65 个挤掉记下时刻最早的
  ...Array.from({ length: PUSH_DEDUPE_CAPACITY }, (_, i): Step => ({ key: pad('k', i), now: T1 + i, expect: 'new', note: i === 0 ? '容量:填满 64 条(k000 最早)' : `容量:第 ${i + 1} 条` })),
  { key: 'k-new', now: T1 + 100, expect: 'new', note: '容量:第 65 条,k000(记下时刻最早)被挤掉' },
  { key: pad('k', 32), now: T1 + 101, expect: 'duplicate', note: '容量:中段的键还在' },
  { key: pad('k', 0), now: T1 + 102, expect: 'new', note: '容量:被挤掉的 k000 又算 new(它再入会挤掉 k001)' },
  { key: pad('k', 1), now: T1 + 103, expect: 'new', note: '容量:k001 被上一步挤掉 ⇒ new' },
  // 同一时刻平局:按键名升序挤;挤出发生在插入之后
  ...Array.from({ length: PUSH_DEDUPE_CAPACITY }, (_, i): Step => ({ key: pad('t', i), now: T2, expect: 'new', note: i === 0 ? '平局:64 条同一时刻 T2' : `平局:第 ${i + 1} 条` })),
  { key: 't-new', now: T2, expect: 'new', note: '平局:第 65 条,键名 "t-new" < "t000"(按 UTF-8 / 码点升序,"-" < "0"),它自己被立刻挤掉但仍返回 new' },
  { key: 't-new', now: T2, expect: 'new', note: '平局:t-new 已不在 ⇒ 再来仍是 new(挤出在插入之后)' },
  { key: pad('t', 0), now: T2, expect: 'duplicate', note: '平局:t000 没被挤掉' },
  { key: 'old', now: T2 - 1, expect: 'new', note: '比所有条目都老的新键:插入后立刻被挤掉,仍返回 new' },
  { key: 'old', now: T2 - 1, expect: 'new', note: '同上:再来仍是 new' },
  { key: 'z-new', now: T2, expect: 'new', note: '平局:第 65 条,键名最大,挤掉键名最小的 t000' },
  { key: pad('t', 1), now: T2, expect: 'duplicate', note: '平局:t001 还在' },
  { key: pad('t', 0), now: T2, expect: 'new', note: '平局:t000 已被挤掉 ⇒ new(再入后它又是键名最小,又被挤掉)' },
]
const dedupe = {
  capacity: PUSH_DEDUPE_CAPACITY,
  ttlMs: PUSH_DEDUPE_TTL_MS,
  rules: 'seen(key, now):(1) 先修剪:记下时刻 at 满足 now - at > ttlMs(严格大于)的条目删除,正好等于 ttlMs 的保留;(2) 键已存在 ⇒ duplicate,且不刷新记下的时刻;(3) 否则以 now 记下,然后(插入之后)若条目数 > capacity,反复删除记下时刻最小的条目,时刻相同按键名(UTF-8 / 码点)升序先删——新键若恰是最老或键名最小的也会被立刻删掉,但本次仍返回 new。类型:now、ts、ttlMs、记下时刻都是 epoch 毫秒的 64 位整数(Swift Int64 / Kotlin Long),capacity 是 Int。dedupeKey 的 ts 先向下取整再按十进制整数格式化(不带小数点、不带指数)。',
  steps,
}
const dedupeKeyCases = [
  { ts: 1_700_000_000_123, ct: 'abc', key: pushDedupeKey(1_700_000_000_123, 'abc'), note: '整数 ts' },
  { ts: 1_700_000_000_123.9, ct: 'abc', key: pushDedupeKey(1_700_000_000_123.9, 'abc'), note: '小数 ts:先向下取整,格式化成普通整数,与整数 ts 同键' },
  { ts: 1_700_000_000_123, ct: 'abd', key: pushDedupeKey(1_700_000_000_123, 'abd'), note: 'ct 不同 ⇒ 键不同' },
]

const out = {
  ...old,
  _generatedBy: String(old._generatedBy).replace(/ cases (与 dedupe )?是 Swift.*$/, '') + ' cases 与 dedupe 是 Swift / Kotlin 解密实现的验收用例(wrongKey 用 deviceToken+"x" 推导的密钥;expect=invalid ⇒ 能解开但明文不合 PushPlaintext)。',
  cases,
  dedupe,
  dedupeKeyCases,
}
writeFileSync(path, JSON.stringify(out, null, 2) + '\n')

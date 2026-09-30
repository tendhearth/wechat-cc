/**
 * gen-push-vectors.ts — 生成 packages/protocol/vectors/push.json。
 * 顶层 deviceToken/key/iv/payload/ct 是回归钉子(保持不变);cases 是 Swift / Kotlin
 * 解密实现的验收用例。运行:bun scripts/gen-push-vectors.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { derivePushKey, sealPush, b64uEncode, b64uDecode, PushPlaintext } from '../packages/protocol/src/index'

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

const tampered = seal({ ts: NOW }, 5)
const ctBytes = b64uDecode(tampered.ct)
ctBytes[0] = ctBytes[0]! ^ 0x01

const cases = [
  { name: 'ok', now: NOW, sealed: seal(full, 1), expect: 'ok', payload: full },
  { name: 'ok-late-50min', now: NOW, sealed: seal(late, 2), expect: 'ok', payload: late },
  { name: 'stale-past-61min', now: NOW, sealed: seal({ ts: NOW - 61 * MIN }, 3), expect: 'stale' },
  { name: 'stale-future-11min', now: NOW, sealed: seal({ ts: NOW + 11 * MIN }, 4), expect: 'stale' },
  { name: 'auth-wrong-key', wrongKey: true, now: NOW, sealed: seal({ ts: NOW }, 5), expect: 'auth' },
  { name: 'auth-tampered', now: NOW, sealed: { ...tampered, ct: b64uEncode(ctBytes) }, expect: 'auth' },
  { name: 'malformed-v2', now: NOW, sealed: { ...seal({ ts: NOW }, 6), v: 2 }, expect: 'malformed' },
]

const out = {
  ...old,
  _generatedBy: String(old._generatedBy).replace(/ cases 是 Swift.*$/, '') + ' cases 是 Swift / Kotlin 解密实现的验收用例(wrongKey 用 deviceToken+"x" 推导的密钥)。',
  cases,
}
writeFileSync(path, JSON.stringify(out, null, 2) + '\n')

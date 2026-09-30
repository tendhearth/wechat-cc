/**
 * push.test.ts — 推送密钥推导 + 密封载荷。
 *
 * 向量在 `packages/protocol/vectors/push.json`:跟 v2 一样是**这份实现自己
 * 生成的回归钉子**(固定 deviceToken/iv/载荷 ⇒ 固定密钥与密文),不是跨实现
 * 兼容向量。
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { gcm } from '@noble/ciphers/aes.js'
import { b64uEncode, b64uDecode } from './b64u'
import { derivePushKey, sealPush, openPush, PushPlaintext, PushKind, pushDedupeKey, makePushDedupe, PUSH_DEDUPE_CAPACITY, PUSH_DEDUPE_TTL_MS } from './push'
import type { SealedPush } from './push'
import { deriveV1Key } from './v1'
import { deriveV2Keys } from './v2'
import * as index from './index'
import vectorsFile from '../vectors/push.json'

interface VectorFile {
  deviceToken: string
  key: string
  iv: string
  payload: { ts: number; [k: string]: unknown }
  ct: string
}

const vector = vectorsFile as VectorFile

describe('derivePushKey', () => {
  it('返回 32 字节', () => {
    expect(derivePushKey('some-device-token')).toHaveLength(32)
  })

  it('不同令牌 ⇒ 不同密钥', () => {
    const a = derivePushKey('device-token-a')
    const b = derivePushKey('device-token-b')
    expect(a).not.toEqual(b)
  })

  it('同一令牌 ⇒ 同一密钥(确定性推导)', () => {
    const a = derivePushKey('same-token')
    const b = derivePushKey('same-token')
    expect(a).toEqual(b)
  })

  it('推送密钥跟隧道 v1 / v2 密钥都不相等(同一个「令牌当共享秘密」场景下)', () => {
    // 把同一个字节串既当 v1/v2 的 shared secret,又当 push 的 deviceToken —— 验证
    // 三条 HKDF info 命名空间的分隔起了作用,不是意外撞上同一把密钥。
    const shared = new TextEncoder().encode('token-reused-as-shared-secret')
    const bind = 'bind-token'

    const pushKey = derivePushKey('token-reused-as-shared-secret')
    const v1Key = deriveV1Key(shared, bind)
    const { c2s, s2c } = deriveV2Keys(shared, bind)

    expect(b64uEncode(pushKey)).not.toBe(b64uEncode(v1Key))
    expect(b64uEncode(pushKey)).not.toBe(b64uEncode(c2s))
    expect(b64uEncode(pushKey)).not.toBe(b64uEncode(s2c))
    // 顺带确认这三把本来就互不相同(不是巧合地只跟 push 不一样)。
    expect(b64uEncode(v1Key)).not.toBe(b64uEncode(c2s))
    expect(b64uEncode(v1Key)).not.toBe(b64uEncode(s2c))
    expect(b64uEncode(c2s)).not.toBe(b64uEncode(s2c))
  })

  it('回归向量:固定 deviceToken 推出的密钥跟提交的 vectors/push.json 一致', () => {
    const key = derivePushKey(vector.deviceToken)
    expect(b64uEncode(key)).toBe(vector.key)
  })
})

describe('sealPush / openPush:往返', () => {
  it('sealPush → openPush 还原载荷', () => {
    const key = derivePushKey('roundtrip-token')
    const now = 1_700_000_500_000
    const payload = { ts: now, kind: 'task_finished', taskId: 't-1' }
    const sealed = sealPush(key, payload)
    expect(openPush(key, sealed, now)).toEqual(payload)
  })

  it('sealed.v === 1,iv/ct 是 base64url 字符串', () => {
    const key = derivePushKey('shape-token')
    const sealed = sealPush(key, { ts: Date.now() })
    expect(sealed.v).toBe(1)
    expect(typeof sealed.iv).toBe('string')
    expect(typeof sealed.ct).toBe('string')
    expect(sealed.iv).not.toContain('=')
    expect(sealed.ct).not.toContain('=')
  })

  it('不传 iv 时随机生成 12 字节 nonce,两次 seal 的 iv 不同', () => {
    const key = derivePushKey('random-iv-token')
    const now = Date.now()
    const a = sealPush(key, { ts: now })
    const b = sealPush(key, { ts: now })
    expect(a.iv).not.toBe(b.iv)
    expect(b64uDecode(a.iv)).toHaveLength(12)
  })

  it('传入 iv 时确定性输出(跟回归向量的 ct 一致)', () => {
    const key = derivePushKey(vector.deviceToken)
    const sealed = sealPush(key, vector.payload, b64uDecode(vector.iv))
    expect(sealed.iv).toBe(vector.iv)
    expect(sealed.ct).toBe(vector.ct)
  })

  it('回归向量:openPush 用提交的密钥/iv/ct 还原提交的载荷', () => {
    const key = b64uDecode(vector.key)
    const sealed: SealedPush = { v: 1, iv: vector.iv, ct: vector.ct }
    expect(openPush(key, sealed, vector.payload.ts)).toEqual(vector.payload)
  })
})

describe('openPush:篡改与畸形输入 ⇒ 抛错', () => {
  function freshSealed() {
    const key = derivePushKey('tamper-token')
    const now = 1_700_000_000_000
    const payload = { ts: now, kind: 'approval_needed' }
    return { key, now, sealed: sealPush(key, payload) }
  }

  it('篡改密文一位 ⇒ 抛错(GCM 认证失败)', () => {
    const { key, now, sealed } = freshSealed()
    const ctBytes = b64uDecode(sealed.ct)
    ctBytes[ctBytes.length - 1] = (ctBytes[ctBytes.length - 1]! ^ 0xff) & 0xff
    const tampered: SealedPush = { v: 1, iv: sealed.iv, ct: b64uEncode(ctBytes) }
    expect(() => openPush(key, tampered, now)).toThrow()
  })

  it('篡改 iv 一位 ⇒ 抛错', () => {
    const { key, now, sealed } = freshSealed()
    const ivBytes = b64uDecode(sealed.iv)
    ivBytes[0] = (ivBytes[0]! ^ 0xff) & 0xff
    const tampered: SealedPush = { v: 1, iv: b64uEncode(ivBytes), ct: sealed.ct }
    expect(() => openPush(key, tampered, now)).toThrow()
  })

  it('换一把密钥 open ⇒ 抛错', () => {
    const { now, sealed } = freshSealed()
    const wrongKey = derivePushKey('a-different-token')
    expect(() => openPush(wrongKey, sealed, now)).toThrow()
  })

  it('sealed 不是对象(null / 字符串 / 数组)⇒ 抛错', () => {
    const key = derivePushKey('shape-token')
    expect(() => openPush(key, null as unknown as SealedPush, Date.now())).toThrow()
    expect(() => openPush(key, 'nope' as unknown as SealedPush, Date.now())).toThrow()
    expect(() => openPush(key, [1, 2, 3] as unknown as SealedPush, Date.now())).toThrow()
  })

  it('v !== 1 ⇒ 抛错', () => {
    const { key, now, sealed } = freshSealed()
    const bad = { ...sealed, v: 2 } as unknown as SealedPush
    expect(() => openPush(key, bad, now)).toThrow()
  })

  it('iv/ct 不是字符串 ⇒ 抛错', () => {
    const { key, now, sealed } = freshSealed()
    expect(() => openPush(key, { ...sealed, iv: 42 } as unknown as SealedPush, now)).toThrow()
    expect(() => openPush(key, { ...sealed, ct: null } as unknown as SealedPush, now)).toThrow()
  })

  it('iv/ct 不是合法 base64url ⇒ 抛错', () => {
    const { key, now, sealed } = freshSealed()
    expect(() => openPush(key, { ...sealed, iv: '!!!not-b64!!!' }, now)).toThrow()
    expect(() => openPush(key, { ...sealed, ct: '???' }, now)).toThrow()
  })

  it('解出来的明文不是 JSON 对象(数组/字符串/数字)⇒ 抛错', () => {
    const key = derivePushKey('non-object-plaintext-token')
    for (const badPayload of ['"just a string"', '[1,2,3]', '42', 'null']) {
      const iv = b64uDecode('AAECAwQFBgcICQoL')
      const ct = b64uEncode(gcmEncryptRaw(key, iv, badPayload))
      const sealed: SealedPush = { v: 1, iv: b64uEncode(iv), ct }
      expect(() => openPush(key, sealed, Date.now())).toThrow()
    }
  })

  it('明文是 JSON 对象但缺 ts ⇒ 抛错', () => {
    const key = derivePushKey('missing-ts-token')
    const iv = b64uDecode('AAECAwQFBgcICQoL')
    const ct = b64uEncode(gcmEncryptRaw(key, iv, JSON.stringify({ kind: 'x' })))
    const sealed: SealedPush = { v: 1, iv: b64uEncode(iv), ct }
    expect(() => openPush(key, sealed, Date.now())).toThrow()
  })

  it('ts 不是有限数字(NaN/Infinity/字符串)⇒ 抛错', () => {
    const key = derivePushKey('nonfinite-ts-token')
    // JSON 没有 NaN/Infinity 字面量,用会解析成 Infinity 的数值字面量('1e999')
    // 和字符串/ null 两种畸形 ts 分支一起触发「不是有限数字」这条检查。
    for (const badTs of ['"not-a-number"', 'null', '1e999']) {
      const iv = b64uDecode('AAECAwQFBgcICQoL')
      const ct = b64uEncode(gcmEncryptRaw(key, iv, `{"ts":${badTs}}`))
      const sealed: SealedPush = { v: 1, iv: b64uEncode(iv), ct }
      expect(() => openPush(key, sealed, Date.now())).toThrow()
    }
  })
})

describe('openPush:过期与时钟偏差', () => {
  it('ts 早于 now - 1h ⇒ 抛 Error("stale")', () => {
    const key = derivePushKey('stale-token')
    const now = 1_700_000_000_000
    expect(() => openPush(key, sealPush(key, { ts: now - 3_600_001 }), now)).toThrow('stale')
  })
  it('迟到 50 分钟仍能解开(APNs / FCM TTL 是 1 小时)', () => {
    const key = derivePushKey('late-token')
    const now = 1_700_000_000_000
    expect(openPush(key, sealPush(key, { ts: now - 50 * 60_000 }), now)).toEqual({ ts: now - 50 * 60_000 })
  })
  it('正好 1 小时前 ⇒ 仍接受', () => {
    const key = derivePushKey('edge-token')
    const now = 1_700_000_000_000
    expect(openPush(key, sealPush(key, { ts: now - 3_600_000 }), now)).toEqual({ ts: now - 3_600_000 })
  })
  it('ts 晚于 now + 10min ⇒ 抛 Error("stale");正好 10 分钟 ⇒ 接受', () => {
    const key = derivePushKey('future-token')
    const now = 1_700_000_000_000
    expect(() => openPush(key, sealPush(key, { ts: now + 600_001 }), now)).toThrow('stale')
    expect(openPush(key, sealPush(key, { ts: now + 600_000 }), now)).toEqual({ ts: now + 600_000 })
  })
  it('向量文件的每个 case 与实现一致', () => {
    const v = JSON.parse(readFileSync(new URL('../vectors/push.json', import.meta.url), 'utf8'))
    const key = derivePushKey(v.deviceToken)
    const wrong = derivePushKey(v.deviceToken + 'x')
    for (const c of v.cases as Array<{ name: string; now: number; sealed: SealedPush; expect: string; wrongKey?: boolean; payload?: unknown; dedupeKey?: string }>) {
      const k = c.wrongKey ? wrong : key
      if (c.expect === 'ok') {
        expect(openPush(k, c.sealed, c.now), c.name).toEqual(c.payload)
        expect(pushDedupeKey((c.payload as { ts: number }).ts, c.sealed.ct), c.name).toBe(c.dedupeKey)
      } else if (c.expect === 'invalid') {
        expect(PushPlaintext.safeParse(openPush(k, c.sealed, c.now)).success, c.name).toBe(false)
      } else if (c.expect === 'stale') expect(() => openPush(k, c.sealed, c.now), c.name).toThrow('stale')
      else expect(() => openPush(k, c.sealed, c.now), c.name).toThrow()
    }
    expect((v.cases as Array<{ expect: string }>).map(c => c.expect)).toEqual(expect.arrayContaining(['ok', 'invalid', 'stale', 'auth', 'malformed']))
  })
})

describe('PushPlaintext —— 解开之后的明文形状(daemon 与原生端的契约)', () => {
  it('从 index 导出', () => {
    expect(index.PushPlaintext).toBe(PushPlaintext)
    expect(index.PushKind).toBe(PushKind)
  })
  it('kind 只有五种', () => {
    expect(PushKind.options).toEqual(['permission', 'question', 'task_done', 'task_failed', 'test'])
  })
  it('合法载荷 seal → open → parse 通过;缺 title / 未知 kind / ts 非数字 ⇒ 拒', () => {
    const key = derivePushKey('schema-token')
    const now = 1_700_000_000_000
    const payload = { ts: now, kind: 'permission', title: '需要你批准', body: '想执行 npm i', taskId: 'ab12cd34', requestId: 'perm-1' }
    expect(PushPlaintext.parse(openPush(key, sealPush(key, payload), now))).toEqual(payload)
    expect(PushPlaintext.safeParse({ ts: now, kind: 'test', title: 't' }).success).toBe(false)
    expect(PushPlaintext.safeParse({ ts: now, kind: 'approval_needed', title: 't', body: 'b' }).success).toBe(false)
    expect(PushPlaintext.safeParse({ ts: 'x', kind: 'test', title: 't', body: 'b' }).success).toBe(false)
  })
  it('向量文件里每个 expect=ok 的 case,解开后都过 PushPlaintext(原生端照着它写解析)', () => {
    const v = JSON.parse(readFileSync(new URL('../vectors/push.json', import.meta.url), 'utf8'))
    const key = derivePushKey(v.deviceToken)
    const oks = (v.cases as Array<{ name: string; now: number; sealed: SealedPush; expect: string; payload?: unknown }>).filter(c => c.expect === 'ok')
    expect(oks.map(c => c.name)).toContain('ok')
    for (const c of oks) {
      const r = PushPlaintext.safeParse(openPush(key, c.sealed, c.now))
      expect(r.success, c.name).toBe(true)
      expect(PushPlaintext.parse(c.payload), c.name).toEqual(c.payload)
    }
  })
})

describe('去重(spec §5.5:每台设备按 ts + 密文哈希记住最近的推送)', () => {
  it('pushDedupeKey:floor(ts) + ":" + sha256(ct) 前 32 位 hex;ts 的小数部分不影响', () => {
    const k = pushDedupeKey(1_700_000_000_123.9, 'abc')
    expect(k).toBe('1700000000123:ba7816bf8f01cfea414140de5dae2223')   // sha256("abc")
    expect(pushDedupeKey(1_700_000_000_123, 'abc')).toBe(k)
    expect(pushDedupeKey(1_700_000_000_123, 'abd')).not.toBe(k)
  })
  it('makePushDedupe:第一次 new、第二次 duplicate;超过 TTL 的条目被修剪后又算 new', () => {
    const d = makePushDedupe()
    expect(d.seen('a', 1000)).toBe(false)
    expect(d.seen('a', 2000)).toBe(true)
    expect(d.seen('a', 1000 + PUSH_DEDUPE_TTL_MS)).toBe(true)          // 正好 TTL:还留着
    expect(d.seen('a', 1000 + PUSH_DEDUPE_TTL_MS + 1)).toBe(false)     // 超过 TTL:修剪后重新记下
  })
  it('容量满了挤掉最早见到的那条(同一时刻按键名排序,确定性)', () => {
    const d = makePushDedupe()
    for (let i = 0; i < PUSH_DEDUPE_CAPACITY; i++) d.seen(`k${String(i).padStart(3, '0')}`, 1000 + i)
    expect(d.seen('new', 5000)).toBe(false)
    expect(Object.keys(d.entries())).toHaveLength(PUSH_DEDUPE_CAPACITY)
    expect(d.entries()['k000']).toBeUndefined()
    expect(d.seen('k001', 5001)).toBe(true)
  })
  it('向量文件的 dedupe.steps 与参考实现一致(原生两端照同一份跑)', () => {
    const v = JSON.parse(readFileSync(new URL('../vectors/push.json', import.meta.url), 'utf8'))
    expect(v.dedupe.capacity).toBe(PUSH_DEDUPE_CAPACITY)
    expect(v.dedupe.ttlMs).toBe(PUSH_DEDUPE_TTL_MS)
    const d = makePushDedupe()
    for (const s of v.dedupe.steps as Array<{ key: string; now: number; expect: string; note: string }>) {
      expect(d.seen(s.key, s.now) ? 'duplicate' : 'new', s.note).toBe(s.expect)
    }
    expect((v.dedupe.steps as Array<{ expect: string }>).map(s => s.expect)).toContain('duplicate')
  })
  it('从 index 导出', () => {
    expect(index.pushDedupeKey).toBe(pushDedupeKey)
    expect(index.makePushDedupe).toBe(makePushDedupe)
  })
})

// 上面几个「畸形明文」测试需要绕开 sealPush 的 JSON.stringify(它总是产出合法
// JSON 对象),直接拿 push.ts 用的同一把 AES-256-GCM 原语加密一段自定义明文
// 字符串,伪造 relay 转发过来的「解密后不是 JSON 对象」的攻击输入。
function gcmEncryptRaw(key: Uint8Array, iv: Uint8Array, plaintext: string): Uint8Array {
  return gcm(key, iv).encrypt(new TextEncoder().encode(plaintext))
}

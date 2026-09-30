/**
 * 官方中继 v2 的 daemon 身份(spec 2026-09-30 §4)。Ed25519 私钥种子存 `<stateDir>/relay-identity.json`
 * (0600),与老中继的 `tunnel-id.json` 分开。id 由公钥派生(`r…`)。
 *
 * 丢了私钥 = 换了一台新「电脑」:新 id,手机要重新配对。所以文件在但读不出时**抛出**而不是重生成 ——
 * 上层记一条日志、这次不连 v2,老中继照常;修文件(或主人明确删掉它)之后重启即恢复。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64uDecode, b64uEncode, relayIdFromPub, relayKeyPair, signRelayLogin } from '@wechat-cc/protocol'
import { readJsonFile } from '../lib/read-json-file'

export const DEFAULT_RELAY_V2_URL = 'wss://relay.tendhearth.com'
const FILE = 'relay-identity.json'

export interface RelayIdentity {
  id: string
  sign(challenge: string): { pub: string; sig: string }
}

function readSeed(path: string): Uint8Array {
  try {
    const raw = readJsonFile<{ v?: unknown; seed?: unknown }>(path)
    if (raw.v === 1 && typeof raw.seed === 'string') {
      const s = b64uDecode(raw.seed)
      if (s.length === 32) return s
    }
  } catch { /* 落到下面的抛 */ }
  throw new Error('relay_identity_corrupt')
}

export function loadOrCreateRelayIdentity(stateDir: string): RelayIdentity {
  const path = join(stateDir, FILE)
  let seed: Uint8Array
  if (existsSync(path)) {
    seed = readSeed(path)
  } else {
    seed = relayKeyPair().seed
    try {
      writeFileSync(path, JSON.stringify({ v: 1, seed: b64uEncode(seed) }), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      // 并发启动时另一个进程先写了:用它的。
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') seed = readSeed(path)
      else throw e
    }
  }
  const id = relayIdFromPub(relayKeyPair(seed).pub)
  return { id, sign: (challenge) => signRelayLogin(seed, challenge, id) }
}

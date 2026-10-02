import { PAIRING_KEY, type SecureStoreLike } from '../net/credentials'
import { PUSH_REG_ITEM } from '../push/key-store'

/**
 * 真机验收(scripts/device-e2e.ts)用的「把主人的配对先收起来、测完放回去」。只在开发构建与真机验收构建里可达(dev-e2e 页 + rewriteSystemPath,见 src/e2e-build.ts)。
 *
 * 为什么要有:验收要在主人自己那台已配对的手机上配一台**一次性**设备、最后撤销它。直接配会让 app 去退掉旧设备位
 * (retirePrevious ⇒ unpair_self),那就把主人的配对撤了;测完撤销测试设备又会让 app 停在「不再配对」。
 * 收起来 ⇒ app 当没配过(prev = null,不会去退旧位);放回去 ⇒ 冷启动又是原来那台,令牌一个字没动。
 *
 * 规矩:
 * - 收:已经收着一份 ⇒ 不动(already_stashed)—— 上一轮中途挂了,收着的那份才是主人的;再收会拿测试设备把它顶掉。
 * - 收:先写收纳格、读回核对一致,才删配对;任何一步失败 ⇒ 配对原样留着。
 * - 放:收纳格写回配对、删推送登记指纹(下次启动按原来那台重新登记推送),最后才删收纳格。
 * - 令牌只在钥匙串里搬,从不进日志、界面或返回值。纯 TS:不引 react / expo。
 */
export const E2E_STASH_KEY = 'tendhearth.pairing.e2e-stash.v1'

export type StashResult = 'stashed' | 'already_stashed' | 'nothing'
export type RestoreResult = 'restored' | 'nothing'

export async function stashPairing(ss: SecureStoreLike, opts: Record<string, unknown>): Promise<StashResult> {
  if ((await ss.getItemAsync(E2E_STASH_KEY, opts)) !== null) return 'already_stashed'
  const cur = await ss.getItemAsync(PAIRING_KEY, opts)
  if (cur === null) return 'nothing'
  await ss.setItemAsync(E2E_STASH_KEY, cur, opts)
  if ((await ss.getItemAsync(E2E_STASH_KEY, opts)) !== cur) throw new Error('stash_verify_failed')
  await ss.deleteItemAsync(PAIRING_KEY, opts)
  return 'stashed'
}

export async function restorePairing(ss: SecureStoreLike, opts: Record<string, unknown>): Promise<RestoreResult> {
  const stash = await ss.getItemAsync(E2E_STASH_KEY, opts)
  if (stash === null) return 'nothing'
  await ss.setItemAsync(PAIRING_KEY, stash, opts)
  if ((await ss.getItemAsync(PAIRING_KEY, opts)) !== stash) throw new Error('restore_verify_failed')
  await ss.deleteItemAsync(PUSH_REG_ITEM, opts)
  await ss.deleteItemAsync(E2E_STASH_KEY, opts)
  return 'restored'
}

/** dev-e2e 页:op 参数 ⇒ 该做哪件事;不认识 ⇒ null(页面显示 dev-e2e-rejected)。 */
export function e2eOp(op: unknown): 'stash' | 'restore' | 'status' | null {
  return op === 'stash' || op === 'restore' || op === 'status' ? op : null
}

/** status:只报收纳格与配对在不在(给编排脚本判断上一轮是否留下了东西),不报内容。 */
export async function stashStatus(ss: SecureStoreLike, opts: Record<string, unknown>): Promise<'stash-and-pairing' | 'stash-only' | 'pairing-only' | 'empty'> {
  const [s, p] = await Promise.all([ss.getItemAsync(E2E_STASH_KEY, opts), ss.getItemAsync(PAIRING_KEY, opts)])
  return s !== null ? (p !== null ? 'stash-and-pairing' : 'stash-only') : (p !== null ? 'pairing-only' : 'empty')
}

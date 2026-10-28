/**
 * 测试用:一份内存里的主库,给生成物的过期围栏(架构终态 G8,`makeMemoryFactsStore(db).fence`)。
 * 同一个测试里写源的和读状态的要用同一份 —— 造一次、传下去。
 */
import { openTestDb } from '../lib/db'
import { makeMemoryFactsStore } from '../adapters/store/memory-facts'
import type { DerivedFence } from '../lib/derived-fence'

export function testFences(): (chatId: string) => DerivedFence {
  return makeMemoryFactsStore(openTestDb()).fence
}

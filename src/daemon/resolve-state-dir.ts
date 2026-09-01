/**
 * resolve-state-dir — daemon 进程的状态目录解析,**与 lib/config.ts 对齐**。
 *
 * WHY(2026-09-01,Windows 真机首次跑 daemon 时发现):`main.ts` 一直读
 * `WECHAT_CC_STATE_DIR`,而 `lib/config.ts:41` 的 `STATE_DIR`(以及依赖它的
 * send-reply / access / log 等)读的是 `WECHAT_STATE_DIR`。**只设其中一个,
 * 两半就指向不同目录**:daemon 去错误的目录找 `daemon.env`,provider 的 API
 * key 读不到 → 所有 provider 不注册 → 社交层因缺 cheapEval 静默跳过。症状
 * (「社交没接线」)离根因(环境变量名不一致)隔了三层。
 *
 * 为什么测试从没发现:e2e harness **两个都设**(`__e2e__/harness.ts:269` 的
 * 注释白纸黑字记着这条分裂),于是测试永远绿、真机永远踩 —— 与
 * [[macos-only-green-blind-spot]] 同一类盲区。
 *
 * 优先级刻意是「新名 > 旧名」:`WECHAT_STATE_DIR` 是全仓其它地方读的那个,
 * 让它胜出才能保证 main.ts 与 config.ts 永远看到同一个目录。旧名保留为兼容
 * 回落(既有 e2e、脚本、以及任何写过它的部署都不受影响)。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 环境快照注入,便于测试;生产传 `process.env`。 */
export function resolveDaemonStateDir(env: Record<string, string | undefined> = process.env): string {
  // 空字符串视作未设置 —— 否则 daemon 会把状态目录解析成进程当前目录。
  const primary = env.WECHAT_STATE_DIR?.trim()
  if (primary) return primary
  const legacy = env.WECHAT_CC_STATE_DIR?.trim()
  if (legacy) return legacy
  return join(homedir(), '.claude', 'channels', 'wechat')
}

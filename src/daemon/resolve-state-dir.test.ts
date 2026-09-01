/**
 * daemon 的 stateDir 解析。
 *
 * 2026-09-01 真机 bug:`main.ts` 读 `WECHAT_CC_STATE_DIR`,而 `lib/config.ts`
 * (以及其余所有地方)读 `WECHAT_STATE_DIR`。**只设其中一个,daemon 就会去
 * 另一个目录找 daemon.env** —— provider 的 API key 读不到 → provider 全不
 * 注册 → 社交层因缺 cheapEval 静默跳过。症状离根因隔三层。
 *
 * 为什么测试一直没发现:e2e harness **两个都设**(见 __e2e__/harness.ts:269
 * 的注释,那条分裂是被知道的),所以测试永远绿、真机永远踩。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDaemonStateDir } from './resolve-state-dir'

const HOME_DEFAULT = /\.claude[\\/]channels[\\/]wechat$/

describe('resolveDaemonStateDir', () => {
  it('WECHAT_STATE_DIR 优先 —— 与 lib/config.ts 的 STATE_DIR 同名同义', () => {
    expect(resolveDaemonStateDir({ WECHAT_STATE_DIR: '/a' })).toBe('/a')
  })

  it('只设旧名 WECHAT_CC_STATE_DIR 仍然生效(兼容既有 e2e 与脚本)', () => {
    expect(resolveDaemonStateDir({ WECHAT_CC_STATE_DIR: '/b' })).toBe('/b')
  })

  it('两个都设时,以 WECHAT_STATE_DIR 为准 —— 它才是全仓其它地方读的那个', () => {
    // 关键:若旧名胜出,main.ts 与 config.ts 仍可能指向不同目录,分裂照旧。
    expect(resolveDaemonStateDir({ WECHAT_STATE_DIR: '/a', WECHAT_CC_STATE_DIR: '/b' })).toBe('/a')
  })

  it('都没设 → 家目录默认值', () => {
    expect(resolveDaemonStateDir({})).toMatch(HOME_DEFAULT)
  })

  it('空字符串视作未设置(避免把 daemon 指到进程当前目录)', () => {
    expect(resolveDaemonStateDir({ WECHAT_STATE_DIR: '' })).toMatch(HOME_DEFAULT)
  })
})

// 跨文件不变量:daemon 侧与 config.ts 必须读【同一个】环境变量名。这条是给
// "将来又冒出第三个名字"准备的 —— 那正是这次 bug 的成因。直接读源码断言,
// 因为 config.ts 的 STATE_DIR 是模块级常量,在测试里无法重新求值。
describe('与 lib/config.ts 的一致性', () => {
  it('config.ts 读的主变量名,daemon 侧也必须以它为准', () => {
    const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'config.ts'), 'utf8')
    // config.ts 只认这一个;daemon 侧若不以它优先,两半就会指向不同目录。
    expect(cfg).toMatch(/process\.env\.WECHAT_STATE_DIR/)
    expect(cfg).not.toMatch(/process\.env\.WECHAT_CC_STATE_DIR/)
    // 只看真正读环境变量的代码行(注释里 WECHAT_CC_STATE_DIR 含有
    // WECHAT_STATE_DIR 这个子串,裸 indexOf 会误命中)。
    const self = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'resolve-state-dir.ts'), 'utf8')
    const reads = [...self.matchAll(/env\.(WECHAT_(?:CC_)?STATE_DIR)/g)].map(m => m[1])
    expect(reads, '两个名字都要读到(新名 + 兼容回落)').toEqual(['WECHAT_STATE_DIR', 'WECHAT_CC_STATE_DIR'])
  })

  it('main.ts 不再自己解析状态目录(必须走这个统一入口)', () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8')
    expect(main).toContain('resolveDaemonStateDir')
    expect(main, 'main.ts 不该再直接读环境变量拼路径').not.toMatch(/process\.env\.WECHAT_CC_STATE_DIR/)
  })
})

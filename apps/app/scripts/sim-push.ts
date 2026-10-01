#!/usr/bin/env bun
/**
 * 模拟器上验证推送的到达与点击路由(计划 4 Task 11)。不碰真 daemon、不用真设备令牌。
 * simctl push 不跑通知服务扩展(Task 1 结论):横幅是中继原样的占位,解密与路由由 app 在点击 / 前台时兜底完成。
 *   1) app(开发构建)已在模拟器里开着、进了演示:bun apps/app/scripts/sim-push.ts --print-link | xargs xcrun simctl openurl <udid>
 *      ⇒ app 显示 dev-push-key-ok(共享钥匙串里存了开发令牌推出的推送密钥;本次运行 app 也用它兜底解密)
 *   2) 再:bun apps/app/scripts/sim-push.ts --udid <udid> [--mode ok|stale|tamper|wrong-key] [--repeat [--gap <ms>]]
 *      --repeat 把同一份密文送两次(中继重发的样子);--gap 是两次之间等多久(验前台横幅「同一份只弹一次」时让第一条先自动收起)。
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PushKind } from '@wechat-cc/protocol'
import { buildSimPush, devToken, sendTimes, type SimMode } from './sim-push-lib'

const { values: v } = parseArgs({
  options: {
    udid: { type: 'string', default: 'booted' },
    seed: { type: 'string', default: 'sim-push' },
    kind: { type: 'string', default: 'permission' },
    task: { type: 'string', default: 'a1b2c3d4' },
    request: { type: 'string', default: 'perm-demo-1' },
    body: { type: 'string', default: '整理作品集:npm i sharp' },
    mode: { type: 'string', default: 'ok' },
    repeat: { type: 'boolean', default: false },
    gap: { type: 'string', default: '0' },
    'print-link': { type: 'boolean', default: false },
  },
})
const token = devToken(v.seed!)
if (v['print-link']) { console.log(`tendhearth://dev-push-key?token=${token}`); process.exit(0) }
const mode = v.mode as SimMode
if (!['ok', 'stale', 'tamper', 'wrong-key'].includes(mode)) { console.error(`unknown --mode ${mode}`); process.exit(2) }
const payload = buildSimPush({ token, mode, kind: PushKind.parse(v.kind), taskId: v.task || undefined, requestId: v.request || undefined, body: v.body!, now: Date.now() })
const gap = Number(v.gap)
if (!Number.isFinite(gap) || gap < 0) { console.error(`bad --gap ${v.gap}`); process.exit(2) }
const file = join(tmpdir(), `th-sim-push-${process.pid}.apns`)
let code = 1
try {
  writeFileSync(file, JSON.stringify(payload))
  code = sendTimes(v.repeat ? 2 : 1,
    () => spawnSync('xcrun', ['simctl', 'push', v.udid!, 'com.tendhearth.app', file], { stdio: 'inherit' }).status ?? 1,
    () => { if (gap > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, gap) })
} finally {
  rmSync(file, { force: true })
}
process.exit(code)

/**
 * reply-once harness 的隔离护栏 —— **必须是 harness.ts 的第一个 import**。
 *
 * ES 模块的 import 先于模块体求值:src/lib/config.ts 在 import 那一刻就把 STATE_DIR 定下来了
 * (`process.env.WECHAT_STATE_DIR ?? ~/.claude/channels/wechat`)。2026-10-02 那版 harness 在模块体里才
 * 设环境变量,于是任何在 import 期读 STATE_DIR 的模块拿到的都是**主人真的状态目录**。放在这里、
 * 第一个求值,后面所有模块看到的就都是临时目录。
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const STATE_DIR = mkdtempSync(join(tmpdir(), 'reply-once-'))
process.env.WECHAT_STATE_DIR = STATE_DIR
// 不往任何 channel.log 里写(包括临时目录 —— harness 自己打 stderr)。
process.env.WECHAT_DISABLE_LOG_FILE = '1'
delete process.env.WECHAT_INTERNAL_API
delete process.env.WECHAT_INTERNAL_TOKEN_FILE

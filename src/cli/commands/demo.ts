// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { DemoSeedOutput, DemoUnseedOutput } from '../schema'
async function runDemo(verb: 'seed' | 'unseed', chatIdArg: string | undefined, json: boolean): Promise<void> {
  const { loadCompanionConfig } = await import('../../daemon/companion/config')
  const cfg = loadCompanionConfig(STATE_DIR)
  const chatId = chatIdArg ?? cfg.default_chat_id
  if (!chatId) {
    const msg = 'no default chat configured — pass --chat-id or run setup first'
    console.error(json ? JSON.stringify({ ok: false, error: msg }, null, 2) : msg)
    process.exit(1)
  }
  const { seedDemo, unseedDemo } = await import('../../daemon/demo/seed')
  const { openWechatDb } = await import('../../lib/db')
  const db = openWechatDb(STATE_DIR)
  const fn = verb === 'seed' ? seedDemo : unseedDemo
  const result = await fn({ stateDir: STATE_DIR, chatId, db })
  const demoSchema = verb === 'seed' ? DemoSeedOutput : DemoUnseedOutput
  console.log(json ? JSON.stringify(demoSchema.parse({ ok: true, ...result }), null, 2) : JSON.stringify(result))
}

const demoSeedCmd = defineCommand({
  meta: { name: 'seed', description: 'Populate sample observations + milestones + events for first-impression / screenshot use' },
  args: {
    'chat-id': { type: 'string', description: 'Target chat (defaults to companion default_chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) { await runDemo('seed', args['chat-id'], Boolean(args.json)) },
})

const demoUnseedCmd = defineCommand({
  meta: { name: 'unseed', description: 'Remove items written by `demo seed`. Idempotent.' },
  args: {
    'chat-id': { type: 'string', description: 'Target chat (defaults to companion default_chat_id)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) { await runDemo('unseed', args['chat-id'], Boolean(args.json)) },
})

export const demoCmd = defineCommand({
  meta: { name: 'demo', description: 'Seed/unseed demo data for the dashboard' },
  subCommands: {
    seed: demoSeedCmd,
    unseed: demoUnseedCmd,
  },
})

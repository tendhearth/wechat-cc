// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { AvatarInfoOutput, AvatarSetOutput, AvatarRemoveOutput } from '../schema'
const avatarInfoCmd = defineCommand({
  meta: { name: 'info', description: "Show stored avatar metadata for a key (chat / bot / user)" },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { avatarInfo } = await import('../../core/avatar/store')
    const info = avatarInfo(STATE_DIR, args.key)
    if (args.json) console.log(JSON.stringify(AvatarInfoOutput.parse({ ok: true, ...info })))
    else console.log(`${args.key}: ${info.exists ? info.path : '(no avatar)'}`)
  },
})

const avatarSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set avatar from base64 (PNG/JPG)' },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    base64: { type: 'string', required: true, description: 'Base64-encoded image bytes' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { setAvatar } = await import('../../core/avatar/store')
    try {
      const result = setAvatar(STATE_DIR, args.key, args.base64)
      if (args.json) console.log(JSON.stringify(AvatarSetOutput.parse(result)))
      else console.log(`set ${args.key} → ${result.path}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify(AvatarSetOutput.parse({ ok: false, error: msg })))
      else console.error(`avatar set failed: ${msg}`)
      process.exit(1)
    }
  },
})

const avatarRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Remove stored avatar for a key' },
  args: {
    key: { type: 'positional', required: true, description: 'Avatar key', valueHint: 'key' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { removeAvatar } = await import('../../core/avatar/store')
    const result = removeAvatar(STATE_DIR, args.key)
    if (args.json) console.log(JSON.stringify(AvatarRemoveOutput.parse(result)))
    else console.log(`removed ${args.key}`)
  },
})

export const avatarCmd = defineCommand({
  meta: { name: 'avatar', description: 'Avatar metadata + binary set/remove (per chat / bot / user key)' },
  subCommands: {
    info: avatarInfoCmd,
    set: avatarSetCmd,
    remove: avatarRemoveCmd,
  },
})

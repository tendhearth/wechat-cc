// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { readStdin } from '../stdin'
import { ReplyOutput } from '../schema'
export const replyCmd = defineCommand({
  meta: {
    name: 'reply',
    description: 'Send a text reply via WeChat (CLI fallback for the MCP `reply` tool — same on-disk state as the running daemon)',
  },
  args: {
    to: { type: 'string', description: 'Target chat id (omit → most-recently-active chat)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // text comes from positional args (citty surfaces unconsumed positionals
    // via RawArgs._). Joining with ' ' matches the legacy parser, which
    // accumulated all non-flag tokens. Empty → fall through to stdin.
    const positional = (args._ ?? []) as string[]
    const inlineText = positional.length > 0 ? positional.join(' ') : undefined
    // CLI fallback for the MCP `reply` tool — same code path as the
    // daemon (sendReplyOnce reads state from disk), so recipient
    // resolution + session continuity are identical whether the
    // daemon is running or not.
    const { sendReplyOnce, defaultTerminalChatId } = await import('../../lib/send-reply.ts')
    const json = Boolean(args.json)
    const emitFailure = (error: string): void => {
      if (json) console.log(JSON.stringify(ReplyOutput.parse({ ok: false, error })))
      else console.error(`reply failed: ${error}`)
      process.exit(1)
    }
    const chatId = args.to ?? defaultTerminalChatId() ?? undefined
    if (!chatId) {
      emitFailure('no chat resolved — pass --to <chat_id> or send a WeChat message first so the daemon records one')
      return
    }
    const text = inlineText ?? (await readStdin()).trim()
    if (!text) {
      emitFailure('no text — pass it as an argument or pipe it on stdin')
      return
    }
    const result = await sendReplyOnce(chatId, text)
    if (!result.ok) {
      emitFailure(result.error)
      return
    }
    if (json) {
      console.log(JSON.stringify(ReplyOutput.parse({ ok: true, chat_id: chatId, chunks: result.chunks, account: result.account })))
    } else {
      console.log(`Sent: ${result.chunks} chunk(s) via account ${result.account} → ${chatId}`)
    }
  },
})

// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { isCompiledBundle } from '../../lib/runtime-info'
import { delegateMemoryOp, type CliApiInfo } from '../../lib/cli-llm-eval'
import { MemoryListOutput, MemoryReadOutput, MemoryWriteOutput, MemoryProfileOutput, MemoryProfileStatusOutput } from '../schema'
// ── PR4 batch 3b — memory / account / daemon / demo ─────────────────
//
// 4 namespaces, 7 leaves total. Same shape as 3a: bounded surface,
// no daemon-restart, no ilink. memory-write decodes a base64 body
// (sandboxed: .md only, ≤100KB, traversal-safe), account-remove wipes
// a single account dir, daemon-kill signals a process by pid (with
// cmdline verification), demo seed/unseed mutate a per-chat slice
// of the SQLite db.

const memoryListCmd = defineCommand({
  meta: { name: 'list', description: 'List Companion v2 memory files (per user)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { listAllMemory } = await import('../../lib/memory.ts')
    const users = listAllMemory(STATE_DIR)
    if (args.json) console.log(JSON.stringify(MemoryListOutput.parse(users), null, 2))
    else {
      if (users.length === 0) console.log('(no memory files)')
      for (const u of users) {
        console.log(`${u.userId}  (${u.fileCount} 文件 · ${u.totalBytes} 字节)`)
        for (const f of u.files) console.log(`  - ${f.path}  (${f.size}B)`)
      }
    }
  },
})

const memoryReadCmd = defineCommand({
  meta: { name: 'read', description: 'Read one .md memory file (path is relative to the user dir, traversal-safe)' },
  args: {
    userId: { type: 'positional', required: true, description: 'User id', valueHint: 'user-id' },
    path: { type: 'positional', required: true, description: 'Path under the user memory dir', valueHint: 'path' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { readMemoryFile } = await import('../../lib/memory.ts')
    try {
      const content = readMemoryFile(STATE_DIR, args.userId, args.path)
      if (args.json) console.log(JSON.stringify(MemoryReadOutput.parse({ ok: true, userId: args.userId, path: args.path, content }), null, 2))
      else process.stdout.write(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // --json: emit ok:false on stdout + exit 0 so GUI callers can read
      // the structured error. Non-JSON: stderr + exit 1 (matches the
      // pattern in `update --json` and is what the GUI invoke path
      // expects — error info travels via JSON.ok=false, not exit code).
      if (args.json) {
        console.log(JSON.stringify(MemoryReadOutput.parse({ ok: false, error: msg })))
        return
      }
      console.error(`memory read failed: ${msg}`)
      process.exit(1)
    }
  },
})

const memoryWriteCmd = defineCommand({
  meta: { name: 'write', description: 'Write/overwrite one .md memory file (sandboxed: .md only, ≤100KB, no traversal)' },
  args: {
    userId: { type: 'positional', required: true, description: 'User id', valueHint: 'user-id' },
    path: { type: 'positional', required: true, description: 'Path under the user memory dir', valueHint: 'path' },
    'body-base64': { type: 'string', required: true, description: 'Base64-encoded UTF-8 body (avoids shell-quote pain)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { writeMemoryFile } = await import('../../lib/memory.ts')
    try {
      // Body comes in via base64 to dodge shell-quoting hell on multi-line
      // markdown content (Tauri sidecar IPC passes args as a list, but
      // the underlying CLI would still see CRLF/quote/backtick sequences
      // unsafely if we tried to inline the content). Decoder + UTF-8
      // assumption matches the GUI's btoa(unescape(encodeURIComponent(body))).
      const body = Buffer.from(args['body-base64'], 'base64').toString('utf8')
      const result = writeMemoryFile(STATE_DIR, args.userId, args.path, body)
      if (args.json) console.log(JSON.stringify(MemoryWriteOutput.parse({ ok: true, userId: args.userId, path: args.path, ...result }), null, 2))
      else console.log(`${result.created ? 'created' : 'updated'}: ${args.userId}/${args.path} (${result.bytesWritten}B)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) {
        console.log(JSON.stringify(MemoryWriteOutput.parse({ ok: false, error: msg })))
        return
      }
      console.error(`memory write failed: ${msg}`)
      process.exit(1)
    }
  },
})

const memoryProfileReadCmd = defineCommand({
  meta: { name: 'profile-read', description: 'Read memory/<user-id>/_profile.json (desktop profile data)' },
  args: {
    userId: { type: 'positional', required: true, description: 'User id', valueHint: 'user-id' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { readMemoryProfileFile } = await import('../../lib/memory.ts')
    try {
      const content = readMemoryProfileFile(STATE_DIR, args.userId)
      if (args.json) console.log(JSON.stringify(MemoryReadOutput.parse({ ok: true, userId: args.userId, path: '_profile.json', content }), null, 2))
      else process.stdout.write(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) {
        console.log(JSON.stringify(MemoryReadOutput.parse({ ok: false, error: msg })))
        return
      }
      console.error(`memory profile-read failed: ${msg}`)
      process.exit(1)
    }
  },
})

// Shared by the compiled-sidecar delegation path in `memory synthesize` /
// `memory profile generate` (guardrail #1 — see src/lib/cli-llm-eval.ts).
// Reads STATE_DIR/internal-api-info.json (baseUrl + tokenFilePath) → token,
// mirroring the `mode set` command's own read (line ~2242) but returning
// null instead of exiting, since delegateMemoryOp needs a value to branch
// on rather than a process.exit.
async function readCliApiInfo(): Promise<CliApiInfo | null> {
  const { existsSync, readFileSync } = await import('node:fs')
  const infoPath = join(STATE_DIR, 'internal-api-info.json')
  if (!existsSync(infoPath)) return null
  try {
    const info = readJsonFile(infoPath) as { baseUrl?: string; tokenFilePath?: string }
    if (!info.baseUrl || !info.tokenFilePath) return null
    const token = readFileSync(info.tokenFilePath, 'utf8').trim()
    return { baseUrl: info.baseUrl, token }
  } catch {
    return null
  }
}

const memorySynthesizeCmd = defineCommand({
  meta: {
    name: 'synthesize',
    description: "Synthesize the admin's local Claude memory (across projects) into an _overview.md the bot reads",
  },
  args: {
    'chat-id': { type: 'string', description: 'Admin chat_id (default: sole admin in access.json)' },
    provider: { type: 'string', description: 'Force provider claude|codex (default: admin conversation provider)' },
    'dry-run': { type: 'boolean', default: false, description: 'Discover + build prompt; make no LLM call and no write' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Guardrail #1 (2026-07-23-daemon-owns-llm-memory-ops, Task 3): a
    // compiled sidecar never inline-spawns claude/codex for this op — it
    // delegates to the running daemon's /v1/memory/synthesize instead,
    // where the correct provider config lives. Must return before any of
    // the inline sdkEval closures below are even constructed.
    if (isCompiledBundle()) {
      const apiInfo = await readCliApiInfo()
      const r = await delegateMemoryOp('synthesize', { chatId: args['chat-id'] }, { readApiInfo: () => apiInfo, fetch })
      if (args.json) { console.log(JSON.stringify(r, null, 2)); return }
      const out = r as { ok?: boolean; error?: string; written?: { path: string; bytesWritten: number } }
      if (out.ok === false) { console.error(`memory synthesize failed (delegated to daemon): ${out.error ?? 'unknown error'}`); process.exit(1) }
      console.log(out.written
        ? `已写入 ${out.written.path} (${out.written.bytesWritten}B) [via daemon]`
        : '未写入(daemon 返回无写入结果) [via daemon]')
      return
    }


    // ── Resolve admin chat-id (same pattern as `dialogue backfill`) ──────
    let chatId = args['chat-id']
    if (!chatId) {
      let access: { admins?: string[] } = {}
      try {
        access = readJsonFile(join(STATE_DIR, 'access.json'))
      } catch { /* missing/corrupt — fail below */ }
      const admins = access.admins ?? []
      if (admins.length === 1) chatId = admins[0]!
      else {
        const msg = admins.length === 0
          ? 'No admins in access.json — pass --chat-id explicitly'
          : `Multiple admins (${admins.join(', ')}) — pass --chat-id explicitly`
        if (args.json) { console.log(JSON.stringify({ ok: false, error: msg })); return }
        console.error(msg); process.exit(1)
      }
    }

    // ── Resolve provider: explicit flag > admin conversation mode > claude ─
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    let provider = args.provider
    if (!provider) {
      try {
        const { makeConversationStore } = await import('../../core/conversation-store')
        const conv = makeConversationStore(db).get(chatId)
        if (conv?.mode?.kind === 'solo') provider = conv.mode.provider
      } catch { /* no conversation yet — default below */ }
    }
    provider = provider || 'claude'
    // db is kept open and passed to synthesizeOverview so it can also fold in
    // the life-side memory (observations / milestones / admin notes).

    const dryRun = Boolean(args['dry-run'])

    // ── Build the one-shot eval for the resolved provider ────────────────
    // Mirrors each provider's cheapEval (claude haiku-class / codex minimal),
    // built inline so the CLI doesn't need a live daemon ProviderRegistry.
    const sdkEval = async (prompt: string): Promise<string> => {
      if (provider === 'codex') {
        const { Codex } = await import('@openai/codex-sdk')
        const { resolveCodexCheapModel } = await import('../../core/codex-cheap-model')
        const { tmpdir } = await import('node:os')
        const thread = new Codex().startThread({
          model: resolveCodexCheapModel(),
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          webSearchEnabled: false,
          networkAccessEnabled: false,
          workingDirectory: tmpdir(),
          skipGitRepoCheck: true,
        })
        const turn = await thread.run(prompt)
        return (turn.items as Array<{ type?: string; text?: string }>)
          .filter(i => i.type === 'agent_message' && typeof i.text === 'string')
          .map(i => i.text!)
          .join('')
      }
      // claude (default)
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const model = process.env['WECHAT_CLAUDE_CHEAP_MODEL'] || 'claude-haiku-4-5'
      let text = ''
      const q = query({ prompt, options: { model, maxTurns: 1 } })
      for await (const raw of q as AsyncGenerator<import('@anthropic-ai/claude-agent-sdk').SDKMessage>) {
        const msg = raw as unknown as { type: string; message?: { content?: unknown } }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
            if (part.type === 'text' && typeof part.text === 'string') text += part.text
          }
        }
      }
      return text
    }

    const { synthesizeOverview } = await import('../../lib/memory-synthesis')
    const { makeLifeStoresReader } = await import('../../daemon/life-stores')
    let result
    try {
      result = await synthesizeOverview({ stateDir: STATE_DIR, adminChatId: chatId, sdkEval, dryRun, lifeStores: makeLifeStoresReader(db, STATE_DIR) })
    } finally {
      db.close()
    }

    if (args.json) {
      console.log(JSON.stringify({ ok: true, chatId, provider, dryRun, ...result }, null, 2))
      return
    }
    console.log(`整理对象: ${chatId}  ·  provider: ${provider}${dryRun ? '  ·  (dry-run)' : ''}`)
    console.log(`工作侧: ${result.projectsFound} 个项目: ${result.projectNames.join(', ') || '(无)'}  ·  ${result.filesScanned} 文件`)
    console.log(`生活侧: ${result.observationsFound} 观察 · ${result.milestonesFound} 里程碑 · ${result.memoryNotesFound} 记忆笔记  ·  prompt ${result.promptChars} 字`)
    if (dryRun) { console.log('(dry-run — 未调用 LLM、未写入)'); return }
    if (result.written) console.log(`已写入 ${result.written.path} (${result.written.bytesWritten}B)`)
    else console.log('未写入(无可整理内容或 LLM 返回空)')
  },
})

const memoryNightlyCmd = defineCommand({
  meta: { name: 'nightly', description: '立刻跑一次每晚记忆整理(需要 daemon 在跑)' },
  args: {
    now: { type: 'boolean', description: '忽略时间点,立刻跑(目前只支持这一种)', default: false },
    json: { type: 'boolean', description: '机器可读输出', default: false },
  },
  async run({ args }) {
    if (!args.now) { console.error('用法:wechat-cc memory nightly --now'); process.exitCode = 2; return }
    const apiInfo = await readCliApiInfo()
    const r = await delegateMemoryOp('nightly', {}, { readApiInfo: () => apiInfo, fetch })
    console.log(args.json ? JSON.stringify(r) : JSON.stringify(r, null, 2))
    if (!(r as { ok?: boolean }).ok) process.exitCode = 1
  },
})

async function resolveProfileChatId(chatIdArg: string | undefined): Promise<string> {
  if (chatIdArg) return chatIdArg
  let access: { admins?: string[] } = {}
  try {
    access = readJsonFile(join(STATE_DIR, 'access.json'))
  } catch { /* missing/corrupt — fail below */ }
  const admins = access.admins ?? []
  if (admins.length === 1) return admins[0]!
  throw new Error(admins.length === 0
    ? 'No admins in access.json — pass --chat-id explicitly'
    : `Multiple admins (${admins.join(', ')}) — pass --chat-id explicitly`)
}

async function profileProvider(chatId: string, requested: string | undefined, db: ReturnType<typeof import('../../lib/db').openWechatDb>): Promise<string> {
  if (requested) return requested
  try {
    const { makeConversationStore } = await import('../../core/conversation-store')
    const conv = makeConversationStore(db).get(chatId)
    if (conv?.mode?.kind === 'solo') return conv.mode.provider
  } catch { /* no conversation yet — default below */ }
  return 'claude'
}

function makeProfileSdkEval(provider: string): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    if (provider === 'codex') {
      const { Codex } = await import('@openai/codex-sdk')
      const { resolveCodexCheapModel } = await import('../../core/codex-cheap-model')
      const { tmpdir } = await import('node:os')
      const thread = new Codex().startThread({
        model: resolveCodexCheapModel(),
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        webSearchEnabled: false,
        networkAccessEnabled: false,
        workingDirectory: tmpdir(),
        skipGitRepoCheck: true,
      })
      const turn = await thread.run(prompt)
      return (turn.items as Array<{ type?: string; text?: string }>)
        .filter(i => i.type === 'agent_message' && typeof i.text === 'string')
        .map(i => i.text!)
        .join('')
    }
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const model = process.env['WECHAT_CLAUDE_CHEAP_MODEL'] || 'claude-haiku-4-5'
    let text = ''
    const q = query({ prompt, options: { model, maxTurns: 1 } })
    for await (const raw of q as AsyncGenerator<import('@anthropic-ai/claude-agent-sdk').SDKMessage>) {
      const msg = raw as unknown as { type: string; message?: { content?: unknown } }
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
          if (part.type === 'text' && typeof part.text === 'string') text += part.text
        }
      }
    }
    return text
  }
}

async function runMemoryProfileGenerate(args: {
  'chat-id'?: string
  provider?: string
  'dry-run'?: boolean
  json?: boolean
  auto?: boolean
}) {
  // Guardrail #1 (2026-07-23-daemon-owns-llm-memory-ops, Task 3): see the
  // matching block in memorySynthesizeCmd.run() above — compiled sidecar
  // delegates to the daemon's /v1/memory/profile/generate instead of
  // inline-spawning claude/codex. chat-id resolution (admin default) is
  // left to the daemon route (resolveAdminChatId) when omitted here.
  if (isCompiledBundle()) {
    const apiInfo = await readCliApiInfo()
    const r = await delegateMemoryOp('profile-generate', { chatId: args['chat-id'] }, { readApiInfo: () => apiInfo, fetch })
    if (args.json) { console.log(JSON.stringify(r, null, 2)); return }
    const out = r as { ok?: boolean; error?: string; written?: { path: string; bytesWritten: number } }
    if (out.ok === false) { console.error(`memory profile generate failed (delegated to daemon): ${out.error ?? 'unknown error'}`); process.exit(1) }
    console.log(out.written
      ? `已写入 ${out.written.path} (${out.written.bytesWritten}B) [via daemon]`
      : '未写入(daemon 返回无写入结果) [via daemon]')
    return
  }

  try {
    const chatId = await resolveProfileChatId(args['chat-id'])
    const { openWechatDb } = await import('../../lib/db')
    const db = openWechatDb(STATE_DIR)
    let provider = 'claude'
    let result
    try {
      provider = await profileProvider(chatId, args.provider, db)
      const { synthesizeProfile } = await import('../../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('../../daemon/life-stores')
      const dryRun = Boolean(args['dry-run'])
      result = await synthesizeProfile({
        stateDir: STATE_DIR,
        adminChatId: chatId,
        sdkEval: makeProfileSdkEval(provider),
        dryRun,
        lifeStores: makeLifeStoresReader(db, STATE_DIR),
        generatedBy: args.auto ? 'auto' : 'manual',
        modelProvider: provider,
      })
    } finally {
      db.close()
    }

    const dryRun = Boolean(args['dry-run'])
    const output = MemoryProfileOutput.parse({
      ok: true,
      chatId,
      provider,
      dryRun,
      sourceStats: result.profile?.sourceStats,
      sourceFingerprint: result.profile?.sourceFingerprint,
      ...result,
    })
    if (args.json) {
      console.log(JSON.stringify(output, null, 2))
      return
    }
    console.log(`画像对象: ${chatId}  ·  provider: ${provider}${dryRun ? '  ·  (dry-run)' : ''}`)
    console.log(`工作侧: ${result.projectsFound} 个项目: ${result.projectNames.join(', ') || '(无)'}  ·  ${result.filesScanned} 文件`)
    console.log(`生活侧: ${result.observationsFound} 观察 · ${result.milestonesFound} 里程碑 · ${result.memoryNotesFound} 记忆笔记  ·  prompt ${result.promptChars} 字`)
    if (dryRun) { console.log('(dry-run — 未调用 LLM、未写入)'); return }
    if (result.written) console.log(`已写入 ${result.written.path} (${result.written.bytesWritten}B)`)
    else console.log('未写入(记忆不足或 LLM 返回无效 JSON)')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (args.json) { console.log(JSON.stringify(MemoryProfileOutput.parse({ ok: false, error: msg }))); return }
    console.error(msg); process.exit(1)
  }
}

const memoryProfileGenerateCmd = defineCommand({
  meta: {
    name: 'generate',
    description: 'Generate or refresh memory/<chat-id>/_profile.json for the desktop memory page',
  },
  args: {
    'chat-id': { type: 'string', description: 'Admin chat_id (default: sole admin in access.json)' },
    provider: { type: 'string', description: 'Force provider claude|codex (default: admin conversation provider)' },
    'dry-run': { type: 'boolean', default: false, description: 'Discover + build prompt; make no LLM call and no write' },
    auto: { type: 'boolean', default: false, description: 'Mark generatedBy as auto (for daemon/background callers)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    await runMemoryProfileGenerate(args)
  },
})

const memoryProfileStatusCmd = defineCommand({
  meta: {
    name: 'status',
    description: 'Show whether memory/<chat-id>/_profile.json is missing, fresh, stale, or blocked by too little memory',
  },
  args: {
    'chat-id': { type: 'string', description: 'Admin chat_id (default: sole admin in access.json)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    try {
      const chatId = await resolveProfileChatId(args['chat-id'])
      const { openWechatDb } = await import('../../lib/db')
      const db = openWechatDb(STATE_DIR)
      let status
      try {
        const { getMemoryProfileStatus } = await import('../../lib/memory-synthesis')
        const { makeLifeStoresReader } = await import('../../daemon/life-stores')
        status = await getMemoryProfileStatus({ stateDir: STATE_DIR, adminChatId: chatId, lifeStores: makeLifeStoresReader(db, STATE_DIR) })
      } finally {
        db.close()
      }
      const output = MemoryProfileStatusOutput.parse({ ok: true, ...status })
      if (!output.ok) throw new Error(output.error)
      if (args.json) {
        console.log(JSON.stringify(output, null, 2))
        return
      }
      console.log(`画像状态: ${output.status} · ${output.reason}`)
      console.log(`来源: ${output.sourceStats.memoryNotesFound} 记忆笔记 · ${output.sourceStats.observationsFound} 观察 · ${output.sourceStats.milestonesFound} 里程碑 · ${output.sourceStats.projectsFound} 项目`)
      if (output.generatedAt) console.log(`上次生成: ${new Date(output.generatedAt).toLocaleString()}`)
      if (output.minRefreshAfter) console.log(`自动刷新最早: ${new Date(output.minRefreshAfter).toLocaleString()}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) { console.log(JSON.stringify(MemoryProfileStatusOutput.parse({ ok: false, error: msg }))); return }
      console.error(msg); process.exit(1)
    }
  },
})

const memoryProfileCmd = defineCommand({
  meta: {
    name: 'profile',
    description: 'User profile generation status and refresh commands',
  },
  args: {
    'chat-id': { type: 'string', description: 'Admin chat_id (default: sole admin in access.json)' },
    provider: { type: 'string', description: 'Force provider claude|codex (default: admin conversation provider)' },
    'dry-run': { type: 'boolean', default: false, description: 'Compatibility: generate with dry-run' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  subCommands: {
    status: memoryProfileStatusCmd,
    generate: memoryProfileGenerateCmd,
  },
})

const memoryProjectsCmd = defineCommand({
  meta: {
    name: 'projects',
    description: "List the admin's local Claude per-project memory (read-only source for the desktop viewer)",
  },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) {
    const { summarizeProjectMemories } = await import('../../lib/memory-synthesis')
    const projects = summarizeProjectMemories()
    if (args.json) { console.log(JSON.stringify({ ok: true, projects }, null, 2)); return }
    if (projects.length === 0) { console.log('(no local project memory found under ~/.claude/projects)'); return }
    for (const p of projects) {
      console.log(`${p.name}  (${p.files.length + (p.index ? 1 : 0)} 文件 · ${p.totalBytes}B)  [${p.encodedDir}]`)
      if (p.index) console.log('  - MEMORY.md (索引)')
      for (const f of p.files) console.log(`  - ${f.path}  (${f.bytes}B)`)
    }
  },
})

const memoryStatusCmd = defineCommand({
  meta: {
    name: 'status',
    description: "Show the synthesized overview's freshness + how much source memory is available to fold in",
  },
  args: {
    'chat-id': { type: 'string', description: 'Admin chat_id (default: sole admin in access.json)' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { existsSync, statSync } = await import('node:fs')

    // Resolve admin chat-id — same pattern as `memory synthesize`.
    let chatId = args['chat-id']
    if (!chatId) {
      let access: { admins?: string[] } = {}
      try { access = readJsonFile(join(STATE_DIR, 'access.json')) } catch { /* handled below */ }
      const admins = access.admins ?? []
      if (admins.length === 1) chatId = admins[0]!
      else {
        const m = admins.length === 0 ? 'No admins in access.json — pass --chat-id' : `Multiple admins (${admins.join(', ')}) — pass --chat-id`
        if (args.json) { console.log(JSON.stringify({ ok: false, error: m })); return }
        console.error(m); process.exit(1)
      }
    }

    const { OVERVIEW_FILENAME, summarizeProjectMemories } = await import('../../lib/memory-synthesis')
    const overviewPath = join(STATE_DIR, 'memory', chatId, OVERVIEW_FILENAME)
    const stat = existsSync(overviewPath) ? statSync(overviewPath) : null
    const ageDays = stat ? Math.floor((Date.now() - stat.mtimeMs) / 86_400_000) : null

    // Source material available to fold in: work (project memory) + life (db).
    const projects = summarizeProjectMemories().length
    let observations = 0, milestones = 0
    try {
      const { openWechatDb } = await import('../../lib/db')
      const { makeLifeStoresReader } = await import('../../daemon/life-stores')
      const db = openWechatDb(STATE_DIR)
      try {
        const reader = makeLifeStoresReader(db, STATE_DIR)
        observations = (await reader.listObservations(chatId)).length
        milestones = (await reader.listMilestones(chatId)).length
      } finally { db.close() }
    } catch { /* db absent — life counts stay 0 */ }

    if (args.json) {
      console.log(JSON.stringify({
        ok: true, chatId, exists: !!stat, path: overviewPath, bytes: stat?.size ?? 0,
        lastSynthesized: stat ? new Date(stat.mtimeMs).toISOString() : null, ageDays,
        source: { projects, observations, milestones },
      }))
      return
    }

    const sourceLine = `可整理来源: ${projects} 个项目 · ${observations} 条观察 · ${milestones} 个里程碑`
    if (!stat) {
      console.log(`还没整理过对你的理解（${overviewPath} 不存在）。`)
      console.log(sourceLine)
      console.log('跑 wechat-cc memory synthesize,或微信里说「整理记忆」。')
      return
    }
    console.log(`记忆总览: ${overviewPath}`)
    console.log(`上次整理: ${new Date(stat.mtimeMs).toLocaleString()}（${ageDays === 0 ? '今天' : `${ageDays} 天前`}）· ${stat.size}B`)
    console.log(sourceLine)
    if ((ageDays ?? 0) >= 7) console.log('⚠ 已超过一周,内容可能过时 —— 说「整理记忆」更新。')
  },
})

export const memoryCmd = defineCommand({
  meta: { name: 'memory', description: 'Companion v2 memory files (per user)' },
  subCommands: {
    list: memoryListCmd,
    read: memoryReadCmd,
    write: memoryWriteCmd,
    'profile-read': memoryProfileReadCmd,
    synthesize: memorySynthesizeCmd,
    nightly: memoryNightlyCmd,
    profile: memoryProfileCmd,
    projects: memoryProjectsCmd,
    status: memoryStatusCmd,
  },
})

/**
 * wechat-mcp daemon-control tools — admin-only self-diagnosis + remediation
 * (diagnostic_* / model_* / session_release / daemon_restart). Registered ONLY
 * for an admin-tier session; see the SESSION_IS_ADMIN gate in main.ts. Split
 * out of main.ts so the privileged surface lives in one auditable file.
 * Behavior verbatim from the original inline registrations.
 */
import z from 'zod'   // 默认导入:vitest 下具名导入 z 是 undefined(同 tools-social.ts)
import { hostname } from 'node:os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'
import { formatCliSessionDigest, type CliDigestView } from '../../core/cli-session-digest'
import { formatOverseerToday, type OverseerToday } from '../../core/overseer-today'

/** 本会话的 provider id —— daemon 在 spawn wechat-mcp 子进程时写进 env
 *  (mcp-specs.ts participantTag)。model_get/model_set 默认作用于它,这样
 *  /api /agy 对话里说「换模型」,改的是自己的,不是全局默认那家的。 */
const OWN_PROVIDER = process.env.WECHAT_PARTICIPANT_TAG

export function registerDaemonTools(server: McpServer, client: InternalApiClient): void {
  // These let the operator ask the bot "检查下为什么 X 不回消息了". Read-only.

  server.registerTool(
    'diagnostic_turns',
    {
      title: 'Recent turn outcomes',
      description: '【管理员】查询每个对话回合的结局（completed/timeout/auth_failed/error）、耗时、是否回复，用于诊断"为什么某个 chat 不回消息了"。给 chatId 看该 chat 最近的回合（倒序）；不给则看全局最近。limit 默认 50。',
      inputSchema: {
        chatId: z.string().optional().describe('微信 chat_id；省略则返回所有 chat 的最近回合'),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ chatId, limit }) => {
      try {
        const qs = new URLSearchParams()
        if (chatId) qs.set('chatId', chatId)
        if (limit != null) qs.set('limit', String(limit))
        const r = await client.request<unknown>('GET', `/v1/turns${qs.toString() ? `?${qs}` : ''}`)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'diagnostic_turns')
      }
    },
  )

  server.registerTool(
    'diagnostic_sessions',
    {
      title: 'Live agent sessions',
      description: '【管理员】列出当前缓存的 agent 会话（alias / provider / chat_id / lastUsedAt）。lastUsedAt 很久以前说明该会话可能闲置或卡住。用于判断哪个会话需要释放/重启。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('GET', '/v1/sessions')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'diagnostic_sessions')
      }
    },
  )

  server.registerTool(
    'diagnostic_health',
    {
      title: 'Daemon health',
      description: '【管理员】daemon 总体健康：pid、turn 记录存储是否就绪、当前活跃会话数、心跳是否新鲜（heartbeat_fresh=false 表示 daemon 可能卡住/没在服务）。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('GET', '/v1/health')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'diagnostic_health')
      }
    },
  )

  // 主人终端里的 Claude Code / Codex 会话(2026-10-14):与微信「终端」同一份列表、同一套措辞。只读。
  server.registerTool(
    'terminal_sessions',
    {
      title: 'Terminal agent sessions',
      description: '【管理员】列出主人自己在终端里开的 Claude Code / Codex 会话：等你批准的在前（附怎么在微信里回 y/n），其余按最近动静排，带项目、状态（在跑 / 做完了 / 没动静了）、最后一句、会话码。主人问「我终端里那几个在干嘛」「哪个在等我」时用。只读：你不能替主人批权限，告诉主人回「y 码 / n 码」，或「看 码」「@码 话」。',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('最多几条，默认 8'),
      },
    },
    async ({ limit }) => {
      try {
        const r = await client.request<{ ok?: boolean; sessions?: CliDigestView[] }>('GET', '/v1/cli/sessions?limit=50')
        const sessions = Array.isArray(r?.sessions) ? r.sessions : []
        const text = formatCliSessionDigest(sessions, { now: Date.now(), localMachine: hostname(), max: limit ?? 8 })
        return { content: [{ type: 'text', text }] }
      } catch (err) {
        return passthroughErrorResult(err, 'terminal_sessions')
      }
    },
  )

  // 「今天」一眼看完(2026-10-14):与微信「日报」同一份数据、同一套措辞。只读、确定性(不叫模型)。
  server.registerTool(
    'today_digest',
    {
      title: 'Today digest',
      description: '【管理员】主人所有编码 agent 过去 24 小时的一眼看完：终端里的 Claude Code / Codex + CC 自己「一起做」的事，分成等你（附微信里怎么回）/ 做完 / 在跑 / 可能卡住（失败、中断、30 分钟没动静）。主人问「今天都做完了什么」「有什么等我的」「哪个卡住了」时用。只读：你不能替主人批权限。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<{ ok?: boolean; today?: OverseerToday }>('GET', '/v1/overseer/today')
        if (!r?.today) return { content: [{ type: 'text', text: '现在读不到今天的情况。' }], isError: true }
        return { content: [{ type: 'text', text: formatOverseerToday(r.today, { now: Date.now() }) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'today_digest')
      }
    },
  )

  // CC 的信(2026-10-16):主人当面要一封 / 开关不定期的信 / 看写过哪些。信由 daemon 写好排成信纸寄到微信。
  server.registerTool(
    'cc_letter',
    {
      title: 'Letters to the owner',
      description: '【管理员】给主人写信。action=write:主人说「给我写封信」「写封信给我吧」或倾诉完想要一封信时用 —— daemon 会用你记得的事写一封、排成信纸图片寄到主人微信(要一两分钟,工具立刻返回);把主人刚才说的、想要什么样的信,概括进 request。action=enable / disable:主人说以后时不时给 ta 写信 / 别写了。action=status:看开没开、写过哪些。别把信的内容先在聊天里说出来,也别承诺哪天会收到下一封 —— 不定期的信本来就是突然到的。',
      inputSchema: {
        action: z.enum(['write', 'enable', 'disable', 'status']),
        request: z.string().max(2000).optional().describe('action=write 时:主人想要的那封信,原话或大意'),
      },
    },
    async ({ action, request }) => {
      try {
        if (action === 'write') {
          await client.request('POST', '/v1/letters/write', request ? { request } : {})
          return { content: [{ type: 'text', text: '在写了:一两分钟后信纸图片会直接寄到主人微信(写不成也会自己告诉主人)。你只说一句「在给你写,写好寄过去」,别在聊天里复述或预告信的内容。' }] }
        }
        if (action === 'enable' || action === 'disable') {
          await client.request('POST', '/v1/letters/settings', { enabled: action === 'enable' })
          return { content: [{ type: 'text', text: action === 'enable' ? '好了:以后会时不时给主人写一封信(大约一个月一封,哪天不定)。' : '好了:不再主动写信了;主人想要时仍然可以当面要。' }] }
        }
        const s = await client.request<{ enabled?: boolean; scheduled?: boolean; pending?: { waiting_for_owner: boolean } | null; letters?: Array<{ day: string; sent_at: string | null; requested: boolean; opening: string }> }>('GET', '/v1/letters')
        const list = (s?.letters ?? []).slice(0, 8).map(l => `- ${l.day}${l.requested ? '(主人要的)' : ''}${l.sent_at ? '' : '(还没寄出)'}:${l.opening}…`).join('\n')
        const text = [
          s?.enabled ? '不定期的信:开着。' : '不定期的信:关着(主人说要才开)。',
          s?.pending ? (s.pending.waiting_for_owner ? '有一封写好了在等寄:微信不让主动发,主人下次说话时寄出。' : '有一封写好了在等寄。') : '',
          list ? `写过的信:\n${list}` : '还没写过信。',
        ].filter(Boolean).join('\n')
        return { content: [{ type: 'text', text }] }
      } catch (err) {
        return passthroughErrorResult(err, 'cc_letter')
      }
    },
  )

  // ─── daemon remediation (admin-only, mutating) ────────────────────────────────
  // The "fix" half of the self-heal loop. Same admin gating (ToolKind
  // 'daemon_remediate', denied for trusted/guest). Each returns a verification
  // read-back so the agent can confirm the action took effect before reporting.

  server.registerTool(
    'model_get',
    {
      title: 'Current model',
      description: '【管理员】读取固定的 agent 模型（provider + model）。默认查你自己这个 provider;传 provider 可查别家。改之前/之后用它核对。',
      inputSchema: { provider: z.string().optional().describe('claude / codex / cursor / openai / gemini / agy;省略 = 你自己') },
    },
    async ({ provider }) => {
      try {
        const target = provider ?? OWN_PROVIDER
        const r = await client.request<unknown>('GET', target ? `/v1/model?provider=${encodeURIComponent(target)}` : '/v1/model')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'model_get')
      }
    },
  )

  server.registerTool(
    'model_set',
    {
      title: 'Switch model',
      description: '【管理员】切换固定的 agent 模型（写入 agent-config.json）。默认改你自己这个 provider 的模型;传 provider 可改别家。写完会释放该 provider 的活会话、并清掉它的会话存档,主人下一句就跑在新模型上(claude/agy/openai 不用重启;cursor 下一段对话就生效(原会话上下文不再续接);codex 要重启 daemon)。返回写入后的 model + 释放数作为核对。传完整带版本号的 id（如 claude-opus-5 / claude-opus-4-8），不要传裸别名（opus/sonnet）。',
      inputSchema: {
        model: z.string().min(1).describe('完整模型 id，如 claude-opus-5 / claude-sonnet-4-6 / DeepSeek'),
        provider: z.string().optional().describe('claude / codex / cursor / openai / gemini / agy;省略 = 你自己'),
      },
    },
    async ({ model, provider }) => {
      try {
        const target = provider ?? OWN_PROVIDER
        const r = await client.request<unknown>('POST', '/v1/model', target ? { model, provider: target } : { model })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'model_set')
      }
    },
  )

  server.registerTool(
    'session_release',
    {
      title: 'Release a wedged session',
      description: '【管理员】强制释放某个卡住/闲置的 agent 会话——该 chat 的下一条消息会重开一个干净子进程。用 diagnostic_sessions 拿到 alias/providerId/chatId。返回 { ok, released, sessions }：released=false 表示没有匹配的活跃会话（key 不对/已经没了），不是真的释放了，要据此判断。',
      inputSchema: {
        alias: z.string(),
        providerId: z.string().describe('claude / codex / cursor'),
        chatId: z.string(),
      },
    },
    async ({ alias, providerId, chatId }) => {
      try {
        const r = await client.request<unknown>('POST', '/v1/sessions/release', { alias, providerId, chatId })
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'session_release')
      }
    },
  )

  server.registerTool(
    'daemon_restart',
    {
      title: 'Restart the daemon',
      description: '【管理员】优雅重启整个 daemon（launchd/systemd 会自动重新拉起）。重启期间会短暂断连、在飞的回合会丢。仅在释放会话仍无法恢复时使用。建议先跟用户确认。返回 { ok, restarting }。',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await client.request<unknown>('POST', '/v1/daemon/restart')
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      } catch (err) {
        return passthroughErrorResult(err, 'daemon_restart')
      }
    },
  )
}

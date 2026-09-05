/**
 * 社交工具面(spec 2026-09-05-social-tools):伙伴替主人用社交层的十个
 * MCP 工具。全是 internal API 的薄壳 —— 打 trusted 路由,把路由 JSON 原样
 * 交给模型,**不拼任何中文文案**;回话怎么说是模型的活(spec §1 规则)。
 * 权限:main.ts 只在 admin 会话注册;user-tier.ts 把它们归到 `social_act`
 * (admin-only);路由层再拒一次非 admin token。
 *
 * `social_seek` 是老工具(agent-social M1 → 心愿 §4 repoint),名字与行为
 * 都不动:只出脱敏预览存草稿,主人点头后模型再调 `wish_send`。
 */
import * as z from 'zod'
import type { ZodRawShape } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

type TextResult = { content: Array<{ type: 'text'; text: string }> }
const asText = (v: unknown): TextResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })

/** 心愿 id / 明信片 replyId 的前缀:服务端做前缀匹配,至少给两位。 */
const REF = z.string().min(2)

interface WishProposeResponse {
  ok: boolean
  id?: string
  preview?: string
  error?: string
  violations?: string[]
}

export function registerSocialSeekTool(server: McpServer, client: InternalApiClient): void {
  server.registerTool(
    'social_seek',
    {
      title: 'Propose a social wish via people the owner knows',
      description: '替主人向认识的人打听——本工具只生成脱敏预览并暂存草稿,不会立即发出。返回 { ok, id, preview } 或 { ok:false, error, violations }。把 preview 原样念给主人;主人点头(任何肯定的说法)再调 wish_send,「算了」调 wish_cancel;若 ok:false,原样告诉主人哪些话不能说出去。仅管理员可用。',
      inputSchema: {
        topic: z.string().describe('要寻找同好/资源的话题,例如"周末爬山搭子"'),
        city: z.string().optional().describe('可选,限定城市范围'),
      },
    },
    async ({ topic, city }) => {
      try {
        const resp = await client.request<WishProposeResponse>('POST', '/v1/social/wish', { text: topic + (city ? `(${city})` : '') })
        if (!resp.ok) return asText(resp)
        const hint = `已生成脱敏预览并暂存;把 preview 念给主人,主人点头后调 wish_send('${resp.id ?? '<id>'}'),「算了」调 wish_cancel。(主人也可以直接回「派 ${resp.id ?? '<id>'}」)`
        return asText({ ...resp, hint })
      } catch (err) {
        return passthroughErrorResult(err, 'social_seek')
      }
    },
  )
}

/** 一个 GET 工具:没有参数,路由 JSON 原样返回。 */
function registerGet(server: McpServer, client: InternalApiClient, name: string, title: string, description: string, path: string): void {
  server.registerTool(name, { title, description, inputSchema: {} }, async () => {
    try { return asText(await client.request('GET', path)) }
    catch (err) { return passthroughErrorResult(err, name) }
  })
}

/** 一个「按引用动作」的 POST 工具:一个字符串参数,映射成 body 里的一个键。 */
function registerRefPost(
  server: McpServer, client: InternalApiClient,
  name: string, title: string, description: string,
  path: string, argName: 'ref' | 'reply_ref', bodyKey: 'id' | 'reply_id', argDescription: string,
): void {
  server.registerTool(name, { title, description, inputSchema: { [argName]: REF.describe(argDescription) } as ZodRawShape }, async (args) => {
    try { return asText(await client.request('POST', path, { [bodyKey]: (args as Record<string, string>)[argName] })) }
    catch (err) { return passthroughErrorResult(err, name) }
  })
}

export function registerSocialTools(server: McpServer, client: InternalApiClient): void {
  registerSocialSeekTool(server, client)

  registerGet(server, client, 'wish_list',
    'List the owner\'s open wishes and the postcards that came back',
    '主人开着的心愿,以及每条收到的回音(postcards:reply_id、via_label=哪位朋友转来的、preview、requested=是否已在问)。主人问「谁回了心愿」「那个 X 的回音」先调这个;要「认识」某个回音的人,在 postcards 的 preview 里对上,拿 reply_id 调 intro_request。返回路由 JSON 原样。仅管理员可用。',
    '/v1/social/wishes')

  registerRefPost(server, client, 'wish_send',
    'Send a proposed wish (owner has confirmed the preview)',
    '主人对 social_seek 的预览点头之后才调:把草稿真正派出去。ref 是心愿 id 或前缀。返回 { ok, sent_to } 或 { ok:false, reason }(no_channels=还没有认识的人,too_many_open=开着的太多)。仅管理员可用。',
    '/v1/social/wish/send', 'ref', 'id', '心愿 id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'wish_cancel',
    'Cancel a wish (draft or open)',
    '主人说「算了」「收了」:作废草稿或关掉开着的心愿(之后的回音仍会进包袱)。ref 是心愿 id 或前缀。返回路由 JSON 原样。仅管理员可用。',
    '/v1/social/wish/cancel', 'ref', 'id', '心愿 id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'intro_request',
    'Ask to be introduced to the friend-of-a-friend behind a postcard',
    '主人说「把那个 X 认识一下」:对 wish_list 里某张 postcard 的 reply_id 发起介绍,由转来的那位朋友去问对方;对方点头后双方自动成为朋友。主人这句话本身就是指令,直接调,不必再确认。返回 { ok:true, reply_id } 或 { ok:false, reason }(not_found / ambiguous=前缀对到多张,列出来让主人选 / already_requested=已经在问了 / send_failed)。仅管理员可用。',
    '/v1/social/intro/request', 'reply_ref', 'reply_id', 'postcard 的 reply_id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'intro_accept',
    'Accept an introduction offer (someone wants to meet the owner)',
    '主人对 intro_offers 里某条邀约点头:「同意」「可以认识」。直接调,不必再确认。返回 { ok:true, reply_id } 或 { ok:false, reason }(not_found=没有这条或过期了 / ambiguous / send_failed=没送出去,邀约还在,可重试)。仅管理员可用。',
    '/v1/social/intro/accept', 'reply_ref', 'reply_id', '邀约的 reply_id 或前缀(至少 2 位)')

  registerRefPost(server, client, 'intro_decline',
    'Decline an introduction offer',
    '主人对 intro_offers 里某条邀约摇头:「不了」「算了」。直接调,不必再确认。返回 { ok:true, reply_id } 或 { ok:false, reason }。仅管理员可用。',
    '/v1/social/intro/decline', 'reply_ref', 'reply_id', '邀约的 reply_id 或前缀(至少 2 位)')

  registerGet(server, client, 'intro_offers',
    'List introduction offers waiting for the owner\'s nod',
    '等主人点头的邀约:{ offers:[{ reply_id, hint=对方当初问的话题, via_label=哪位朋友转来的, at }] }。主人问「有人想认识我吗」先调这个;点头调 intro_accept,摇头调 intro_decline。仅管理员可用。',
    '/v1/social/intro/offers')

  registerGet(server, client, 'relationships',
    'List who the owner\'s companion knows',
    '伙伴认识的人(关系视图):每条有 label、kind、origin(配对 / 经朋友介绍 / 来找我聊过 …)、familiarity。主人问「我都认识谁」「和谁熟」先调这个。返回路由 JSON 原样。仅管理员可用。',
    '/v1/social/relationships')

  server.registerTool(
    'visit',
    {
      title: 'Send the companion to visit a friend\'s companion',
      description: '主人说「去串个门」「去 X 家看看」:让伙伴去朋友的伙伴那里串门(后台进行,结果之后进包袱)。target 可选,是朋友的名字或信道 id;不给就由伙伴自己挑。直接调,不必再确认。返回 { ok:true, started:true } 或 { ok:false, reason }(unknown_channel=没有这个朋友)。仅管理员可用。',
      inputSchema: { target: z.string().min(1).optional().describe('可选:朋友的名字或信道 id') },
    },
    async ({ target }) => {
      try { return asText(await client.request('POST', '/v1/social/visit', target === undefined ? {} : { target })) }
      catch (err) { return passthroughErrorResult(err, 'visit') }
    },
  )
}

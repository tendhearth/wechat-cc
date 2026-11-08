/**
 * 手机令牌(设备 / 链接)看「一件事」的范围(P3 设计稿 2026-11-05-p3-one-route-family「按范围不按路径的差别」)。
 *
 * 以前写在手机处理器里(settings-panel.ts 的 `/m/api/matters`、`/m/api/matter`);P3c-1 起 `/v1/matters`、`/v1/matter`
 * 是这两份数据唯一的处理器,手机令牌从面板那一口进来也走它们 —— 规矩随令牌走,不随路径走,所以搬到这里,两边共用一份。
 */

/**
 * 手机能不能看这件 matter:聊天 matter 只给主人自己的(别人的聊天 —— 访客、朋友 —— 不到手机)。
 * 列表筛选和按 id 打开(详情 / 解读)共用这一条,免得两条路漂开:列表藏住了,按 id 却能读出最近 50 条。
 */
export function phoneMayOpenMatter(matter: unknown, owner: string | null): boolean {
  const m = (matter ?? {}) as { kind?: unknown; ownerChatId?: unknown }
  return m.kind !== 'chat' || (owner !== null && m.ownerChatId === owner)
}

/** 回复附带的旁白 / 语音文字 / 附件名和消息 id 只给已配对设备(和信、chat/file 一样);10 分钟的链接令牌只看正文。 */
export function withoutReplyExtras<T>(detail: T): T {
  const events = (detail as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return detail
  return { ...detail, events: events.map(e => {
    if (!e || typeof e !== 'object') return e
    const { replyExtras: _x, messageId: _m, ...rest } = e as Record<string, unknown>
    return rest
  }) }
}

/** 手机这条线上一帧正文的预算(中继一帧 512 KiB,给隧道的 JSON 外壳和 base64 留出余量)。面板与终端会话的手机表共用这一个数。 */
export const PHONE_FRAME_BUDGET_BYTES = 300 * 1024

/**
 * 这份 JSON 正文经中继再包一层({rid,status,body} 再 stringify 一遍,然后封装 + base64)以后,会不会顶破一帧。
 * 隧道把正文当字符串再序列化一次,引号和反斜杠会翻倍,所以按包好以后的字节数比。
 */
export function framedTooLargeFor(body: string, budget: number): boolean {
  const framed = JSON.stringify({ rid: 'r'.repeat(64), status: 200, body })
  return Buffer.byteLength(framed, 'utf8') > budget
}

/**
 * 详情里唯一可选的大块是回复旁白(主人对话每行至多 20 × 4000 字,只给设备)。一帧装不下 ⇒ 从最早的回复起逐条去掉旁白,
 * 正文、附件、决定都不动。`wrap` = 线上真正写出去的那一层(手机别名是 `{ ok: true, ... }`,`/v1` 是原样)。
 * 回去掉旁白之后的正文字符串;去完了还装不下由调用方判(再 framedTooLargeFor 一次)。
 */
export function withoutOldNarrationFor(detail: unknown, budget: number, wrap: (d: object) => object = d => d): string {
  let body = JSON.stringify(wrap(detail as object))
  const events = (detail as { events?: unknown } | null)?.events
  if (!framedTooLargeFor(body, budget) || !Array.isArray(events)) return body
  const copy = [...events] as unknown[]
  const narrated = copy.map((e, i) => ({ e: e as { createdAt?: unknown; replyExtras?: { narration?: unknown } } | null, i }))
    .filter(({ e }) => !!e && typeof e === 'object' && !!e.replyExtras && typeof e.replyExtras === 'object' && e.replyExtras.narration !== undefined)
    .sort((a, b) => (typeof a.e!.createdAt === 'number' && typeof b.e!.createdAt === 'number' ? a.e!.createdAt - b.e!.createdAt : 0) || a.i - b.i)
  for (const { e, i } of narrated) {
    const { narration: _dropped, ...replyExtras } = e!.replyExtras!
    copy[i] = { ...e, replyExtras }
    body = JSON.stringify(wrap({ ...(detail as object), events: copy }))
    if (!framedTooLargeFor(body, budget)) break
  }
  return body
}

/** The link page is a status fallback. Never reuse a full device detail as its DTO. */
const pickFields = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]))
export function linkMatterSummary<T>(value: T): T {
  const m = value as Record<string, unknown>
  const out = pickFields(m, ['id','kind','title','status','state','archivedAt','createdAt','updatedAt','origin','agents','agentNames','networkSuspended','taskState'])
  for (const key of ['projectPath','ownerChatId','originMatterId','originMessageId']) if (key in m) out[key] = null
  return out as T
}
export function linkMatterStatus<T>(value: T): T {
  const d = value as Record<string, unknown>, matter = d.matter as Record<string, unknown>
  const task = d.task as Record<string, unknown> | null | undefined
  const rows = (key: string) => Array.isArray(d[key]) ? (d[key] as Record<string, unknown>[]).filter(row => row.taskId === matter.id) : []
  const events = Array.isArray(d.events) ? d.events as Record<string, unknown>[] : [], last = events.at(-1)
  const activity = last?.activity as Record<string, unknown> | undefined
  return {
    matter: linkMatterSummary(matter),
    ...(task !== undefined ? {task: task ? {...pickFields(task,['id','title','status','phase','providerId','updatedAt','archivedAt','rewind']),path:'',error:task.error === 'execution_model_unsupported' ? task.error : null} : null} : {}),
    events: last?.kind === 'tool_call' && activity?.status === 'running' ? [{...pickFields(last,['kind','createdAt']),text:'',activity:pickFields(activity,['type','status','label'])}] : [],
    permissions: rows('permissions').map(row => ({...pickFields(row,['id','taskId','createdAt']),tool:'',description:''})),
    questions: rows('questions').map(row => ({...pickFields(row,['id','taskId','createdAt']),questions:[]})),
    artifacts: [], inputs: [], bindings: [], sessions: [],
    ...pickFields(d,['runId','quotaHandoff']),
  } as T
}

/** Home still supplies the same presence/work fallback, without personal feed/news. */
export function linkHomeStatus<T>(value: T): T {
  const d=value as Record<string,unknown>,p=d.presence as Record<string,unknown>|null,w=d.work as Record<string,unknown>|undefined
  return {ok:d.ok,synced_at:d.synced_at,today:d.today,
    presence:p?{presence:p.presence,activity:pickFields(p.activity as Record<string,unknown>,['kind','label','since']),news:{unread:0,latest_kind:null,latest_title:null}}:null,
    ...(w?{work:{focus:w.focus?pickFields(w.focus as Record<string,unknown>,['id','title','kind']):null,partial:w.partial}}:{}),
    ...pickFields(d,['presence_error']),unread:0,seen_until:d.seen_until,events:[],next_cursor:null,sources_degraded:d.sources_degraded} as T
}

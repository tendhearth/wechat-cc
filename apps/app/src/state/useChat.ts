import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatJobT, ChatPageT } from '../backend/types'
import { ACCEPTED_TTL_MS, acceptedSettled, chatBubbles, chatSendOutcome, mergeChatPages, olderCursor, rebaseOlder, type Bubble } from '../view/chat'
import { composeTooLong } from '../view/compose'
import { useBackendCtx } from './BackendProvider'
import { deleteDraft, dropReceipt, getDraft, isReplied, listReceipts, markReplied, materialDraftId, pairingGen, putReceipt, requestIdFor, subscribeReceipts } from './drafts'
import { bytesToBase64, uploadImages, withImageMarker, type PickedImage } from './image-upload'
import { useQuery, useSubmit } from './hooks'
import { useChatUpdates } from './useChatUpdates'

export type ChatSendOutcome = 'ok' | 'busy' | 'ccBusy' | 'uncertain' | 'revoked' | 'failed' | 'refused' | 'tooLong' | 'imagesGone' | 'imagesUnsupported'
const NO_JOB = { pending: null, failed: null } as const

/**
 * 跟 CC 说(spec 2026-10-01 §4):最新一页走查询缓存(重连 epoch 前进由 store 统一重拉);
 * matter/<聊天> 主题版本或阶段一变就重拉(回复是异步的,phase=working 时也会变);往上翻的旧页只在本页内存里。
 * 发送不做乐观成功:服务端回执里的 pending 就是「我」的气泡。
 * GET chat 回 not_found(还没设主人对话 / 还没说过话)⇒ 当空对话,照样能说(第一句会建好它)。
 */
export function useChat(): {
  page: ChatPageT | undefined; error: unknown; noOwner: boolean; loading: boolean
  /** 只读核对:刷新有限历史与 pending/failed。未找到或读失败不代表没送达,不会重发或清草稿。 */
  refresh(): Promise<void>
  seek(id: string): Promise<boolean>
  canLoadLater:boolean; loadingLater:boolean; laterAfterId:string|null; loadLater():Promise<void>
  bubbles: Bubble[]; canLoadOlder: boolean; loadingOlder: boolean; loadOlder(): Promise<void>
  /** images:选好的图(2026-10-06),先传到电脑再说这一句;有图时文字可空。 */
  send(text: string, images?: readonly PickedImage[]): Promise<ChatSendOutcome>
  /** 失败 / 可能没送到 / 没确认送到的那句,用**同一个** requestId 再说一次(daemon 去重);已知有回复的 id 不重发。 */
  retry(requestId: string, text: string): Promise<ChatSendOutcome>
  /** 「没确认送到 · 不管它」:清掉本机回执气泡。 */
  dismiss(requestId: string): void
} {
  const { backend } = useBackendCtx()
  const submit = useSubmit()
  const latest = useQuery<ChatPageT>('chat:latest', () => backend.chat({}), { refreshOnMount: true })
  const noOwner = latest.error === 'not_found'
  const [anchorState,setAnchorState]=useState<{backend:typeof backend;pages:ChatPageT[];earlier:string|null;later:string|null}|null>(null)
  const anchorWindow=anchorState?.backend===backend?anchorState.pages.at(-1)??null:null
  const setAnchorWindow=(page:ChatPageT,append=false,later:string|null=null)=>setAnchorState(old=>({backend,earlier:page.nextBefore,pages:append&&old?.backend===backend?[...old.pages,page]:[page],later:append&&old?.backend===backend?old.later:later}))
  const [loadingLater,setLoadingLater]=useState(false)
  const laterAfterId=anchorState?.backend===backend?anchorState.later:null
  const [older, setOlder] = useState<ChatPageT[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  // 本机回执(可以几句)放在模块里(drafts.ts,终审 I1):离开 /chat 再回来、daemon 中间重启,那句照样显示「可能没送到」。
  // at 是 daemon 的钟(job.since,用来比消息时间);localAt 是本机收到回执的时刻,
  // 过没过 TTL 按本机计时换算成 daemon 的钟,两边钟不对也不怕。
  const accepted = useSyncExternalStore(subscribeReceipts, listReceipts, listReceipts)
  const [nowLocal, setNowLocal] = useState(() => Date.now())
  const drop = dropReceipt
  // 旧页的「代」:最新页刷新后旧页被清掉(接不上了),在途的往上翻结果就作废。
  const olderGen = useRef(0)
  useEffect(() => () => { olderGen.current++ }, [])
  const prevLatest = useRef<ChatPageT | undefined>(undefined)
  useEffect(() => {
    const next = latest.data
    if (!next) return
    const prev = prevLatest.current
    prevLatest.current = next
    setOlder(o => {
      const r = rebaseOlder(prev, next, o)
      if (r.length === 0 && o.length > 0) olderGen.current++
      return r
    })
  }, [latest.data])

  const { refresh } = latest
  useChatUpdates(latest.data?.matterId, refresh)

  const page = latest.data ?? NO_JOB
  const msgs = useMemo(() => (latest.data ? mergeChatPages(latest.data, [...older, ...(anchorState?.backend===backend?anchorState.pages:[])]) : []), [latest.data, older, anchorState, backend])

  // 修订 Ruling 5:只有看到落地才清回执;过了 TTL 气泡改成「没确认送到」,等重试或「不管它」。
  useEffect(() => {
    const done = accepted.filter(a => acceptedSettled(a, msgs, page))
    for (const a of done) { markReplied(a.requestId); dropReceipt(a.requestId) }
  }, [accepted, msgs, page])
  useEffect(() => {
    // 只在到点时更新 nowLocal(不在这里同步设,否则自己触发自己)
    const now = Date.now()
    const next = accepted.map(a => a.localAt + ACCEPTED_TTL_MS + 50 - now).filter(ms => ms > 0)
    if (!next.length) return
    const id = setTimeout(() => setNowLocal(Date.now()), Math.min(...next))
    return () => clearTimeout(id)
  }, [accepted, nowLocal])

  const anchorGeneration = useRef(0)
  useEffect(() => () => { anchorGeneration.current++ }, [backend])
  const seek = useCallback(async (id: string): Promise<boolean> => {
    const selection = ++anchorGeneration.current
    if (!id || id.length > 200) return false
    if (msgs.some(m => m.id === id)) return true
    if (!latest.data) return false
    const generation = olderGen.current
    if (backend.conversationWindow) {
      const window = await backend.conversationWindow({ anchor: id })
      if (selection !== anchorGeneration.current || generation !== olderGen.current) return false
      setAnchorWindow(windowPage(latest.data, window),false,window.messages.some(m=>latest.data!.messages.some(n=>n.id===m.messageId))?null:window.later)
      return window.messages.some(m => m.messageId === id)
    }
    let before = olderCursor(latest.data, older)
    const pages: ChatPageT[] = []
    const seen = new Set<string>()
    while (before && !seen.has(before)) {
      seen.add(before)
      const page = await backend.chat({ before })
      if (generation !== olderGen.current) return false
      pages.push(page)
      if (page.messages.some(m => m.id === id)) { setOlder(o => [...o, ...pages]); return true }
      before = page.hasMore ? page.nextBefore : null
    }
    return false
  }, [backend, msgs, latest.data, older])

  const bubbles = useMemo(() => {
    const last = accepted[accepted.length - 1]
    const nowDaemon = last ? nowLocal + (last.at - last.localAt) : nowLocal
    return chatBubbles(msgs, page, accepted, nowDaemon)
  }, [msgs, page, accepted, nowLocal])

  const cursor = anchorWindow ? anchorState!.earlier : latest.data ? olderCursor(latest.data, older) : null
  const loadLater=useCallback(async()=>{
    if(!laterAfterId||!backend.conversationWindow||!latest.data||loadingLater)return
    const generation=anchorGeneration.current
    setLoadingLater(true)
    try {
      const window=await backend.conversationWindow({after:laterAfterId})
      if(generation!==anchorGeneration.current)return
      const joined=window.messages.some(m=>latest.data!.messages.some(n=>n.id===m.messageId))
      setAnchorState(old=>old?.backend===backend?{...old,pages:[...old.pages,windowPage(latest.data!,window)],later:joined?null:window.later}:old)
    }catch{/* Retain the gap and cursor for an explicit retry. */}finally{setLoadingLater(false)}
  },[backend,laterAfterId,latest.data,loadingLater])
  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return
    setLoadingOlder(true)
    const gen = olderGen.current,selection=anchorGeneration.current
    try { if(anchorWindow && backend.conversationWindow) { const w=await backend.conversationWindow({before:cursor});if(gen===olderGen.current&&selection===anchorGeneration.current){setAnchorWindow(windowPage(anchorWindow,w),true)} } else { const p = await backend.chat({ before: cursor }); if (gen === olderGen.current) setOlder(o => [...o, p]) } } catch { /* 翻不动就停在这;下次滑到顶再试 */ }
    finally { setLoadingOlder(false) }
  }, [backend, cursor, loadingOlder, anchorWindow])

  const say = useCallback(async (text: string, requestId: string, materials?: { draftId: string; attachmentIds: string[] }, images?: readonly PickedImage[]): Promise<ChatSendOutcome> => {
    let job: ChatJobT | null = null
    // 配对代:回执回来时若已换了配对(解除 / 换电脑),putReceipt / markReplied 不落
    const gen = pairingGen()
    const r = await submit('chat:say', async () => {
      // 图先传完(断点续传;已经传完的不再传),再说这一句;传不上 ⇒ 这一句不发,错误照常映射
      if (images?.length && materials) await uploadImages(backend, materials.draftId, images, bytesToBase64)
      job = materials ? await backend.chatSay(text, requestId, materials) : await backend.chatSay(text, requestId)
    })
    const out = chatSendOutcome(r)
    if (out !== 'ok') return out
    const j = job as ChatJobT | null
    if (j?.status === 'replied') {
      // daemon 去重表认得它且已回复:不再挂回执,只把新历史拉下来
      markReplied(requestId, gen)
      drop(requestId)
      await refresh()
    } else {
      // 先拉一页(带 pending)再挂回执,免得旧页上闪一下「可能没送到」
      await refresh()
      const localAt = Date.now()
      putReceipt({ requestId, text: materials ? withImageMarker(text, materials.attachmentIds.length) : text, at: j?.since ?? localAt, localAt, ...(materials ? { materials, sent: text } : {}) }, gen)
    }
    return 'ok'
  }, [backend, submit, refresh, drop])

  const send = useCallback(async (raw: string, images?: readonly PickedImage[]): Promise<ChatSendOutcome> => {
    const text = raw.trim()
    if (!text && !images?.length) return 'failed'
    if (composeTooLong(text)) return 'tooLong'
    // requestIdFor 不会交出已知有回复的 id;失败 / 不确定时草稿留着,同样正文(和同一组图)再点 ⇒ 同一个 id
    const materials = images?.length ? { draftId: materialDraftId('chat'), attachmentIds: images.map(i => i.id) } : undefined
    const r = await say(text, requestIdFor('chat', materials ? `${text}\u0000${materials.attachmentIds.join(',')}` : text), materials, images)
    // 发送途中主人又改了草稿 ⇒ 留着新打的字(Task 11 a)
    if (r === 'ok' && getDraft('chat') === raw) deleteDraft('chat')
    return r
  }, [say])

  const retry = useCallback(async (requestId: string, text: string): Promise<ChatSendOutcome> => {
    if (isReplied(requestId)) { drop(requestId); return 'ok' }
    // 带图的那句:原样带上同一组材料 id(图已经在电脑上了,不再传)
    const rec = listReceipts().find(r => r.requestId === requestId)
    return say(rec?.materials ? rec.sent ?? '' : text, requestId, rec?.materials)
  }, [say, drop])

  const dismiss = drop

  return { seek, canLoadLater:!!laterAfterId,loadingLater,laterAfterId,loadLater, page: latest.data, error: latest.error, loading: latest.loading, refresh, noOwner, bubbles, canLoadOlder: !!cursor, loadingOlder, loadOlder, send, retry, dismiss }
}

function windowPage(page: ChatPageT, window: import('zod').infer<typeof import('@wechat-cc/protocol').ConversationWindow>): ChatPageT {
  return { ...page, hasMore: !!window.earlier, nextBefore: window.earlier, messages: window.messages.map(m => ({ id: m.messageId, role: m.kind === 'user' ? 'me' as const : 'cc' as const, kind: 'text', text: m.text, truncated: !!m.truncated, at: m.createdAt, source: m.source === 'desktop' || m.source === 'phone' ? m.source : 'wechat', ...(m.replyExtras && typeof m.replyExtras==='object' ? m.replyExtras : {}) })) }
}

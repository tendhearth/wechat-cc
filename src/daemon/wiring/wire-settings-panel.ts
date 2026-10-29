/**
 * 设置面板(手机页 / 随身 CC 的那一层,重构第二批步 6c,从 pipeline-deps.ts 搬出来):把 daemon 里各处的读写面
 * (工作台、「一件事」、记忆、信、定时、对话、模型、知识库、表情、伙伴的一天 ……)收成 makeSettingsPanel 要的那一份。
 * 只是装配,不建环 —— 推送 / 主人对话 / 手机对话由手机那一簇(wirePhone)建好交进来。
 */
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import { loadAccess } from '../../lib/access'
import { loadAgentConfig, modelForProvider } from '../../lib/agent-config'
import type { Bootstrap } from '../bootstrap'
import type { WechatContacts, WechatVoice } from '../../ports/wechat'
import type { ChatPrefsStore } from '../chat-prefs'
import type { makeMessagesStore } from '../../lib/messages-store'
import type { MattersService } from '../../app/matters/service'
import { retractOnFactStatus, type MemoryNightlyRuntime } from '../../features/memory'
import type { PipelineDepsOpts } from './pipeline-deps-opts'
import { jobsView, jobsAction, mobileJobsRoutes } from '../../features/jobs'
import { makeJobsStore } from '../../adapters/store/scheduled-jobs-store'
import { loadCompanionConfig } from '../../lib/companion-config'
import { pickJobExecutor, readPlanLogDays } from '../../features/companion'
import { readJournalSeen, writeJournalSeen } from '../../adapters/store/journal-seen'
import { resolveAdminChatId } from '../companion/resolve-admin'
import { makeSettingsPanel, phoneMayOpenMatter, makeRemoteToggle, relayV2Configured, cacheSessions, type makePhoneOwner, type makePhoneChat, makePhoneInsight, makeApprovalExplainer, makeProgressSummarizer, currentPhoneClient } from '../../features/phone'
import { wrapCheapEvalWithAuthFailCheck } from '../bootstrap/wire-coordinator'
import { letterPagePath, listLetters, mobileLettersRoutes } from '../../features/letters'
import { makeEventsStore } from '../events/store'
import { hasLlmKey } from '../llm-keys'

export interface WireSettingsPanelDeps {
  /** 面板直接读的那几项 opts(只有这些)。 */
  opts: Pick<PipelineDepsOpts, 'activity' | 'cliActions' | 'cliSessions' | 'journal' | 'llmHealth' | 'matters' | 'overseerToday' | 'panelTokens' | 'presence' | 'requestRestart' | 'stickers' | 'turns' | 'workbench'>
  connections: Parameters<typeof makeSettingsPanel>[0]['connections']
  stateDir: string
  db: Db
  boot: Bootstrap
  /** 面板的「试听 / 语音转文字」和称呼。 */
  ilink: WechatContacts & { voice: WechatVoice }
  log: (tag: string, line: string) => void
  chatPrefs: ChatPrefsStore
  messagesStore: ReturnType<typeof makeMessagesStore>
  ownerChatId(): string | null
  mattersService: MattersService | null
  memoryNightly: MemoryNightlyRuntime
  /** 手机那一簇建好的几样(没开中继 / 没接 matters ⇒ null)。 */
  phone: {
    remoteCfg: { remote_tunnel?: boolean; relay_v2_url?: string }
    remoteTunnel: NonNullable<Parameters<typeof makeSettingsPanel>[0]['remoteInfo']> extends () => infer R ? R | null : never
    push: Parameters<typeof makeSettingsPanel>[0]['push'] | null
    owner: ReturnType<typeof makePhoneOwner> | null
    chat: ReturnType<typeof makePhoneChat> | null
  }
}

export function wireSettingsPanel(d: WireSettingsPanelDeps) {
  const { opts, connections, stateDir, db, boot, ilink, log, chatPrefs, messagesStore, ownerChatId, mattersService, memoryNightly } = d
  const { remoteCfg, remoteTunnel, push: phonePush, owner: phoneOwner, chat: phoneChat } = d.phone
// 原生会话读:单飞 + 短缓存(裁定 8),10 s 预算超了也不会堆积后台扫描。
const phoneSessions = opts.workbench ? cacheSessions({ list: (p, i) => opts.workbench!.listNativeHistory(p, i), read: (k, i) => opts.workbench!.readNativeHistory(k, i), readRecent: (k, i) => opts.workbench!.readRecentNativeHistory(k, i) }) : null
return makeSettingsPanel({
  connections,
  // 执行者叫什么(收敛清单 ⑥):唯一出处 registry;App 读行里的 displayName,不存名字表。
  executorName: (id: string) => boot.registry.namesOf(id).name,
  ...(opts.cliSessions ? { cliSessions: opts.cliSessions } : {}),
  ...(opts.cliActions ? { cliActions: opts.cliActions } : {}),
  ...(opts.overseerToday ? { overseerToday: opts.overseerToday } : {}),
  ...(phoneSessions ? { sessions: phoneSessions } : {}),
  // 在手机上接着做电脑上的会话:预览不缓存(「正在跑」不能晚 15 秒才知道),接成一件事幂等。
  ...(opts.workbench ? { sessionContinue: { preview: (k: string) => opts.workbench!.previewNativeContinue(k), adopt: (k: string) => opts.workbench!.adoptNativeSession(k) } } : {}),
  stateDir,
  ownerChatId,
  relayV2Configured: () => relayV2Configured(stateDir),
  remoteAtBoot: remoteCfg.remote_tunnel === true && typeof remoteCfg.relay_v2_url === 'string' && remoteCfg.relay_v2_url.trim() !== '',
  // 手机洞察(批准说明 + 进展概括):explainer / summarizer 各建一个实例(内含缓存),不是每请求一建。
  ...(mattersService ? (() => {
    const cheap = () => wrapCheapEvalWithAuthFailCheck(boot.registry.getCheapEval(), (tag, line) => log(tag, line)) ?? null
    const budgetMs = () => boot.registry.getCheapEvalBudgetMs()
    return { insight: makePhoneInsight({
      // 手机「解读」同详情一条规矩:别人的聊天不拿去给模型总结、也不回给手机
      detail: async (id: string) => {
        const detail = await mattersService.detail(id)
        if (!phoneMayOpenMatter(detail.matter, ownerChatId())) throw new Error('matter_not_found')
        return detail
      },
      explainer: makeApprovalExplainer({ cheapEval: cheap, budgetMs, log: (tag, line) => log(tag, line) }),
      summarizer: makeProgressSummarizer({ cheapEval: cheap, budgetMs, now: () => Date.now(), log: (tag, line) => log(tag, line) }),
    }) }
  })() : {}),
  ...(opts.workbench ? { changes: (id: string) => opts.workbench!.reviewList(id) } : {}),
  ...(opts.workbench ? { review: {
    mark: (id: string, input: { artifactId: string; path: string; mark: 'accepted' | 'returned' }) => opts.workbench!.markReviewFile(id, input),
    ret: (id: string, input: { artifactId: string; paths: string[]; comment: string }) => opts.workbench!.returnReviewFiles(id, input),
    comment: (id: string, input: import('../../features/workbench').ReviewCommentInput) => opts.workbench!.reviewComment(id, input),
    sendComments: (id: string, input: { summary?: string; inputRequestId?: string }) => opts.workbench!.sendReviewComments(id, input),
  } } : {}),
  ...(opts.workbench?{uploads:{
    chunk:(input:Parameters<typeof opts.workbench.uploadAttachmentChunk>[0])=>opts.workbench!.uploadAttachmentChunk(input,{ownerKey:ownerChatId()??'',surface:'phone'}),
    status:(input:{id:string;draftId:string})=>opts.workbench!.attachmentUploadStatus(input,{ownerKey:ownerChatId()??'',surface:'phone'}),
    discard:(input:{id:string;draftId:string})=>opts.workbench!.discardAttachmentUpload(input,{ownerKey:ownerChatId()??'',surface:'phone'}),
  }}:{}),
  ...(opts.workbench?{entry:{
    entryOptions:()=>opts.workbench!.entryOptions({ownerKey:ownerChatId()??'',surface:'phone'}),
    entryModels:(input:{providerId:string;projectId?:string})=>opts.workbench!.entryModels(input,{ownerKey:ownerChatId()??'',surface:'phone'}),
    // 出生地:原生 App(中继 v2 帧)/ 浏览器 /m,只按传输判(phone-client.ts);不在手机请求里 ⇒ null。
    createEntry:(input:import('../../adapters/workbench/task-entry').EntryInput)=>opts.workbench!.createEntry(input,{ownerKey:ownerChatId()??'',surface:'phone',origin:currentPhoneClient()}),
    entryReceipt:(requestId:string)=>opts.workbench!.entryReceipt(requestId,{ownerKey:ownerChatId()??'',surface:'phone'}),
  }}:{}),
  curatedMemory: () => memoryNightly.curatedView(),
  correctMemory: (id: string, verdict: import('../../features/memory').MemoryVerdict) => memoryNightly.correct(id, verdict),
  memoryRetractions: () => memoryNightly.retractions(),
  restoreMemory: (key: string) => memoryNightly.restore(key),
  ...(mattersService && opts.matters ? { matters: { list: (f) => mattersService.list(f), detail: (id) => mattersService.detail(id), inputReceipt:mattersService.inputReceipt, say: (id, text, input) => mattersService.say(id, text, 'phone',input), permission:mattersService.permission,answer:mattersService.answer,stop:mattersService.stop,worktree:mattersService.worktree,rewindPreview:mattersService.rewindPreview,rewind:mattersService.rewind,artifactChunk:mattersService.artifactChunk,handoff:mattersService.handoff,seenOnPhone: (id) => opts.matters!.bind(id, 'phone', 'pwa') } } : {}),
  // 「CC 的信」(2026-10-18):只读存档,寄出去了的才列。
  ...(opts.activity ? { activity: opts.activity } : {}),
  // 信、定时的手机处理器归它们自己的功能(features/letters、features/jobs 的 index.ts 导出),这里只填 deps 交给面板。
  featureRoutes: [
    mobileLettersRoutes({ list: () => listLetters(stateDir), pagePath: (id: string, page: number) => letterPagePath(stateDir, id, page) }),
    // 定时在手机上看得见(对标 B7):与微信「定时」、runner 读写同一个 scheduled-jobs.json。
    mobileJobsRoutes((() => {
      const store = makeJobsStore(stateDir)
      return {
        view: () => jobsView({ store, timezone: loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai', executor: pickJobExecutor(id => boot.registry.has(id as never)) }),
        action: (id: string, action: import('../../features/jobs').JobsActionKind) => jobsAction(store, id, action),
      }
    })()),
  ],
  ...(phoneOwner && phoneChat ? { chat: {
    owner: () => phoneOwner.peek(),
    inboxDir: join(stateDir,'inbox'),
    history: (chatId: string, o: { beforeTs?: string; limit: number }) => messagesStore.listRange(chatId, o),
    chat: phoneChat,
    message: (chatId: string, id: string) => messagesStore.get(chatId, id),
    search: (chatId: string, query: string, limit: number) => messagesStore.search(chatId, query, limit),
    speak: (text: string) => ilink.voice.synthesizeSpeech(text),
    // 按住说话(2026-10-18):与微信语音同一个语音转文字(已过网络守护);没配抛 no_stt_config。
    ...(ilink.voice?.transcribe ? { transcribe: (audio: Buffer, mime: string) => ilink.voice.transcribe!(audio, mime) } : {}),
    ...(ilink.voice?.sttStatus ? { transcribeStatus: () => ({ configured: ilink.voice.sttStatus!().configured }) } : {}),
    // 与微信 `/api <模型>` 同一处:Mode.solo 按对话钉,下一句生效(同后端换模型时协调器自己释放旧会话)。
    model: {
      current: (chatId: string) => {
        const mode = boot.coordinator.getMode(chatId), cfg = loadAgentConfig(stateDir)
        const provider = mode.kind === 'solo' ? mode.provider : cfg.provider
        return {
          mode: mode.kind, provider,
          model: mode.kind === 'solo' ? mode.model ?? null : null,
          globalModel: modelForProvider(cfg, provider) ?? null,
          providers: boot.registry.list().map(id => ({ id, name: boot.registry.namesOf(id).settings })),
        }
      },
      set: (chatId: string, provider: string, model: string | null) => boot.coordinator.setMode(chatId, { kind: 'solo', provider, ...(model ? { model } : {}) }),
    },
  } } : {}),
  ...(remoteTunnel ? { remoteInfo: () => remoteTunnel } : {}),
  ...(phonePush ? { push: phonePush } : {}),
  // 「默认大脑」改完自己重启(与远程开关同一条路)。
  ...(opts.requestRestart ? { requestRestart: (reason: string) => opts.requestRestart!(reason) } : {}),
  ...(opts.requestRestart ? { remote: makeRemoteToggle(stateDir, () => opts.requestRestart!('remote-toggle')) } : {}),
  // 随身 CC 数据面 — facts/graph 来自 boot.knowledge(缺则手机页对应区留白)
  ...(boot.knowledge?.facts ? {
    todos: {
      facts: {
        findFacts: (k, pr, q2, st, li) => boot.knowledge!.facts!.findFacts(k, pr, q2, st, li),
        // 待办「不对」= 收回(架构终态 G5,主人 10-26 第 1 条):记忆、笔记、总览里同一句也一路收回
        setFactStatus: retractOnFactStatus({ setFactStatus: (id: number, st: string, n: number) => boot.knowledge!.facts!.setFactStatus(id, st, n) }, {
          factById: (id) => boot.knowledge!.store.factById(id),
          retract: (text, verdict) => {
            const owner = ownerChatId()
            if (owner) void memoryNightly.retractText(owner, text, verdict, '待办').catch(err => log('MEMORY_NIGHTLY', `todo retract failed: ${err instanceof Error ? err.message : String(err)}`))
          },
        }).setFactStatus,
      },
      names: () => {
        try { return (boot.knowledge?.graph?.topContacts('closeness', 500, 'person') ?? []) as Array<{ username: string; display: string }> } catch { return [] }
      },
    },
  } : {}),
  ...(opts.stickers ? { stickers: { list: () => opts.stickers!.list(), dir: join(stateDir, 'stickers') } } : {}),
  // 随身 CC 首屏「伙伴的一天」三源(spec 2026-09-06-mobile-home-feed §5.4)。
  // journal 缺 ⇒ 整个 feed 不接(三项 degraded),不半接。
  ...(opts.journal ? {
    feed: {
      journal: { list: (n?: number) => opts.journal!.list(n) },
      planLogDays: (d: number) => readPlanLogDays(stateDir, d),
      // M4:不接线时抛(collectSources 的 try/catch 把它记成
      // sources_degraded),而不是悄悄给 [] —— [] 会被读成「接了,今天没
      // 聊天」而不是「这一源读不到」,rule 4 的区分就在这一步丢了。
      turnsRecent: (n: number) => {
        if (!opts.turns) throw new Error('turns 未接线')
        return opts.turns.recent(n)
      },
      timezone: () => loadCompanionConfig(stateDir).timezone,
    },
  } : {}),
  ...(opts.presence ? { presence: opts.presence } : {}),
  seen: { read: () => readJournalSeen(stateDir), write: (iso: string) => writeJournalSeen(stateDir, iso) },
  // 「模型与后端」:注册表 + 体检缓存 + key 有无(只回 boolean)。
  llm: {
    registered: () => boot.registry.list(),
    cached: () => opts.llmHealth?.cached() ?? null,
    hasKey: (p) => hasLlmKey(stateDir, p),
  },
  chatPrefs: {
    get: (c) => ({ ...chatPrefs.get(c) }),
    set: (c, patch) => ({ ...chatPrefs.set(c, patch as Parameters<typeof chatPrefs.set>[1]) }),
  },
  getUserName: (c) => ilink.resolveUserName(c) ?? null,
  setUserName: (c, n) => ilink.setUserName(c, n),
  audit: (reasoning) => {
    const auditChat = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) ?? '_operator'
    makeEventsStore(db, auditChat).append({ kind: 'config_changed', trigger: 'settings_panel', reasoning })
      .catch(() => { /* audit is best-effort — same posture as routes-config */ })
  },
  log: (tag, line) => log(tag, line),
  // 内部 API 同一个 token-registry(梳理第 6 步);没接上(测试)⇒ 面板自建。
  ...(opts.panelTokens ? { tokens: opts.panelTokens } : {}),
})
}

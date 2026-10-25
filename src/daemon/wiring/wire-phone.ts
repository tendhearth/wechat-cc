/**
 * 手机那一簇(重构第二批步 6c,从 pipeline-deps.ts 搬出来):中继 v2 推送、在线设备、终端会话的 App 推送出口、
 * 主人对话 / 手机「跟 CC 说」、App 主动通道、媒体镜像、设置面板、中继隧道、推送 notifier、手机订阅(phone-events)。
 *
 * 簇里有一个真环:phonePush 要读面板的设备,面板又要 phonePush(还有主人对话 / 手机对话)当值。解法是显式的 late 对象 ——
 * 面板建好就填进去,读的地方判空(没建好 ⇒ 当没有设备)。隧道 / notifier / 订阅本来就是异步 import 之后才到的 `let … = null`,
 * 照旧用 `?.` 读。没有「在下面才定义」的闭包。关机:stop() 按 PHONE_STOP_ORDER 停(main.ts 登记在 polling 之前)。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Db } from '../../lib/db'
import { loadAgentConfig } from '../../lib/agent-config'
import type { Bootstrap } from '../bootstrap'
import type { WechatSend } from '../../ports/wechat'
import type { ChatPrefsStore } from '../chat-prefs'
import type { makeMessagesStore } from '../../lib/messages-store'
import type { MattersService } from '../../core/matters/service'
import type { MemoryNightlyRuntime } from '../../features/memory'
import { loadCompanionConfig } from '../../lib/companion-config'
import { makePhoneChatId, makePhoneOwner, makePhoneChat, makePhoneEventsWiring, resolveRemoteRelay, makePhonePush, fanoutPush, makePhoneNotifier, deviceIdOf, currentPhoneClient, loadTunnelClient } from '../../features/phone'
import { makePushGate } from '../speech/push-gate'
import { makeAppChannel } from '../companion/app-channel'
import { makeMediaMirror } from '../companion/media-mirror'
import type { makeMatterActivity } from '../matter-activity'
import { makePhoneLifecycle } from './phone-lifecycle'
import { wireSettingsPanel, type WireSettingsPanelDeps } from './wire-settings-panel'
import type { CompanionConverse } from './wire-converse'

export interface WirePhoneDeps {
  /** 面板读的那几项(含 matters / workbench / stickers,手机这一簇自己也用)。 */
  opts: WireSettingsPanelDeps['opts']
  stateDir: string
  db: Db
  boot: Bootstrap
  /** 媒体镜像接在发送路径上(onMediaSent);其余是设置面板要的。 */
  ilink: Pick<WechatSend, 'onMediaSent'> & WireSettingsPanelDeps['ilink']
  log: (tag: string, line: string) => void
  chatPrefs: ChatPrefsStore
  messagesStore: ReturnType<typeof makeMessagesStore>
  ownerChatId(): string | null
  matterActivity: ReturnType<typeof makeMatterActivity> | null
  companionConverse: CompanionConverse
  mattersService: MattersService | null
  memoryNightly: MemoryNightlyRuntime
  connections: WireSettingsPanelDeps['connections']
  /** CC 开口那道门:工作台 / 终端会话的原生推送先问它(speech/push-gate.ts)。 */
  speech: Pick<import('../speech/policy').SpeechPolicy, 'ask'>
}

export function wirePhone(d: WirePhoneDeps) {
  const { opts, stateDir, db, boot, ilink, log, chatPrefs, messagesStore, ownerChatId, matterActivity, companionConverse, mattersService, memoryNightly, connections, speech } = d
  // 簇里晚到的那一样(面板要 phonePush 当值,phonePush 又要读面板):建好就填,读的地方判空。
  const late: { panel: ReturnType<typeof wireSettingsPanel> | null } = { panel: null }
// 微信可点开的图形设置面板 (2026-08-25) — lazily-started LAN server, every
// endpoint gated on a one-active 10-min token. /set (no args) from an
// admin appends the link. See settings-panel.ts's security posture.
// Remote tunnel opt-in (随身 CC out-of-home) — resolve id/relay BEFORE the
// panel so its /m page can bake them in for out-of-home phones.
const remoteCfg = loadAgentConfig(stateDir) as { remote_tunnel?: boolean; remote_relay_url?: string; relay_v2_url?: string }
// 官方中继 v2(老 VPS 中继随协议 v1 在 2026-10-25 退休,架构终态 F4)。没设 relay_v2_url ⇒ 远程关。
const relay = resolveRemoteRelay(stateDir, remoteCfg, (tag, line) => log(tag, line))
const remoteTunnel = relay?.remoteInfo ?? null
// 推送(中继 v2):先建,面板与隧道都要它;发送走 v2 隧道客户端(稍后才建 —— 懒绑定)。
// 手机那一簇关机时要停的东西(重构第二批步 6d):main.ts 在 polling 之前登记 ⇒ 倒序时入站先停,App 在途回复还能经隧道送完。
const phoneLc = makePhoneLifecycle((tag, line) => log(tag, line))
let v2Tunnel: import('../../features/phone').TunnelClient | null = null
let notifier: { refresh(): void } | null = null
// 面板在下面才建(它要 phonePush 当值):经 late.panel 读,没建好 ⇒ 当没有设备(见 PR #492 的 null 行为表)。
const phonePush = relay ? makePhonePush({
  stateDir,
  send: (m) => v2Tunnel?.sendControl(m) ?? false,
  deviceToken: (id) => late.panel?.deviceTokens().find(t => deviceIdOf(t) === id) ?? null,
  deviceIds: () => late.panel?.deviceTokens().map(deviceIdOf) ?? [],
  onChange: () => notifier?.refresh(),
  log: (tag, line) => log(tag, line),
}) : null

// 在线设备 = 中继隧道上挂着订阅的设备(按设备 id 去重)。隧道没建 ⇒ 空。
const onlineDevices = () => new Set([...(v2Tunnel?.subscribedDeviceTokens() ?? [])].map(deviceIdOf))
// 推送本身(在线的跳过、失败只记日志)。这个文件里只有这一处调 fanoutPush;用它的三处:
//  - App 主动通道(companionApp.push):只在 proactive-channel 那一轮收尾时推,那一轮已经过了门(say);
//  - 工作台通知(phone-notifier)、终端会话(features/terminal/app-push 的 appPush):由状态变化直接触发 ⇒ 先过 pushGate 问门。
const fanout = (p: import('../../features/phone').PushPayload) =>
  phonePush ? fanoutPush({ push: phonePush, subscribedDevices: onlineDevices, log: (tag, line) => log(tag, line) }, p) : null
const pushGate = makePushGate({ speech, ownerChatId, push: fanout, log: (tag, line) => log(tag, line) })
phoneLc.add('push-gate', () => pushGate.stop())
// 终端会话的手机推送出口(features/terminal/app-push.ts):问过门再推(批准 = blocking 照推;完成了 = report,免打扰里先压着)。
const appPush: import('../../features/terminal').AppPushOutlet = (p) => (phonePush ? pushGate.push(p) : null)

// 手机「跟 CC 说」(spec 2026-10-01):主人对话一页(只读)+ 收下即回的说一句。
// 对话 chat 必须就是 companionConverse 写进去的那条(它认 companion 的 default_chat_id):
// 两者不一致(default_chat_id 不是 admin)⇒ 当作没有主人对话,免得手机看 A 却说进 B。
const phoneChatId = makePhoneChatId({ ownerChatId, converseChatId: () => loadCompanionConfig(stateDir).default_chat_id ?? null, log: (tag, line) => log(tag, line) })
const phoneOwner = opts.matters ? makePhoneOwner({ ownerChatId: phoneChatId, matters: opts.matters, origin: currentPhoneClient }) : null
let phoneEvents: import('../../features/phone').PhoneEvents | null = null
// converse 必须是回合串行入口 companionConverse(与微信 / 桌面「跟 CC 说」同一条:
// isInFlight 前置拒 + coordinator.submitTurn 持每 chat 锁),手机一句不会和微信一轮在主人会话上并跑。
const phoneChat = phoneOwner ? makePhoneChat({
  converse: (text, images) => companionConverse(text, 'phone', images),
  // 手机带的图:材料暂存里按主人取(与交办同一套校验),读完即删,图落到对话 inbox(2026-10-06)。
  ...(opts.workbench ? { takeImages: (m: { draftId: string; attachmentIds: string[] }) => opts.workbench!.takeChatImages(m, { ownerKey: ownerChatId() ?? '', surface: 'phone' }) } : {}),
  ownerMatterId: () => phoneOwner.ensure(),
  onSettled: id => { matterActivity?.note(id); phoneEvents?.poke() },
  log: (tag, line) => log(tag, line),
}) : null
// CC 主动找你的第二条路(2026-10-18):微信不通时伙伴推送 / 提醒落到 App —— 记进手机对话读的同一条主人
// chat、捅主题、推一条 companion。「送得到」只认还配对着的推送登记,或正连着的设备。
const companionApp = phonePush && phoneOwner ? makeAppChannel({
  // App 对话页认的那条(主人 chat matter 已经在):还没有 ⇒ 点开通知也没有对话可看,当送不到。
  ownerChatId: () => phoneOwner.peek()?.chatId ?? null,
  pushDevices: () => { const paired = new Set(late.panel?.deviceTokens().map(deviceIdOf) ?? []); return phonePush.registered().filter(id => paired.has(id)) },
  onlineDevices,
  relayOnline: () => v2Tunnel?.connected() ?? false,
  append: (rec) => messagesStore.append(rec),
  touched: () => { const m = phoneOwner.peek(); if (m) matterActivity?.note(m.matterId); phoneEvents?.poke() },
  push: (p) => fanout(p),
  ...(opts.stickers ? { stickerFile: (tag: string) => opts.stickers!.resolve(tag) } : {}),
  log: (tag, line) => log(tag, line),
}) : null
// 媒体镜像(手机伙伴第 2 步,2026-10-18):CC 在微信上发给主人的图 / 表情 / 语音 / 文件,App 对话页也看得见 ——
// 主人那条记一行 CC,附件放 extras(只存引用)。只认 App 镜像的那条主人对话;别的 chat 不记。
if (phoneOwner) {
  const mirror = makeMediaMirror({
    ownerChatId: () => phoneOwner.peek()?.chatId ?? null,
    stickerDir: opts.stickers ? join(stateDir, 'stickers') : null,
    stickerLabel: (file) => opts.stickers?.list().find(e => e.file === file)?.tags[0] ?? null,
    scratchRoots: [tmpdir(), join(stateDir, 'tts-tmp')],
    append: (rec) => messagesStore.append(rec),
    touched: () => { const m = phoneOwner.peek(); if (m) matterActivity?.note(m.matterId); phoneEvents?.poke() },
    log: (tag, line) => log(tag, line),
  })
  ilink.onMediaSent?.((chatId, m) => mirror.noteSent(chatId, m))
  // 单槽 setter:关机时放回空函数,以后谁再挂也不会被这一个悄悄顶掉(#482 / 草图评审)
  phoneLc.add('media-mirror', () => { ilink.onMediaSent?.(() => {}) })
}
// 设置面板:要 phonePush / 主人对话 / 手机对话当值;建好立刻填进 late,前面那几个闭包从此读得到。
const settingsPanel = wireSettingsPanel({
  opts, connections, stateDir, db, boot, ilink, log, chatPrefs, messagesStore, ownerChatId, mattersService, memoryNightly,
  phone: { remoteCfg, remoteTunnel, push: phonePush, owner: phoneOwner, chat: phoneChat },
})
late.panel = settingsPanel

// 远程中继隧道 daemon leg — dials the relay out (NAT-piercing); phone
// reaches it via the SAME settingsPanel.handleRequest. OFF unless
// remote_tunnel:true + relay_v2_url (resolved into `relay` above).
if (relay) {
  // 手机协议 v2 的订阅(第 11 步):四路来源(home / matter/<id> / approvals / agents)+ 集线器;
  // 工作台一变就 poke(回调里只许 poke,见 makePhoneEventsWiring)。推送判定在 phone-notifier.ts。关机时由 phoneLc 退订。
  const phone = makePhoneEventsWiring({
    ...(opts.workbench ? { workbench: opts.workbench, changes: opts.workbench.changes } : {}),
    ...(opts.matters ? { matters: opts.matters } : {}),
    home: (limit, o) => settingsPanel.home(limit, o),
    ...(phoneChat ? { chat: {
      latestAt: async (chatId: string) => { const ts = await messagesStore.latestTs(chatId); return ts ? Date.parse(ts) : null },
      pendingMatter: () => phoneChat.pendingMatter(),
    } } : {}),
    log: (tag, line) => log(tag, line),
  })
  phoneEvents = phone.events
  loadTunnelClient().then(({ makeTunnelClient }) => {
    // 关机先到、隧道后建:不再连上去
    if (phoneLc.stopped()) { phone.dispose(); return }
    const common = {
      events: phone.events,
      handleRequest: (req: Request) => settingsPanel.handleRequest(req),
      // 设备令牌从面板取(梳理第 6 步:不再裸读 settings-devices.json,文件只有 device-store 一个读者)。
      knownDeviceTokens: () => settingsPanel.deviceTokens(),
      activeLinkToken: () => settingsPanel.activeLinkToken(),
      log: (tag: string, line: string) => log(tag, line),
    }
    v2Tunnel = makeTunnelClient({
      ...common,
      daemonId: relay.identity.id,
      relayUrl: relay.daemonUrl,
      login: relay.identity,
      onLogin: () => phonePush?.resync(),
      onControl: (m) => phonePush?.onControl(m),
    })
    v2Tunnel.start()
    phoneLc.add('v2-tunnel', () => v2Tunnel?.stop())
    if (phonePush && opts.workbench) {
      const wb = opts.workbench
      const n = makePhoneNotifier({
        events: phone.events,
        push: phonePush,
        deliver: (p) => { pushGate.push(p) },
        taskInfo: (id) => { try { const d = wb.detail(id); return { title: d.task.title, status: d.task.status } } catch { return null } },
        log: (tag, line) => log(tag, line),
      })
      notifier = n
      n.refresh()
      phoneLc.add('notifier', () => n.dispose())
    }
    phoneLc.add('phone-events', () => phone.dispose())
    log('TUNNEL', `remote tunnel enabled — relay v2 ${relay.identity.id.slice(0, 8)}…`)
  }).catch(err => log('TUNNEL', `tunnel client load failed: ${err instanceof Error ? err.message : err}`))
}

// 设置面板的 HTTP(第一次要链接时才起)放最后停:前面的隧道还在转它的请求
phoneLc.add('settings-panel', () => settingsPanel.stop())

  return {
    appPush, companionApp, phoneChat, settingsPanel,
    /** 关机:按固定顺序停隧道 / notifier / 订阅 / 面板,放掉媒体镜像那个单槽回调。 */
    stop: () => phoneLc.stop(),
  }
}

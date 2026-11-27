// @ts-check
/// <reference lib="dom" />
import { setDockedMatter } from './modules/conversation-matters.js'
import { createDeskHistory, deskHistoryShortcut } from './modules/desk-history.js'
import { watchDeskFullscreen } from './modules/desk-fullscreen.js'
import { createRosterDock } from './modules/roster-dock.js'
import { mountRosterPane } from './modules/roster-pane.js'
import { isDeskCollapseShortcut, readDeskCollapsed, writeDeskCollapsed } from './modules/desk-collapse.js'
import { DESK_EXPANDED_RAIL_QUERY, DESK_OVERLAY_RAIL_QUERY } from './modules/desk-layout.js'
import { mountPlacesStrip } from './modules/places-strip.js'
import { mountThingThread } from './modules/thing-thread.js'
import { rememberConversationPosition } from './modules/converse-reading.js'
import { openCliChoices, startCliSetup, recheckCliSetup } from './modules/cli-setup.js'
import { openConversationWork, openConversationTerminal } from './modules/conversation-work-detail.js'
import { createMainNavigation, createNativeNavigation } from './main-navigation.js'
/** @typedef {import('../../../src/cli/schema').GuardStatusOutputT} GuardStatus */
/** @typedef {import('../../../src/cli/schema').ProviderShowOutputT} ProviderConfig */
/** @typedef {import('../../../src/cli/schema').GuardEnableOutputT} GuardEnable */
/** @typedef {import('../../../src/cli/schema').GuardDisableOutputT} GuardDisable */
/** @typedef {import('../../../src/cli/schema').AvatarInfoOutputT} AvatarInfo */
/** @typedef {import('../../../src/cli/schema').AvatarSetOutputT} AvatarSet */
/** @typedef {import('../../../src/cli/schema').AvatarRemoveOutputT} AvatarRemove */
/** @typedef {import('../../../src/cli/schema').SetupQrJsonOutputT} SetupQrJson */

// main.js — boot, mode router, and event-listener wiring. Per-feature logic
// lives in modules/ (wizard, qr, service, dashboard, memory, update). The
// doctor lifecycle is owned by doctor-poller.js; main.js just wires its
// subscribers + invokes refresh from action handlers.

import { invoke as ipcInvoke, formatInvokeError } from "./ipc.js"
import { invokeApi, invokeWorkbenchApi } from "./api.js"
import { mountNotebookMail } from "./modules/notebook-mail.js"
import { mountNotebook } from "./modules/notebook.js"
import { V1, v1 } from "./daemon-client.js"
import { initialMode, restartButtonState, afterScanTarget , showToast, guardLine, guardRowVisible, hasUsableProvider, providerReady } from "./view.js"
import { createDoctorPoller } from "./doctor-poller.js"
import { createPresencePoller } from "./presence-poller.js"
import { createConversationsPoller } from "./conversations-poller.js"
import {
  renderDoctorWizard,
  refreshEnterDashboardButton,
  showStep as wizardShowStep,
} from "./modules/wizard.js"
import { refreshQr, stopQr } from "./modules/qr.js"
import { mountPhoneConnect, mountOnboardPhone } from "./modules/phone-connect.js"
import { mountOnboardTerminal } from "./modules/terminal-hooks.js"
import { toggleDecisionDisclosure } from "./modules/decisions.js"
import { serviceAction, forceKillDaemon } from "./modules/service.js"
import { renderDashboard, renderRestartButton, setPending, setLastProbe, restartDaemon, stopDaemon, handleAccountRowClick, toggleProviderMenu, toggleUserProviderMenu, closeProviderMenu, checkIncidentsOnPoll, checkFsAccessOnPoll, checkGuardOnPoll, checkBrainHealthOnPoll, loadBrainHealth, runTroubleshoot, runBrainDial, closeTroubleshoot, renderNoBrain, openBrainSetup, saveBrainKey } from "./modules/dashboard.js"
import { executorName, haveExecutorNames, loadExecutorNames } from "./modules/executor-names.js"
import { renderConversations } from "./modules/conversations.js"
import { loadMemoryPane, wireMemoryButtons, loadMemoryTopZone, loadMemoryDecisions, archiveObservation, synthesizeMemory, generateMemoryProfile, loadProjectMemory, loadMemoryRetractions, restoreMemoryRetraction, isMemoryEmbryoEnabled, setMemoryEmbryoEnabled, renderMemoryProfileOverview, jumpToMemorySource } from "./modules/memory.js"
import { rerenderLogs, loadLogsPane, startLogsAutoRefresh, stopLogsAutoRefresh } from "./modules/logs.js"
import { initDialoguePage, stopDialogueAutoRefresh } from "./modules/dialogue-page.js"
import { initTodosPage, deactivateTodosPage } from "./modules/todos.js"
import { startAppUpdateChecks } from "./modules/app-update.js"
import { reflectConversationAvailability, initConversePage, addConversationMatter, addConversationTerminal, openConversationDelegation, locateConversationMessage, subscribeConverse, subscribeConverseActivity, addImages as addConverseImages, connectConversationPlaces, updateConversationPlaces } from "./modules/converse.js"
import { openComputerSessions, updateTerminalReferences } from './modules/conversation-sessions.js'
import { wireDeskDisclosure } from './modules/desk-disclosure.js'
import { hideDeskWakeFailures, wireDeskWake } from './modules/desk-wake.js'
import { mountConversationTools } from './modules/conversation-tools.js'
import { mountHistoryDialog } from './modules/workbench-history.js'
import { mountMemoryTopics } from './modules/conversation-topics.js'
import { updateConversationMatters, updateConversationAttention } from './modules/conversation-matters.js'
import { mountNowHero } from "./modules/now-hero.js"
import { mountNowConnections } from "./modules/now-connections.js"
import { nowStatusLine } from "./modules/now-home.js"
import { initA2AAgentsTab, refresh as refreshA2AAgents, deactivateA2AAgentsTab } from "./modules/a2a-agents.js"
import { markJournalSeen, activateHuntBag, deactivateHuntBag } from "./modules/journal.js"
import { deactivatePeople } from "./modules/people.js"
import { activateWishes, deactivateWishes } from "./modules/wishes.js"
import { initPluginsTab, refresh as refreshPlugins } from "./modules/plugins.js"
import { initLicense, refreshLicense } from "./modules/license.js"
import { loadUpdateProbe, applyUpdate } from "./modules/update.js"
import { wireSettingsDrawer, openSettingsDrawer } from "./modules/settings-drawer.js"
import { wireCalendarSetting } from "./modules/calendar-setting.js"
import { mountHugeicons } from "./modules/icons.js"
import { pingHealth, fetchDaemonVersion } from "./health-probe.js"
import { refreshWxvaultOnAppStart } from "./modules/wxvault-refresh.js"
import { loadAtelierGallery, deactivateAtelierGallery } from "./modules/atelier-gallery.js"
import {closeRecordReader} from './modules/record-reader.js'
import { createLifeArchive } from "./modules/cc-life.js"
import { createTaskListReader } from "./modules/task-list-reader.js"
import { createTaskEntry } from "./modules/task-entry.js"
import { refreshPostcardAlbum } from "./modules/postcard-album.js"
import { createDeskSearch } from './modules/desk-search.js'
import { initWorkbenchPage, stopWorkbenchPolling, openWorkbenchTask, getViewedWorkbenchTaskId, setWorkbenchDocked } from "./modules/workbench.js"
import { isCurrentWorkbenchPane } from "./modules/workbench-navigation.js"
import { createWorkbenchAttentionPoller } from "./modules/workbench-attention.js"
import { createTerminalWaitingPoller } from "./modules/terminal-waiting.js"
import { installExternalLinks } from "./modules/external-links.js"

const state = {
  setup: /** @type {SetupQrJson | null} */ (null),
  currentBaseUrl: /** @type {string | null} */ (null),
  selectedProvider: "claude",
  unattended: true,
  // Match the v0.6 backend default (true) so a loadAgentConfig failure
  // leaves the UI consistent with the on-disk reality. The actual value
  // is overwritten by loadAgentConfig() at boot when that call succeeds.
  autoStart: true,
  closeStopsDaemon: false,
  qrTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
  qrConfirmTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
  qrErrors: 0,
  mode: "loading",
  currentStep: "doctor",
  updateProbed: false,
  connectionIntent: /** @type {"disconnected" | null} */ (null),
}
/** @type {ReturnType<typeof mountMemoryTopics>|null} */
let memoryTopics=null
/** @type {ReturnType<typeof createRosterDock>|null} */
let rosterDock=null
/** @type {ReturnType<typeof mountThingThread>|undefined} */ let thingThread
/** @type {ReturnType<typeof mountPlacesStrip>|undefined} */ let deskPlaces

/** @param {DeskDetail} target */
function findThing(target) {
  const places = deskPlaces?.places() ?? []
  for (const place of places) {
    const item = thingThread?.find(place,target)
    if (item) return {place,item}
  }
  for (const place of places) {
    const item = thingThread?.linkedItem(place,target)
    if (item) return {place,item,direct:true}
  }
}

/** @typedef {import('./modules/desk-history.js').TerminalPlace} TerminalPlace */
/** @typedef {{id:string, place:TerminalPlace}} SearchTerminal */
/** @type {SearchTerminal|undefined} */ let searchTerminal

/** @param {DeskDetail} target @param {TerminalPlace} hint */
function searchTerminalDestination(target, hint) {
  const destination = findThing(target)
  if (destination) return destination
  const existing = deskPlaces?.places().find(place => place.key === hint.key)
  const place = {
    ...(existing ?? { ...hint, line: null, status: null, waiting: null, moving: false, unseen: false, matterIds: [], messageIds: [] }),
    sessionIds: [...new Set([...(existing?.sessionIds ?? []), target.id])],
  }
  const item = thingThread?.linkedItem(place, target)
  if (item) return { place, item, direct: true }
}

/** @param {NonNullable<ReturnType<typeof findThing>>} destination @param {SearchTerminal} [terminal] */
function openThing({place,item,direct}, terminal) {
  rosterDock?.close()
  if (document.body.dataset.pane !== 'thing') switchPane('thing')
  searchTerminal = terminal
  thingThread?.forgetView(place.key)
  thingThread?.open(place,item.key,direct ? item : undefined)
  deskPlaces?.selectKey(place.key)
}

/** @typedef {import('./modules/desk-history.js').DeskDetail} DeskDetail */
/** @type {(() => void) | undefined} */ let recordDeskNavigation
/** @type {(() => void) | undefined} */ let openDeskSearch
/** @type {DeskDetail|null} */ let expandedDetail = null
/** @type {(() => void) | undefined} */ let disposeExpandedDetail
let preserveNavigationFocus = false
/** @type {(() => void)|undefined} */ let restoreDeskConversation

/** @param {DeskDetail} item */
async function openDeskDetail(item) {
  const destination = findThing(item)
  if (destination) {
    openThing(destination)
    document.getElementById('thing-name')?.focus({preventScroll:true})
    recordDeskNavigation?.()
    return
  }
  if (document.body.dataset.pane === 'thing') switchPane('overview')
  if (await rosterDock?.open(item)) recordDeskNavigation?.()
}

/** @param {string} id */
async function openDeskTask(id) {
  switchPane('workbench')
  await openWorkbenchTask(id)
  if (document.body.dataset.pane === 'workbench' && getViewedWorkbenchTaskId() === id) recordDeskNavigation?.()
}

/** @param {string} pane @param {string} [notebookDay] */
function navigateDeskPane(pane, notebookDay) {
  switchPane(pane, notebookDay)
  recordDeskNavigation?.()
}
const mainNavigation = createMainNavigation(destination => {
  if (typeof destination === 'string') { navigateDeskPane(destination); return }
  const item = {kind: /** @type {const} */ ('matter'), id:destination.taskId}
  void v1(invokeWorkbenchApi, V1.matter.seen, { body: { id: destination.taskId, surface: 'desktop' } }).catch(err => console.warn('mark seen failed', err))
  const thread = findThing(item)
  if (thread) { openThing(thread); recordDeskNavigation?.(); return }
  switchPane('workbench')
  void openWorkbenchTask(destination.taskId).then(() => {
    if (document.body.dataset.pane === 'workbench' && getViewedWorkbenchTaskId() === destination.taskId) recordDeskNavigation?.()
  }).catch(err => console.warn('open task failed', err))
})

const dashRail = /** @type {HTMLElement|null} */ (document.getElementById('dash-global-rail'))
// window.__TAURI__ is injected by the Tauri runtime and not part of the
// standard Window type. Cast to any to access optional Tauri fields.
const mock = !(/** @type {any} */ (window).__TAURI__?.core?.invoke)

// macOS uses titleBarStyle: "Overlay" — window content extends under the
// traffic-light area. CSS reads data-platform to add top padding on the rail
// so the brand block doesn't sit behind the close/min/max buttons.
if (/Mac/i.test(navigator.platform || navigator.userAgent || "")) {
  document.documentElement.dataset.platform = "macos"
}

// Brief click feedback shared across all "刷新" buttons (overview/memory/logs):
// disable + replace label text with "已刷新" → revert after 1.2s. Stops users
// from double-clicking and confirms the click without leaving stale text
// behind (the prior overview-only `setPending("已刷新")` never cleared).
/**
 * @param {HTMLButtonElement | null | undefined} button
 * @param {() => Promise<unknown> | unknown} fn
 */
async function withRefreshFeedback(button, fn) {
  if (!button) return await fn()
  const labelNode = Array.from(button.childNodes).find(
    n => n.nodeType === Node.TEXT_NODE && n.textContent !== null && n.textContent.trim().length > 0,
  )
  const original = labelNode ? labelNode.textContent : null
  button.disabled = true
  try {
    await fn()
  } finally {
    if (labelNode) labelNode.textContent = " 已刷新"
    setTimeout(() => {
      if (labelNode && original !== null) labelNode.textContent = original
      button.disabled = false
    }, 1200)
  }
}

// `state` carried through ipcInvoke for the mock path so dev-mode mocks can
// react to selectedProvider/unattended/autoStart toggles in real time.
/**
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
const invoke = (cmd, args) => ipcInvoke(cmd, args, state)

const doctorPoller = createDoctorPoller({ invoke, intervalMs: 5000 })
const presencePoller = createPresencePoller({ invokeApi, intervalMs: 20_000 })
presencePoller.start()
const ccButton = /** @type {HTMLElement} */ (document.getElementById('topbar-cc'))
const deskHero = mountNowHero({ root: ccButton, button: ccButton })
presencePoller.subscribe(deskHero.setPresence)
const reflectHeroConversation = (/** @type {import('./modules/converse.js').ConverseMsg[]} */ msgs) =>
  deskHero.setConverse(msgs.filter(m => !m.matterId && !m.terminalId))
subscribeConverse(reflectHeroConversation)
function focusConversationInput() {
  // Align the hero with the latest local conversation before returning focus.
  subscribeConverse(msgs => reflectHeroConversation(msgs))()
  if (!preserveNavigationFocus) document.getElementById('converse-input')?.focus()
}
ccButton.addEventListener('click', focusConversationInput)
subscribeConverseActivity(deskHero.setActivity)

/** @type {{alive:boolean}|null} */ let lastDaemon = null
/** @type {{presence:string}|null} */ let lastPresence = null
function reflectTopbarWaiting() {
  const cc = document.getElementById('topbar-cc')
  if (!cc) return
  const toggle = document.getElementById('desk-rail-toggle')
  toggle?.toggleAttribute('data-waiting', !!cc.dataset.waiting)
  const count = cc.dataset.waiting
  cc.setAttribute('aria-label', count ? `跟 CC 说(有 ${count} 件在等你)` : '跟 CC 说')
  if (document.body.dataset.pane === 'overview' && !deskPlaces?.selected()) cc.setAttribute('aria-current','page')
  else cc.removeAttribute('aria-current')
}

const notebookMail = mountNotebookMail(invokeApi, day => navigateDeskPane('notebook', day))
function syncNotebookMail() {
  notebookMail.sync(document.documentElement.dataset.mode === 'dashboard'
    && lastDaemon?.alive === true && !!lastPresence && lastPresence.presence !== 'down')
}

function reflectDeskConnection() {
  syncNotebookMail()
  const root = document.documentElement
  const stopped = !!lastPresence && lastDaemon?.alive === false
  if (stopped === root.hasAttribute('data-desk-cc-stopped')) return
  root.toggleAttribute('data-desk-cc-stopped', stopped)
  if (!stopped) hideDeskWakeFailures()
  reflectConversationAvailability()
  document.dispatchEvent(new Event('desk-cc-availability'))
}

function renderRail() {
  const line = nowStatusLine(lastDaemon, lastPresence)
  reflectDeskConnection()
  const deskLabel = document.getElementById('desk-cc-presence')
  const situation = document.getElementById('desk-cc-situation')
  const stale = situation?.hasAttribute('data-stale')
  if (deskLabel) deskLabel.textContent = line.cls === 'ok' ? (stale ? '家里的电脑暂时连不上' : 'CC 在家') : line.text
  if (situation) situation.hidden = line.cls !== 'ok' || !situation.textContent || stale === true
  const cc = document.getElementById('topbar-cc'); if (cc) cc.dataset.cc = lastPresence?.presence === 'down' || !lastPresence ? 'away' : 'here'
}
presencePoller.subscribe(p => { lastPresence = p; renderRail() })
// 右上角状态行打开的「CC 的连接」(GET /v1/connections,admin,走原生宿主的 operator 凭据)。
// 只在浮层打开时读:打开时立刻读一次,开着时每 30 秒再读。
const nowConnectionsHost = document.getElementById('now-connections')
const nowConnections = nowConnectionsHost ? mountNowConnections({ host: nowConnectionsHost, call: (method, path, body) => invokeWorkbenchApi(method, path, body), openUrl: url => { if (!mock) void Promise.resolve(invoke('open_url', { url })).catch(err => showToast(`打不开：${formatInvokeError(err)}`)) }, openPlace: openCapabilityPlace }) : null
{
  const details = /** @type {HTMLDetailsElement|null} */ (document.querySelector('.cc-home-details'))
  /** @type {ReturnType<typeof setInterval>|null} */ let timer = null
  details?.addEventListener('toggle', () => {
    if (timer) { clearInterval(timer); timer = null }
    if (!details.open || !nowConnections) return
    void nowConnections.open()
    timer = setInterval(() => { void nowConnections.refresh() }, 30_000)
  })
}
window.addEventListener('pagehide',()=>{closeRecordReader({restoreFocus:false});deactivateAtelierGallery();deactivateTodosPage();deactivateHuntBag();deactivatePeople();deactivateWishes();deactivateA2AAgentsTab()})
const memoryRecordsHost = document.getElementById("cc-memory-records")
const lifeArchive = memoryRecordsHost ? createLifeArchive(memoryRecordsHost, { call: invokeApi }) : null
let lifeCategory = "postcards"
/** @param {string} category */
async function loadLifeCategory(category) {
  lifeCategory = category
  lifeArchive?.cancel()
  document.querySelectorAll("[data-life-category]").forEach(el => el.setAttribute("aria-pressed", String(el.getAttribute("data-life-category") === category)))
  const postcards = document.getElementById("cc-memory-postcards")
  if (postcards) postcards.hidden = category !== "postcards"
  if (memoryRecordsHost) memoryRecordsHost.hidden = category === "postcards"
  if (category === "postcards") await refreshPostcardAlbum()
  else await lifeArchive?.load(category)
}

const conversationsPoller = createConversationsPoller({ call: (method, path) => invokeWorkbenchApi(method, path), intervalMs: 10000 })

/** @type {ReturnType<typeof createWorkbenchAttentionPoller>|null} */
let workbenchAttention = null
/** @type {any[]} */ let homeTasksSnapshot = []
/** @type {any[]} */ let terminalSessions = []
/** @type {import('./modules/terminal-waiting.js').TerminalRow[]} */ let terminalWaitingRows = []
const homeTasks = createTaskListReader({
  call: invokeWorkbenchApi,
  onChange: next => {
    // 读不到(stale)⇒ 留着上一份(列表里本来就只有在做 / 做完的,不冒充等你);一份都没有 ⇒ 只剩终端的。
    if (next.data) homeTasksSnapshot = next.data.tasks ?? []
    updateConversationMatters(homeTasksSnapshot, next.stale)
  },
})
window.addEventListener('pagehide', () => homeTasks.stop())
// 终端里等批准的 Claude Code / Codex(GET /v1/cli/sessions,admin,走原生宿主):接在「N 件事等你」后面,不另开一页。
const terminalWaiting = createTerminalWaitingPoller({
  call: (method, path) => invokeWorkbenchApi(method, path),
  onChange: rows => {
    deskHero.setTerminal(rows)
    if (!mock) {
      terminalWaitingRows = rows
      deskPlaces?.setTerminalWaitingRows(rows)
    }
  },
  onSessions: sessions => { terminalSessions = sessions; updateTerminalReferences(sessions) },
})
terminalWaiting.start()
window.addEventListener('pagehide', () => terminalWaiting.stop())
window.addEventListener('pageshow', event => { if (event.persisted) terminalWaiting.start() })
function startWorkbenchAttention() {
  if (workbenchAttention) return
  workbenchAttention = createWorkbenchAttentionPoller({
    invokeWorkbenchApi, invoke,
    onChange: snapshot => {
      updateConversationAttention(snapshot)
      deskHero.setAttention(snapshot)
    },
    getContext: () => ({
      taskId: state.mode === 'dashboard' && document.body.dataset.pane === 'workbench' ? getViewedWorkbenchTaskId() : null,
      focused: document.visibilityState === 'visible' && document.hasFocus(),
    }),
  })
  void workbenchAttention.start()
}
window.addEventListener('focus', () => { void workbenchAttention?.refresh() })
window.addEventListener('pagehide', () => { workbenchAttention?.destroy(); workbenchAttention = null })
window.addEventListener('pageshow', event => { if (event.persisted) startWorkbenchAttention() })

installExternalLinks({ invoke: mock ? null : invoke, onError: err => showToast(`打不开链接:${formatInvokeError(err)}`) })

// 文件拖放(2026-10-05):窗口不再由 Tauri 截走拖进来的文件(dragDropEnabled:false),网页自己接。
// 落在「此刻」任何地方的图 ⇒ 进对话的待发图片;各页面自己接住的(工作台附件、对话框)它们先处理;
// 剩下没人要的一律拦掉 —— 不然 webview 会直接「打开」那个文件,把整个 app 换成一张图。
window.addEventListener('dragover', ev => { if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault() })
window.addEventListener('drop', ev => {
  if (ev.defaultPrevented) return
  ev.preventDefault()
  const pane = /** @type {HTMLElement|null} */ (document.querySelector('.dash-pane[data-pane]:not([hidden])'))
  if (pane?.dataset.pane === 'overview' && ev.dataTransfer?.files?.length) void addConverseImages(ev.dataTransfer.files)
})

// Bag passed to module functions instead of imported singletons. Keeps each
// module testable in isolation (any conformant deps object → run the module
// in a JSDOM/happy-dom harness).

const openAcceptedEntry = async (/** @type {import('./modules/task-entry.js').EntryResult} */ result) => {
  switchPane('converse')
  addConversationMatter(result.receipt.taskId, result.task.title, false)
  updateConversationMatters([result.task])
}
function openConversationProjects(){
  switchPane('workbench')
  document.querySelector('[data-action="add-project"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))
  const layer=/** @type {HTMLElement|null} */(document.querySelector('.workbench-pane'));if(layer)layer.dataset.workbenchView='projects'
}
const taskEntry = createTaskEntry({invokeWorkbenchApi, onAccepted: openAcceptedEntry,onManageProjects:openConversationProjects})

const deskSearch = createDeskSearch({
  call: invokeWorkbenchApi,
  openProject: place => {
    recordDeskNavigation?.()
    rosterDock?.close()
    switchPane('thing')
    deskPlaces?.selectKey(place.key)
    thingThread?.open(place)
    document.getElementById('thing-name')?.focus({ preventScroll: true })
    recordDeskNavigation?.()
  },
  openTerminal: hit => {
    const target = { kind: /** @type {const} */ ('terminal'), id: hit.sessionId }
    const hint = { key: hit.placeKey ?? `terminal:${hit.sessionId}`, name: hit.project, updatedAt: hit.at }
    const destination = searchTerminalDestination(target, hint)
    if (!destination) return
    recordDeskNavigation?.()
    const { key, name, updatedAt } = destination.place
    openThing(destination, { id: target.id, place: { key, name, updatedAt } })
    document.getElementById('thing-name')?.focus({ preventScroll: true })
    recordDeskNavigation?.()
  },
  openMessage: async (id, current) => {
    try {
      return await locateConversationMessage(id, () => {
        if (!current()) return false
        recordDeskNavigation?.()
        navigateDeskPane('overview')
        return true
      })
    } catch {
      if (current()) showToast('暂时打不开这句对话')
    }
  },
})

const deps = {
  invoke,
  invokeApi,
  invokeWorkbenchApi,
  preserveNavigationFocus: () => preserveNavigationFocus,
  onTaskNavigation: () => recordDeskNavigation?.(),
  deskSearch,
  onOpenSearchTask: (/** @type {string} */ id) => {
    recordDeskNavigation?.()
    return openDeskTask(id)
  },
  onMatterViewed: (/** @type {import('./modules/workbench.js').Task} */ task) => { addConversationMatter(task.id,task.title); updateConversationMatters([task]) },
  onOpenMatter: (/** @type {string} */ id) => openDeskDetail({kind:'matter',id}),
  onOpenTerminal: (/** @type {string} */ id) => openDeskDetail({kind:'terminal',id}),
  onSend: focusConversationInput,
  onDelegate: async (/** @type {import('./modules/task-entry.js').Draft} */ draft) => {
    const result = await taskEntry.open(draft)
    if (result) await openAcceptedEntry(result)
    return result
  },
  formatInvokeError,
  doctorPoller,
  mock,
  setPending,
  // Dashboard's restart button routes to the wizard service step when no
  // service is registered — needs a way to flip mode + step without
  // direct-importing this file. Capture as a callback.
  routeToWizardService: () => {
    setMode("wizard")
    showStep("service")
  },
  // Dashboard's expired-account 重新扫码 button routes here. The
  // wizard's bind/QR step is named "wechat" (see wizard.js STEP_ORDER).
  routeToWizardBind: () => {
    setMode("wizard")
    showStep("wechat")
  },
  markDisconnected: () => {
    state.connectionIntent = "disconnected"
    const current = doctorPoller.current
    if (current) {
      renderDashboardIfActive(current)
      renderRestartButtonIfActive(current)
    }
  },
  markConnected: () => {
    state.connectionIntent = null
    const current = doctorPoller.current
    if (current) {
      renderDashboardIfActive(current)
      renderRestartButtonIfActive(current)
    }
  },
  // True when the user explicitly clicked 断开连接. Both intentional and
  // unexpected interruptions now recover through the same one-click surface.
  isDisconnectedIntent: () => state.connectionIntent === "disconnected",
  // Reconnect failure details stay in the existing logs pane.
  routeToLogsPane: () => {
    switchPane("logs")
  },
  // Recovery callbacks open the settings drawer at the relevant section.
  // The drawer currently doesn't have separate provider/access deep-links —
  // cheapest approach is just opening the drawer (no major refactor needed).
  routeToAccessSettings: () => {
    openSettingsDrawer()
  },
  routeToProviderSettings: () => {
    openSettingsDrawer()
    renderNoBrain(deps, true)
    setTimeout(() => {
      document.getElementById("brain-health")?.scrollIntoView?.({ block: "nearest" })
    }, 150)
  },
  // Health probe — pings /v1/health via the wechat_health_ping Tauri command.
  // Returns true if daemon responds 200, false on any error (no daemon, timeout,
  // token missing). Returns null when internal_api info is unavailable (daemon
  // was dead when doctor last polled) so code 7 never misfires in that case.
  healthProbe: async () => {
    const internal_api = doctorPoller.current?.checks?.daemon?.internal_api
    if (!internal_api) return null
    return pingHealth(internal_api.port, internal_api.token_file_path)
  },
  // 后台版本 vs 本包自带的 CLI 版本 —— 桌面更新后旧后台还在跑时,重连诊断据此直说「后台还是旧版」。
  healthVersion: async () => {
    const internal_api = doctorPoller.current?.checks?.daemon?.internal_api
    if (!internal_api) return null
    return fetchDaemonVersion(internal_api.port, internal_api.token_file_path)
  },
}

// Live status line for the network guard toggle. Pulls fresh probe
// each refresh — `wechat-cc guard status` is itself one-shot and does
// the IP + canary fetch synchronously. Fast enough for a click; not
// fast enough to call on every doctor tick (would burn one google
// HEAD per 5s), so we trigger only on toggle clicks + on dashboard
// entry (see setMode below).
async function refreshGuardStatus() {
  // Update both the drawer (canonical IDs) and wizard step-4 (screen-* IDs).
  const statusEls = /** @type {HTMLElement[]} */ (/** @type {unknown[]} */ ([
    document.getElementById("guard-status-line"),
    document.getElementById("screen-guard-status-line"),
  ]).filter(Boolean))
  const toggleEls = /** @type {HTMLElement[]} */ (/** @type {unknown[]} */ ([
    document.getElementById("guard-toggle"),
    document.getElementById("screen-guard-toggle"),
  ]).filter(Boolean))
  if (!statusEls.length) return
  for (const el of statusEls) el.textContent = "查询中…"
  try {
    const r = /** @type {GuardStatus} */ (await invoke("wechat_cli_json", { args: ["guard", "status", "--json"] }))
    for (const id of ["guard-row", "screen-guard-row"]) {
      const row = document.getElementById(id)
      if (row) row.hidden = !guardRowVisible(r)
    }
    for (const toggle of toggleEls) {
      if (r.enabled) toggle.classList.add("on")
      else toggle.classList.remove("on")
      toggle.setAttribute("aria-pressed", r.enabled ? "true" : "false")
    }
    if (!r.enabled) {
      for (const el of statusEls) {
        el.textContent = "未开启"
        delete el.dataset.state  // wipe stale color from previous run
      }
      return
    }
    // 2026-10-02:装了 bx 以 bx 为准(source=bx);老 CLI 没有 source 字段时退回 IP · google。
    // 守护 v2:带上 protected_in_use / providers —— 没用到需要保护的接口时不报红。
    const line = r.source ? guardLine({ enabled: r.enabled, source: r.source, safe: r.safe ?? r.reachable, detail: r.detail ?? "", protected_in_use: r.protected_in_use, providers: r.providers }) : null
    const ipPart = r.ip ? `IP ${r.ip}` : "IP 未知"
    const text = line
      ? (r.source === "bx" ? (line.state === "down" && line.detail ? `${line.text}(${line.detail})` : line.text) : `${ipPart} · ${r.reachable ? "google ✓" : "google ✗"}${line.state === "down" ? ` · ${line.text}` : ""}`)
      : `${ipPart} · ${r.reachable ? "google ✓" : "google ✗"}`
    for (const el of statusEls) {
      el.textContent = text
      el.dataset.state = line ? (line.state === "idle" ? "idle" : line.state === "ok" ? "ok" : "down") : (r.reachable ? "ok" : "down")
    }
  } catch (err) {
    for (const el of statusEls) {
      el.textContent = `查询失败：${/** @type {any} */ (err)?.message || err}`
    }
  }
}

// ─── mode router ──────────────────────────────────────────────────────
let wizardNavigation = 0

/**
 * 「CC 现在怎么样」里一行的动作 ⇒ 带到桌面上做这件事的地方(2026-10-17,上手门槛)。认不出 ⇒ false,那一行照旧只写提示。
 * @param {string} id @param {string} where
 */
function openCapabilityPlace(id, where) {
  /** @type {HTMLDetailsElement|null} */ const details = document.querySelector('.cc-home-details')
  const go = (/** @type {() => void} */ fn) => { if (details) details.open = false; fn(); return true }
  if (id === 'wechat') return go(() => deps.routeToWizardBind())
  if (id === 'phone') { const b = document.getElementById('open-phone-settings'); return b ? go(() => b.click()) : false }
  if (where === 'settings' || id === 'guard') return go(() => openSettingsDrawer())
  return false
}

/** @param {string} mode */
function setMode(mode) {
  wizardNavigation++
  if (mode !== 'wizard') stopQr(state)
  state.mode = mode
  document.documentElement.dataset.mode = mode
  syncNotebookMail()
  syncOnboardPhone()
  if (mode === "dashboard") {
    doctorPoller.start()
    conversationsPoller.start()
    if (!state.updateProbed) {
      state.updateProbed = true
      loadUpdateProbe(deps).catch(err => console.error("update probe failed", err))
    }
    // Incidents are checked on every doctor-poller tick (see
    // checkIncidentsOnPoll, subscribed in wireDoctorSubscribers below) —
    // not gated here — so a new outage is discovered within ~60s even
    // while the owner is parked on a non-overview pane, not just on
    // dashboard entry.
  } else {
    if (mode === 'wizard' && state.currentStep === 'service') doctorPoller.start()
    else doctorPoller.stop()
    conversationsPoller.stop()
  }
  if (mode === 'dashboard' && deskPlaces && !deskPlaces.places().length) {
    void deskPlaces.refresh().then(() => {
      if (state.mode === 'dashboard') mainNavigation.setReady(true)
    })
  } else mainNavigation.setReady(mode === 'dashboard')
  // 主页的一件件事只在此刻开着时读。
  if (mode === 'dashboard' && document.querySelector('.dash-pane[data-pane="overview"]:not([hidden])')) void homeTasks.start()
  else homeTasks.stop()
}

// 引导页最后一步的码(spec 2026-10-01-tendhearth-pairing-ux §5):在 #screen-service 且 daemon 活着才要码。
/** @type {ReturnType<typeof mountOnboardPhone> | null} */ let onboardPhone = null
// 同一步里可选的「接上终端里的 Claude Code / Codex」(2026-10-14):同样只在这一步且 daemon 活着时去问。
/** @type {ReturnType<typeof mountOnboardTerminal> | null} */ let onboardTerminal = null
function syncOnboardPhone(report = doctorPoller.current) {
  const active = document.documentElement.dataset.mode === "wizard" && !!document.getElementById("screen-service")?.classList.contains("active")
  onboardPhone?.sync({ active, alive: !!report?.checks?.daemon?.alive })
  onboardTerminal?.sync({ active, alive: !!report?.checks?.daemon?.alive })
}

/** @param {string} name */
function showStep(name) {
  wizardNavigation++
  const entering = name !== state.currentStep || !state.setup
  if (name !== 'wechat') stopQr(state)
  wizardShowStep(state, name)
  syncOnboardPhone()
  // Service step has the guard toggle — refresh status when entering so
  // the line shows current IP + reachability without waiting for a click.
  if (name === 'service') { doctorPoller.start(); refreshGuardStatus() }
  else if (state.mode !== 'dashboard') doctorPoller.stop()
  if (name === 'provider') syncProviderPicker()
  if (name === 'wechat' && entering) void refreshQr({invoke,mock},state)
}

// ─── doctor subscribers ──────────────────────────────────────────────

function wireDoctorSubscribers() {
  doctorPoller.subscribe(renderDoctorWizard)
  doctorPoller.subscribe(syncProviderPicker)
  doctorPoller.subscribe(report => syncOnboardPhone(report))
  doctorPoller.subscribe(refreshEnterDashboardButton)
  doctorPoller.subscribe(report => { lastDaemon = report.checks.daemon; renderRail() })
  doctorPoller.subscribe(renderDashboardIfActive)
  doctorPoller.subscribe(renderRestartButtonIfActive)
  doctorPoller.subscribe(checkExpiredDiff)
  // Task 8 follow-up (connection-health): piggyback on the doctor poller's
  // existing 5s tick instead of a new isolated timer — checkIncidentsOnPoll
  // throttles itself to a 60s effective cadence internally. Runs regardless
  // of which pane is active (mirrors checkExpiredDiff above), so a new
  // outage that starts while the app is open surfaces without the owner
  // needing to revisit the overview pane.
  doctorPoller.subscribe(() => checkIncidentsOnPoll(deps))
  doctorPoller.subscribe(() => checkFsAccessOnPoll({ ...deps, ipcInvoke: invoke }))
  doctorPoller.subscribe(() => checkGuardOnPoll(deps))
  doctorPoller.subscribe(() => checkBrainHealthOnPoll(deps))
  // 执行者叫什么由 daemon 定(收敛清单 ⑥):没拿到过就随 doctor 节拍要一次(daemon 还没起来 ⇒ 下一拍再要)。
  // 老 daemon 不带 names ⇒ 一分钟才再问一次,不跟着 5 秒的节拍刷。
  let namesTriedAt = 0
  doctorPoller.subscribe(() => {
    if (haveExecutorNames() || Date.now() - namesTriedAt < 60_000) return
    namesTriedAt = Date.now()
    loadExecutorNames(deps.invokeApi)
  })
  conversationsPoller.subscribe(report => {
    if (state.mode === "dashboard") renderConversations(report, { invokeApi })
  })
}

// Per-poll diff detector — fires an OS notification when a bot transitions
// into the expiredBots list since the last tick. First poll's expired set
// is the baseline (lastExpiredIds starts empty, but we populate from the
// first report without firing) so already-expired-on-startup accounts don't
// spam a notification on every dashboard restart. Only NEWLY-expired
// accounts (those that appeared between two consecutive polls) trigger.
/** @type {Set<string> | null} */
let lastExpiredIds = null
/** @param {any} report */
function checkExpiredDiff(report) {
  const currentIds = new Set(/** @type {string[]} */ ((report.expiredBots || []).map(/** @param {any} b */ b => b.botId)))
  if (lastExpiredIds === null) {
    // Baseline pass — record but don't notify.
    lastExpiredIds = currentIds
    return
  }
  for (const id of currentIds) {
    if (!lastExpiredIds.has(id)) {
      const shortId = id.replace(/-im-bot$/, "").slice(0, 12)
      invoke("notify_user", {
        title: `Tendhearth CC：微信连接已失效（${shortId}）`,
        body: "这个微信号已经在别处重新扫码绑定了。这台电脑上的 CC 从现在起收不到新消息。点击打开 Tendhearth CC，重新扫一次码。",
      }).catch(err => console.warn("notify_user failed:", err))
    }
  }
  lastExpiredIds = currentIds
}

/** @param {any} report */
function dashboardDisplayReport(report) {
  if (report.checks.daemon?.alive) state.connectionIntent = null
  return state.connectionIntent === "disconnected"
    ? {
        ...report,
        checks: {
          ...report.checks,
          accounts: { ...report.checks.accounts, count: 0 },
        },
      }
    : report
}

/** @param {any} report */
function renderDashboardIfActive(report) {
  if (state.mode !== "dashboard") return
  const displayReport = dashboardDisplayReport(report)
  renderDashboard(displayReport)
}

/** @param {any} report */
function renderRestartButtonIfActive(report) {
  if (state.mode !== "dashboard") return
  renderRestartButton(dashboardDisplayReport(report))
}

// ─── agent picker ────────────────────────────────────────────────────

/** @param {string} provider */
function applyProviderUI(provider) {
  state.selectedProvider = provider
  document.querySelectorAll(".agent[data-provider]").forEach(btn => {
    const el = /** @type {HTMLElement} */ (btn)
    el.classList.toggle("selected", el.dataset.provider === provider)
  })
  syncProviderPicker()
}

let providerSaving = false
/** @param {any} [report] */
function syncProviderPicker(report = doctorPoller.current) {
  for (const card of document.querySelectorAll('.agent[data-provider]')) {
    const button = /** @type {HTMLButtonElement} */ (card)
    button.disabled = providerSaving || !providerReady(report,button.dataset.provider)
    button.setAttribute('aria-pressed', String(button.dataset.provider === state.selectedProvider))
  }
  const next = /** @type {HTMLButtonElement|null} */ (document.getElementById('continue-wechat'))
  const ready = providerReady(report,state.selectedProvider)
  if (next) next.disabled = providerSaving || !ready
  const note = document.getElementById('provider-state')
  if (note) note.textContent = providerSaving ? '正在保存选择…' : ready ? '可以继续。之后也能在设置中更换。' : '选择一个已就绪的 AI，再继续。'
}

/** @param {string} provider */
async function commitProvider(provider) {
  if (providerSaving) return false
  const error = document.getElementById('provider-error')
  if (error) error.textContent = ''
  providerSaving = true; syncProviderPicker()
  const args = ["provider", "set", provider, "--unattended", state.unattended ? "true" : "false"]
  try {
    await invoke("wechat_cli_text", { args })
    applyProviderUI(provider)
    if (state.mode === 'dashboard') void doctorPoller.refresh()
    return true
  } catch {
    if (error) error.textContent = '这次没能保存选择，原来的 AI 仍然保留。请重试。'
    return false
  } finally { providerSaving = false; syncProviderPicker() }
}

/** @param {any} report */
function hasAnyProvider(report) {
  return hasUsableProvider(report)
}

/** @param {any} report */
async function ensureUsableProviderSelected(report) {
  if (report?.checks?.provider?.ok) return false
  const fallback = report?.checks?.claude?.ok ? "claude"
    : report?.checks?.codex?.ok ? "codex"
    : report?.checks?.cursor?.ok ? "cursor"
    : report?.checks?.gemini?.ok ? "gemini"
    : report?.checks?.agy?.ok ? "agy"
    : null
  if (!fallback) return false
  return await commitProvider(fallback)
}

async function loadAgentConfig() {
  const config = /** @type {ProviderConfig} */ (await invoke("wechat_cli_json", { args: ["provider", "show", "--json"] }))
  const provider = config.provider || 'claude'
  state.unattended = config.dangerouslySkipPermissions !== false
  state.autoStart = config.autoStart === true
  // closeStopsDaemon: optional field, default false. Task 10 adds it.
  state.closeStopsDaemon = (/** @type {any} */ (config)).closeStopsDaemon === true
  applyProviderUI(provider)
  // Update drawer (canonical IDs) and wizard step-4 (screen-* IDs).
  setToggle("unattended-toggle", state.unattended)
  setToggle("screen-unattended-toggle", state.unattended)
  setToggle("autostart-toggle", state.autoStart)
  setToggle("screen-autostart-toggle", state.autoStart)
}

/**
 * @param {string} id
 * @param {boolean} on
 */
function setToggle(id, on) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.toggle("on", !!on)
  el.setAttribute("aria-pressed", on ? "true" : "false")
}

/** @type {ReturnType<typeof mountNotebook> | undefined} */
let notebook

// ─── pane switching ──────────────────────────────────────────────────

function reflectWorkbenchSearchRole() {
  const layer = document.querySelector('.dash-main > #conversation-matter-layer')
  if (!(layer instanceof HTMLElement)) return
  const page = layer.dataset.workbenchView === 'search'
  layer.setAttribute('role', page ? 'region' : 'dialog')
  layer.setAttribute('aria-label', page ? '搜索' : '事项')
  if (!layer.hidden && layer.dataset.workbenchView === 'search') {
    document.getElementById('topbar-cc')?.classList.toggle('active', !page)
  }
  if (page) layer.removeAttribute('aria-modal')
  else layer.setAttribute('aria-modal', 'true')
}

/** @param {string} name @param {string} [notebookDay] */
function switchPane(name, notebookDay) {
  const searchRequested = name === 'all' || name === 'together'
  if(searchRequested)name='workbench'
  const focusConversation = name === "converse" || name === 'chat'
  if(name==='workbench'&&rosterDock?.current())rosterDock.close()
  const wasThing = document.body.dataset.pane === 'thing'
  if (name === 'thing' && document.body.dataset.pane === 'overview') {
    const scroll = document.getElementById('converse-scroll')
    if (scroll) restoreDeskConversation = rememberConversationPosition(scroll)
  }
  document.body.dataset.pane = focusConversation ? "overview" : name
  if (wasThing && name !== 'thing') {
    searchTerminal = undefined
    thingThread?.close()
    deskPlaces?.clear()
  }
  const globalWaiting = document.getElementById('desk-waiting')
  const destination = document.querySelector(name === 'thing' ? '.thing-content' : '#converse-root')
  if (globalWaiting && destination && globalWaiting.nextElementSibling !== destination) destination.before(globalWaiting)
  reflectTopbarWaiting()
  document.getElementById('roster-aside')?.removeAttribute('data-open')
  document.getElementById('topbar-roster')?.setAttribute('aria-expanded', 'false')
  const search = document.getElementById('topbar-search')
  if (name === 'workbench') search?.setAttribute('aria-current', 'page')
  else search?.removeAttribute('aria-current')
  if (focusConversation) {memoryTopics?.close();name = "overview"}
  // 连接浮层只在原地看一眼:任何一次导航都把它收起。
  document.querySelector(".cc-home-details")?.removeAttribute("open")
  const currentPane = /** @type {HTMLElement|null} */ (document.querySelector('.dash-pane[data-pane]:not([hidden])'))
  if(name!=='todos')deactivateTodosPage()
  if(currentPane?.dataset.pane!==name){
    closeRecordReader({restoreFocus:false})
    deactivateAtelierGallery()
    if(currentPane?.dataset.pane==='a2a-agents'){
      deactivateHuntBag()
      deactivatePeople()
      deactivateWishes()
      deactivateA2AAgentsTab()
    }
  }
  if (isCurrentWorkbenchPane(name, currentPane)) {
    if (currentPane) {
      const wasSearch = currentPane.dataset.workbenchView === 'search'
      currentPane.dataset.workbenchView = searchRequested ? 'search' : 'detail'
      reflectWorkbenchSearchRole()
      if (wasSearch !== searchRequested) initWorkbenchPage(deps, { focusSearch: searchRequested && !preserveNavigationFocus })
    }
    return
  }
  document.querySelector(".topbar-more")?.removeAttribute("open")
  const backstagePanes = new Set(["sessions", "plugins", "logs"])
  document.querySelectorAll(".dash-nav-link[data-pane]").forEach(el => {
    const htmlEl = /** @type {HTMLElement} */ (el)
    const hit = htmlEl.dataset.backstageEntry === "true"
      ? backstagePanes.has(name)
      : htmlEl.dataset.pane === name || (name === 'workbench' && !(searchRequested) && htmlEl.dataset.pane === 'overview')
    htmlEl.classList.toggle("active", hit && !htmlEl.classList.contains("disabled"))
    if (hit && htmlEl.id !== 'topbar-cc') htmlEl.setAttribute('aria-current', 'page')
    else if (htmlEl.id !== 'topbar-cc') htmlEl.removeAttribute('aria-current')
  })
  document.querySelectorAll(".dash-pane[data-pane]").forEach(el => {
    const htmlEl = /** @type {HTMLElement} */ (el)
    if(htmlEl.closest('#roster-dock, .thing-detail'))return
    htmlEl.hidden = htmlEl.dataset.pane !== name && !(name === 'workbench' && htmlEl.dataset.pane === 'overview')
    if (htmlEl.dataset.pane === 'overview') htmlEl.inert = name === 'workbench'
  })
  if (name === 'notebook') {
    const host = document.getElementById('notebook-pane')
    if (!notebook && host) notebook = mountNotebook(host, invokeApi, notebookMail)
    notebook?.open(notebookDay)
  } else notebook?.close()
  // The destination must be visible before navigation transfers keyboard focus.
  // Logs pane gets a 10s auto-refresh tick while active; stop it on
  // pane switch so we don't burn CPU tailing log files no one is reading.
  if (name === "logs") {
    loadLogsPane(deps).catch(err => console.error("logs load failed", err))
    startLogsAutoRefresh(deps)
  } else {
    stopLogsAutoRefresh()
  }
  if (name === "memory") {
    loadMemoryPane(deps).catch(err => {
      console.error("memory load failed", err)
      const mr = document.getElementById("memory-rendered")
      // 错误信息可能带 CLI 的 stderr(文件名、联系人名):按纯文本放,不进 innerHTML
      if (mr) {
        const p = document.createElement("p")
        p.className = "empty-state"
        p.textContent = `加载失败：${formatInvokeError(err)}`
        mr.replaceChildren(p)
      }
    })
    loadMemoryTopZone(deps).catch(err => console.error("memory top zone failed", err))
  }
  if (name === "recollections") void loadLifeCategory(lifeCategory)
  else lifeArchive?.cancel()
  if (name === "atelier") void loadAtelierGallery({ invokeApi })
  if (name === "overview") { void presencePoller.refresh(); void homeTasks.start() }
  else homeTasks.stop()
  if (name === "todos") {
    initTodosPage(deps)
  }
  if (name === "workbench") {
    const layer=/** @type {HTMLElement|null} */(document.querySelector('.workbench-pane'))
    if(layer) layer.dataset.workbenchView=searchRequested?'search':'detail'
    reflectWorkbenchSearchRole()
    initWorkbenchPage(deps, {focusSearch: searchRequested && !preserveNavigationFocus})
    const back=document.getElementById('workbench-home')
    if(back){back.textContent=document.querySelector('.conversation-topic-panel:not([hidden])')?'‹ 返回话题':'‹ 返回对话';if(!preserveNavigationFocus && !(searchRequested))back.focus()}
  } else if(!rosterDock?.current()) {
    stopWorkbenchPolling()
  }
  if (name === "sessions") {
    activateDialogueWorkspace()
  } else {
    // Stop the dialogue pane's 30s auto-refresh tick when leaving it
    // (mirrors the logs/sessions auto-refresh lifecycle).
    stopDialogueAutoRefresh()
  }
  if (name === "overview") {
    focusConversationInput()
    initConversePage(deps, { focus: focusConversation && !preserveNavigationFocus })
    restoreDeskConversation?.()
    restoreDeskConversation = undefined
    if(!focusConversation && !preserveNavigationFocus) /** @type {HTMLElement|null} */(document.querySelector('.conversation-topic-panel:not([hidden])'))?.focus()
  }
  if (name === "a2a-agents") {
    activateHuntBag()
    activateWishes()
    refreshA2AAgents().catch(err => console.error("a2a-agents refresh failed", err))
    // 打开觅食台 = 看过了:推水位,再立刻刷一次桌宠状态让包袱消失。
    markJournalSeen().then(() => presencePoller.refresh()).catch(() => {})
  }
  if (name === "plugins") {
    refreshPlugins().catch(err => console.error("plugins refresh failed", err))
  }
}

function activateDialogueWorkspace() {
  // 后厨's 会话 view. 待办 is a top-level pane now and 客户回顾 is retired
  // (2026-08-25 owner IA decisions; module deleted 2026-09-27) — no mode
  // branching left here.
  const dialogueRoot = document.getElementById("dialogue-root")
  if (dialogueRoot) dialogueRoot.hidden = false
  initDialoguePage(deps)
}

// ─── DOM event wiring ────────────────────────────────────────────────

function wireEvents() {
  // 连接浮层:点此刻页的空白处或按 Esc 收起(浮层外的别处不管,免得误关从浮层里打开的对话框)。
  document.addEventListener("click", ev => {
    const details = document.querySelector(".cc-home-details[open]")
    const target = ev.target instanceof Element ? ev.target : null
    if (details && target && !details.contains(target) && target.closest(".cc-now-pane")) details.removeAttribute("open")
  })
  document.addEventListener("keydown", ev => {
    if (ev.key !== "Escape") return
    const details = document.querySelector(".cc-home-details[open]")
    if (!details || document.querySelector("dialog[open]")) return
    const summary = /** @type {HTMLElement|null} */ (details.querySelector("summary"))
    details.removeAttribute("open")
    summary?.focus()
  })
  document.addEventListener("click", ev => {
    const target = ev.target instanceof Element ? ev.target : null
    const go = target?.closest("[data-life-pane]")
    const category = target?.closest("[data-life-category]")
    if (go) {
      if (go.getAttribute("data-life-start") === "postcards") lifeCategory = "postcards"
      navigateDeskPane(go.getAttribute("data-life-pane") || "overview")
    }
    if (category) void loadLifeCategory(category.getAttribute("data-life-category") || "postcards")
  })

  // 连接手机(spec 2026-10-01-tendhearth-pairing-ux §4.3):admin 路由走原生宿主(invokeWorkbenchApi),渲染进程拿不到令牌。
  const phoneConnect = mountPhoneConnect({
    call: (method, path, body) => invokeWorkbenchApi(method, path, body),
    renderQr: text => /** @type {Promise<string>} */ (deps.invoke("render_qr_svg", { text })),
  })
  document.getElementById("open-phone-settings")?.addEventListener("click", () => phoneConnect.open())
  const onboardHost = document.getElementById("onboard-phone")
  if (onboardHost) onboardPhone = mountOnboardPhone({
    host: onboardHost,
    call: (method, path, body) => invokeWorkbenchApi(method, path, body),
    renderQr: text => /** @type {Promise<string>} */ (deps.invoke("render_qr_svg", { text })),
  })
  const onboardTerminalHost = document.getElementById("onboard-terminal")
  if (onboardTerminalHost) onboardTerminal = mountOnboardTerminal({ host: onboardTerminalHost, call: (method, path, body) => invokeWorkbenchApi(method, path, body) })

  // 大脑卡交互:测试连接(唯一的真实拨号入口)/ 接入表单 / 复制命令 / 保存 key / 重启
  document.getElementById("brain-selfcheck")?.addEventListener("click", () => {
    runTroubleshoot(deps).catch(err => console.warn("[brain] selfcheck failed:", err))
  })
  document.getElementById("brain-health")?.addEventListener("click", (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target : null
    if (!t) return
    if (t.closest('[data-action="brain-recheck"]') || t.closest('[data-action="brain-troubleshoot"]')) {
      runTroubleshoot(deps).catch(err => console.warn("[brain] troubleshoot failed:", err))
      return
    }
    if (t.closest('[data-action="brain-dial"]')) {   // 第二步:用户点了「叫醒大脑」才真拨号
      runBrainDial(deps).catch(err => console.warn("[brain] dial failed:", err))
      return
    }
    if (t.closest('[data-action="brain-close"]')) { closeTroubleshoot(deps); return }
    // 接大脑引导:API Key 直开 OpenAI 兼容表单;订阅登录列 CLI 选项
    if (t.closest('[data-action="connect-ai"]')) {
      closeProviderMenu()
      renderNoBrain(deps, true)
      document.getElementById("brain-health")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      return
    }
    if (t.closest('[data-action="nb-apikey"]')) { openBrainSetup(deps, "openai"); return }
    if (t.closest('[data-action="nb-cli"]')) {
      void openCliChoices(deps)
      return
    }
    const launch = t.closest('[data-cli-action]')
    if (launch instanceof HTMLButtonElement && !launch.disabled) {
      void startCliSetup(deps, launch.dataset.provider || '', launch.dataset.cliAction || '')
      return
    }
    const recheck = t.closest('[data-cli-recheck]')
    if (recheck instanceof HTMLElement) { recheckCliSetup(deps, recheck.dataset.cliRecheck || ''); return }
    const website = t.closest('[data-cli-website]')
    if (website instanceof HTMLButtonElement && !website.disabled) { void invoke('open_url', { url: website.dataset.cliWebsite }).catch(() => {}); return }
    const setup = t.closest("[data-brain-setup]")
    if (setup instanceof HTMLElement && setup.dataset.brainSetup) {
      openBrainSetup(deps, setup.dataset.brainSetup)
      return
    }
    const copy = t.closest("[data-copy-cmd]")
    if (copy instanceof HTMLElement && copy.dataset.copyCmd) {
      navigator.clipboard?.writeText(copy.dataset.copyCmd).then(() => { copy.textContent = "已复制 ✓"; setTimeout(() => { copy.textContent = "复制" }, 1500) }).catch(() => {})
      return
    }
    const save = t.closest('[data-action="brain-save-key"]')
    if (save instanceof HTMLElement && save.dataset.provider) {
      saveBrainKey(deps, save.dataset.provider).catch(err => console.warn("[brain] save key failed:", err))
      return
    }
    if (t.closest('[data-action="brain-restart"]')) {
      restartDaemon(deps).catch(err => console.warn("[brain] restart failed:", err))
    }
  })

  // 后厨 sub-tabs (会话/插件/日志) — one identical strip lives at the top of
  // each of the three backstage panes; clicking just switches the dash pane.
  document.querySelectorAll(".dialogue-workspace-tab[data-backstage-pane]").forEach(tab => {
    tab.addEventListener("click", () => {
      const el = /** @type {HTMLElement} */ (tab)
      if (el.dataset.backstagePane) navigateDeskPane(el.dataset.backstagePane)
    })
  })
  // `data-tauri-drag-region` alone is not reliable with the macOS overlay
  // titlebar in every Tauri/WebKit combination. Explicitly start a native
  // window drag when the user presses a drag region.
  // 两栏的标题条是嵌套的拖拽区,里面还有按钮:只认按在拖拽区本身上的那一下
  //(按钮照常点);外层的拖拽区看到的 target 不是自己,所以一下只起一次拖拽。
  // 不拦冒泡:Tauri 自己挂在 document 上的那一份(双击放大)照旧收得到。
  document.querySelectorAll("[data-tauri-drag-region]").forEach(region => {
    region.addEventListener("mousedown", event => {
      if (!(event instanceof MouseEvent) || event.button !== 0 || event.target !== region) return
      const currentWindow = /** @type {any} */ (window).__TAURI__?.window?.getCurrentWindow?.()
      if (!currentWindow?.startDragging) return
      event.preventDefault()
      currentWindow.startDragging().catch(/** @param {unknown} err */ err => {
        console.warn("window drag failed:", err)
      })
    })
  })

  // Single delegated handler for any [data-copy] button — used by the
  // doctor row fix-hints (`复制` button next to npm install commands).
  // Delegated so newly-rendered rows stay live without re-binding.
  document.addEventListener("click", async (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target.closest("[data-copy]") : null
    if (!t) return
    try {
      await navigator.clipboard.writeText(t.getAttribute("data-copy") || "")
      const orig = t.textContent
      t.textContent = "已复制 ✓"
      setTimeout(() => { t.textContent = orig }, 1200)
    } catch { /* clipboard denied → silent; the command is visible in the code block */ }
  })

  // Multi-step wizard navigation. continue-* buttons advance forward;
  // recheck-env re-runs the doctor and auto-advances if a provider
  // appeared since the user last saw the screen.
  document.getElementById("continue-provider")?.addEventListener("click", () => showStep("provider"))
  document.getElementById("continue-wechat")?.addEventListener("click", () => showStep("wechat"))
  // Already fully set up (service installed + provider ok)? Skip the
  // "后台服务" install step and go straight to the dashboard — a returning
  // user re-scanning on a configured machine has nothing to install.
  document.getElementById("continue-service")?.addEventListener("click", () => {
    if (afterScanTarget(doctorPoller.current) === "dashboard") setMode("dashboard")
    else showStep("service")
  })
  document.getElementById("recheck-env")?.addEventListener("click", async () => {
    const navigation = wizardNavigation
    const current = () => navigation === wizardNavigation && state.mode === "wizard" && state.currentStep === "doctor"
    const report = await doctorPoller.refresh()
    if (!report || !current()) return
    await ensureUsableProviderSelected(report)
    if (!current()) return
    const latest = doctorPoller.current ?? report
    if (hasAnyProvider(latest)) showStep("provider")
  })
  document.getElementById("qr-refresh")?.addEventListener("click", () => refreshQr({ invoke, mock }, state))
  document.getElementById('wechat-back')?.addEventListener('click',()=>showStep('provider'))
  document.getElementById('provider-back')?.addEventListener('click',()=>showStep('doctor'))
  document.getElementById('service-recheck')?.addEventListener('click',()=>doctorPoller.refresh())
  document.getElementById("service-install")?.addEventListener("click", () => serviceAction(deps, state, "install"))
  document.getElementById("post-stop-kill")?.addEventListener("click", () => forceKillDaemon(deps))
  document.getElementById("enter-dashboard")?.addEventListener("click", () => setMode("dashboard"))
  document.getElementById("copy-diagnostics")?.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(JSON.stringify(doctorPoller.current, null, 2))
  })

  // Provider-card clicks (screen-provider): commit the agent and persist.
  document.querySelectorAll(".agent[data-provider]").forEach(btn => {
    const el = /** @type {HTMLElement} */ (btn)
    el.addEventListener("click", () => commitProvider(el.dataset.provider ?? ""))
  })

  document.getElementById("service-plan-toggle")?.addEventListener("click", () => {
    document.getElementById("service-plan")?.classList.toggle("show")
  })

  // Wizard-side toggles (live inside #screen-service). The settings drawer
  // has its own copies of these IDs wired by wireSettingsDrawer with a
  // selector scoped to #settings-drawer, so scope ours to #screen-service
  // to avoid double-binding. getElementById picks the wizard copies first
  // (document order), so service.js sees the wizard state when the user
  // clicks 安装并启动 from inside the wizard.
  document.querySelectorAll("#screen-service [data-toggle]").forEach(t => {
    const el = /** @type {HTMLElement} */ (t)
    el.addEventListener("click", async () => {
      el.classList.toggle("on")
      const on = el.classList.contains("on")
      el.setAttribute("aria-pressed", on ? "true" : "false")
      if (el.id === "screen-unattended-toggle") state.unattended = on
      if (el.id === "screen-autostart-toggle") state.autoStart = on
      if (el.id === "screen-guard-toggle") {
        try {
          await invoke("wechat_cli_json", { args: ["guard", on ? "enable" : "disable", "--json"] })
          refreshGuardStatus()
        } catch (err) {
          // 2026-10-13:以前吞掉错误、开关停在新位置 —— 界面说开了其实没开。跟设置抽屉一样回滚,并在下面那行说一句。
          console.error("guard toggle failed:", err)
          el.classList.toggle("on", !on)
          el.setAttribute("aria-pressed", !on ? "true" : "false")
          const line = document.getElementById("screen-guard-status-line")
          if (line) { line.textContent = `没能${on ? "开启" : "关闭"}网络守护，开关已恢复原样。稍后再点一次。`; line.dataset.state = "down" }
        }
      }
    })
  })

  const refreshCalendarSetting = wireCalendarSetting(invokeWorkbenchApi)
  wireSettingsDrawer({
    deps: { invokeWorkbenchApi },
    onOpen: () => {
      void refreshGuardStatus()
      void refreshCalendarSetting()
      const toggle = /** @type {HTMLButtonElement|null} */ (document.getElementById('recap-toggle'))
      if (!toggle) return
      toggle.disabled = true
      void v1(invokeWorkbenchApi, V1.places.recapSettings).then(result => {
        if (typeof result?.recap !== 'boolean') return
        toggle.classList.toggle('on', result.recap)
        toggle.setAttribute('aria-pressed', String(result.recap))
        toggle.disabled = false
      }).catch(() => {})
    },
    onToggleChange: async (id, on) => {
      // 返回 false → 持久化失败,让 settings-drawer 回滚开关(别让 UI 撒谎)。
      if (id === "recap-toggle") {
        const result = await v1(invokeWorkbenchApi, V1.places.setRecap, { body: { recap: on } })
        if (result?.recap !== on) return false
        void deskPlaces?.refreshAfterWrite()
        thingThread?.refreshRecap()
      } else if (id === "unattended-toggle") {
        state.unattended = on
        try {
          await invoke("wechat_cli_text", { args: ["provider", "set", state.selectedProvider || "claude", "--unattended", on ? "true" : "false"] })
        } catch (err) { console.error("unattended set failed:", err); state.unattended = !on; return false }
      } else if (id === "autostart-toggle") {
        state.autoStart = on
        try {
          await invoke("wechat_cli_text", { args: ["provider", "set", state.selectedProvider || "claude", "--auto-start", on ? "true" : "false"] })
        } catch (err) { console.error("autoStart set failed:", err); state.autoStart = !on; return false }
      } else if (id === "guard-toggle") {
        try {
          await invoke("wechat_cli_json", { args: ["guard", on ? "enable" : "disable", "--json"] })
          refreshGuardStatus()
        } catch (err) { console.error("guard toggle failed:", err); return false }
      } else if (id === "memory-embryo-toggle") {
        setMemoryEmbryoEnabled(on)
        renderMemoryProfileOverview(deps)
      }
      return true
    },
  })

  const embryoToggle = document.getElementById("memory-embryo-toggle")
  if (embryoToggle) {
    const on = isMemoryEmbryoEnabled()
    embryoToggle.classList.toggle("on", on)
    embryoToggle.setAttribute("aria-pressed", on ? "true" : "false")
  }

  document.getElementById("settings-open")?.addEventListener("click", () => {
    openSettingsDrawer()
    refreshLicense().catch(err => console.error("license refresh failed", err))
  })

  document.getElementById("qr-raw-toggle")?.addEventListener("click", () => {
    const raw = document.getElementById('qr-raw')
    if (raw) { const open = raw.classList.toggle('show'); raw.hidden = !open; document.getElementById('qr-raw-toggle')?.setAttribute('aria-expanded',String(open)) }
  })

  document.getElementById("dash-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(/** @type {HTMLButtonElement} */ (e.currentTarget), () => doctorPoller.refresh()),
  )
  document.getElementById("dash-stop")?.addEventListener("click", () => stopDaemon(deps))
  document.getElementById("dash-restart")?.addEventListener("click", () => restartDaemon(deps))
  document.getElementById("dash-view-details")?.addEventListener("click", () => deps.routeToLogsPane())
  document.getElementById("dash-test-conn")?.addEventListener("click", async () => {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("dash-test-conn"))
    if (!btn) return
    btn.disabled = true
    btn.textContent = "测试中…"
    try {
      const res = await invoke("wechat_cli_json", { args: ["connection", "probe", "--json"] })
      const parsed = typeof res === "string" ? JSON.parse(res) : res
      const accounts = /** @type {any[]} */ (parsed.accounts || [])
      const states = /** @type {string[]} */ (accounts.map(/** @param {any} a */ a => a.state))
      // Four outcomes — tell the user WHAT happened + HOW to fix. Verdict
      // precedence: no accounts → taken_over → connected → inconclusive.
      let verdict, msg, ms
      if (accounts.length === 0) {
        verdict = "none"; msg = "还没绑定账号 — 请先扫码绑定"; ms = 4000
      } else if (states.includes("taken_over")) {
        verdict = "taken_over"; msg = "本机未连接：连接在另一台设备上。要在本机接管，点下方「重新扫码绑定」"; ms = 6000
      } else if (states.includes("connected")) {
        verdict = "connected"; msg = "✓ 本机已连接，正常收发消息"; ms = 3500
      } else {
        verdict = "inconclusive"; msg = "无法确认连接 — 网络异常或服务器无响应，请检查网络后重试"; ms = 5000
      }
      // Only a definitive verdict drives the hero; inconclusive/none leave it as-is.
      setLastProbe(verdict === "connected" || verdict === "taken_over" ? { state: verdict } : null)
      setPending(msg)
      setTimeout(() => setPending(""), ms)
      await doctorPoller.refresh()
    } catch (err) {
      setPending(`测试失败：${formatInvokeError(err)}`)
      setTimeout(() => setPending(""), 3000)
    } finally {
      btn.disabled = false
      btn.textContent = "测试本机连接"
    }
  })
  document.getElementById("dash-rebind")?.addEventListener("click", () => deps.routeToWizardBind())
  document.getElementById("memory-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(/** @type {HTMLButtonElement} */ (e.currentTarget), async () => {
      await loadMemoryPane(deps)
      await loadMemoryTopZone(deps)
    }),
  )
  // "更新项目地图" — regenerate the overview / project map (_overview.md) from local
  // Claude memory. Renamed from "重新整理" (2026-10-01) so it no longer reads like
  // WeChat「整理记忆」, which curates memory.md — different thing. This
  // is a slow LLM call (not a reload), so it gets its own progress labels
  // rather than withRefreshFeedback's "已刷新".
  document.getElementById("memory-synthesize-btn")?.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget)
    const labelNode = Array.from(btn.childNodes).find(
      n => n.nodeType === Node.TEXT_NODE && n.textContent !== null && n.textContent.trim().length > 0,
    )
    const original = labelNode ? labelNode.textContent : null
    btn.disabled = true
    if (labelNode) labelNode.textContent = " 更新中…"
    let ok = false
    try {
      const res = await synthesizeMemory(deps)
      ok = !!(res && res.written)
    } catch (err) {
      console.error("memory synthesize failed", err)
    } finally {
      if (labelNode) labelNode.textContent = ok ? " 已更新 ✓" : " 更新失败"
      setTimeout(() => {
        if (labelNode && original !== null) labelNode.textContent = original
        btn.disabled = false
      }, 1600)
    }
  })
  const runProfileGenerateButton = async (/** @type {HTMLButtonElement} */ btn) => {
    const labelNode = Array.from(btn.childNodes).find(
      n => n.nodeType === Node.TEXT_NODE && n.textContent !== null && n.textContent.trim().length > 0,
    )
    const original = labelNode ? labelNode.textContent : null
    btn.disabled = true
    if (labelNode) labelNode.textContent = " 检查中…"
    let ok = false
    let skippedReason = ""
    try {
      const res = await generateMemoryProfile(deps)
      if (res && "skipped" in res && res.skipped) {
        skippedReason = res.reason || "无需更新"
      } else {
        ok = !!(res && res.ok && "written" in res && res.written)
      }
    } catch (err) {
      console.error("memory profile generate failed", err)
    } finally {
      if (labelNode) labelNode.textContent = skippedReason || (ok ? " 已更新 ✓" : " 生成失败")
      setTimeout(() => {
        if (labelNode && original !== null) labelNode.textContent = original
        btn.disabled = false
      }, 1600)
    }
  }
  document.getElementById("memory-profile-generate-btn")?.addEventListener("click", async (e) => {
    await runProfileGenerateButton(/** @type {HTMLButtonElement} */ (e.currentTarget))
  })
  document.getElementById("memory-profile-content")?.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLButtonElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("#memory-profile-generate-quick") : null)
    if (!btn) return
    await runProfileGenerateButton(btn)
  })
  wireMemoryButtons(deps)

  document.getElementById("memory-sources-toggle")?.addEventListener("click", () => {
    const toggle = document.getElementById("memory-sources-toggle")
    const panel = document.getElementById("memory-sources-panel")
    if (!toggle || !panel) return
    const wasOpen = toggle.getAttribute("aria-expanded") === "true"
    toggle.setAttribute("aria-expanded", wasOpen ? "false" : "true")
    panel.hidden = wasOpen
  })

  for (const id of ["memory-observations", "memory-archive"]) {
    document.getElementById(`${id}-toggle`)?.addEventListener("click", () => {
      const toggle = document.getElementById(`${id}-toggle`)
      const body = document.getElementById(`${id}-body`)
      if (!toggle || !body) return
      const wasOpen = toggle.getAttribute("aria-expanded") === "true"
      toggle.setAttribute("aria-expanded", wasOpen ? "false" : "true")
      body.hidden = wasOpen
    })
  }

  // 收回的话(架构终态 G6):展开时读;点「恢复」经 daemon 放回去
  document.getElementById("memory-retractions-toggle")?.addEventListener("click", () => {
    const toggle = document.getElementById("memory-retractions-toggle")
    const body = document.getElementById("memory-retractions-body")
    if (!toggle || !body) return
    const wasOpen = toggle.getAttribute("aria-expanded") === "true"
    toggle.setAttribute("aria-expanded", wasOpen ? "false" : "true")
    body.hidden = wasOpen
    if (!wasOpen) loadMemoryRetractions(deps).catch(err => console.error("retractions load failed", err))
  })
  document.getElementById("memory-retractions")?.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='restore-retraction']") : null)
    const key = btn?.getAttribute("data-key")
    if (key) restoreMemoryRetraction(deps, key).catch(err => console.error("restore failed", err))
  })

  // Local-project-memory fold: lazy-load on first expand (it's a CLI read of
  // ~/.claude/projects, not needed until the user looks).
  let projectMemoryLoaded = false
  document.getElementById("memory-projects-toggle")?.addEventListener("click", () => {
    const toggle = document.getElementById("memory-projects-toggle")
    const body = document.getElementById("memory-projects-body")
    if (!toggle || !body) return
    const wasOpen = toggle.getAttribute("aria-expanded") === "true"
    toggle.setAttribute("aria-expanded", wasOpen ? "false" : "true")
    body.hidden = wasOpen
    if (!wasOpen && !projectMemoryLoaded) {
      projectMemoryLoaded = true
      loadProjectMemory(deps).catch(err => console.error("project memory load failed", err))
    }
  })

  // Memory top zone — handle archive button clicks via delegation
  document.getElementById("memory-observations")?.addEventListener("click", async (e) => {
    const archiveBtn = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='archive-observation']") : null)
    if (archiveBtn) {
      e.stopPropagation()
      await archiveObservation(deps, archiveBtn.dataset.id || "")
    }
  })
  document.getElementById("memory-profile-content")?.addEventListener("click", (e) => {
    const closeEmbryo = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='close-memory-embryo']") : null)
    if (closeEmbryo) {
      e.stopPropagation()
      const panel = document.getElementById("memory-embryo-panel")
      const toggle = document.querySelector("[data-action='toggle-memory-embryo']")
      if (panel) panel.hidden = true
      if (toggle instanceof HTMLElement) toggle.setAttribute("aria-expanded", "false")
      return
    }
    const source = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='jump-memory-source']") : null)
    if (source) {
      e.stopPropagation()
      jumpToMemorySource(deps, {
        kind: /** @type {any} */ (source.dataset.sourceKind || "observation"),
        text: source.querySelector(".embryo-source-text")?.textContent || "",
        ts: "",
        label: source.querySelector(".embryo-source-kind")?.textContent || "",
        obsId: source.dataset.sourceId || undefined,
        userId: source.dataset.sourceUser || undefined,
        path: source.dataset.sourcePath || undefined,
      })
      return
    }
    const openAll = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='open-memory-observations']") : null)
    if (openAll) {
      e.stopPropagation()
      const sourcesToggle = document.getElementById("memory-sources-toggle")
      const sourcesPanel = document.getElementById("memory-sources-panel")
      const obsToggle = document.getElementById("memory-observations-toggle")
      const obsBody = document.getElementById("memory-observations-body")
      if (sourcesToggle && sourcesPanel) {
        sourcesToggle.setAttribute("aria-expanded", "true")
        sourcesPanel.hidden = false
      }
      if (obsToggle && obsBody) {
        obsToggle.setAttribute("aria-expanded", "true")
        obsBody.hidden = false
      }
      document.getElementById("memory-top-zone")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" })
      return
    }
    const toggle = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest("[data-action='toggle-memory-embryo']") : null)
    if (!toggle) return
    const panel = document.getElementById("memory-embryo-panel")
    if (!panel) return
    const host = toggle.closest(".memory-profile-companion")
    if (host instanceof HTMLElement) {
      const rect = host.getBoundingClientRect()
      const board = document.getElementById("memory-artboard")
      const boardScale = board instanceof HTMLElement
        ? Number.parseFloat(getComputedStyle(board).getPropertyValue("--memory-artboard-scale")) || 1
        : 1
      const panelWidth = Number.parseFloat(getComputedStyle(panel).width) || 500
      const hostWidth = rect.width / boardScale
      const xRaw = (e.clientX - rect.left) / boardScale
      const yRaw = (e.clientY - rect.top) / boardScale
      const x = Math.min(Math.max(xRaw, panelWidth / 2), Math.max(panelWidth / 2, hostWidth - panelWidth / 2))
      panel.style.setProperty("--memory-embryo-panel-x", `${x}px`)
      panel.style.setProperty("--memory-embryo-panel-y", `${yRaw}px`)
    }
    toggle.setAttribute("aria-expanded", "true")
    panel.hidden = false
  })

  // Memory decisions — toggle folded zone, lazy-load on FIRST expand only.
  // Closure flag persists across clicks (wireEvents runs once at boot) so we
  // don't re-read events.jsonl on every expand.
  let memoryDecisionsLoaded = false
  document.getElementById("memory-decisions-toggle")?.addEventListener("click", () => {
    const toggle = document.getElementById("memory-decisions-toggle")
    const body = document.getElementById("memory-decisions-body")
    if (!toggle || !body) return
    const wasOpen = toggle.getAttribute("aria-expanded") === "true"
    toggle.setAttribute("aria-expanded", wasOpen ? "false" : "true")
    body.hidden = wasOpen
    if (!wasOpen && !memoryDecisionsLoaded) {
      memoryDecisionsLoaded = true
      loadMemoryDecisions(deps).catch(err => console.error("decisions load failed", err))
    }
  })

  // Memory decisions — click row to expand reasoning (CSS handles the visual via .expanded class)
  document.getElementById("memory-decisions-body")?.addEventListener("click", toggleDecisionDisclosure)
  document.getElementById("logs-refresh")?.addEventListener("click", (e) =>
    withRefreshFeedback(/** @type {HTMLButtonElement} */ (e.currentTarget), () => loadLogsPane(deps)),
  )
  // Sessions pane was replaced by the data-driven 对话 page
  // (modules/dialogue-page.js); it self-wires all its events in
  // initDialoguePage(deps). The old sessions list/detail/search/favorite
  // wiring lived here and is gone with the mockup-replacement rewrite.
  document.getElementById("logs-tail-select")?.addEventListener("change", () => loadLogsPane(deps))
  // 筛选:边打边筛。不重新读日志(那要走 CLI,几百 KB),只重渲染已有的行 ——
  // loadLogsPane 会读同一个输入框,所以自动刷新那一拍也保持筛选状态。
  document.getElementById("logs-filter")?.addEventListener("input", () => rerenderLogs())
  document.getElementById("update-check-btn")?.addEventListener("click", () => loadUpdateProbe(deps))
  document.getElementById("update-apply-btn")?.addEventListener("click", () => applyUpdate(deps))

  document.getElementById("accounts-body")?.addEventListener("click", ev => handleAccountRowClick(deps, ev))
  document.getElementById("accounts-body")?.addEventListener("click", ev => {
    const btn = ev.target instanceof HTMLElement ? ev.target.closest(".card-menu") : null
    if (!btn) return
    ev.stopPropagation()
    toggleUserProviderMenu(deps, btn, doctorPoller.current)
  })

  // Provider-switch dropdown. The .provider-switch button lives inside
  // #accounts-current which is re-rendered on every doctor poll, so we
  // use event delegation on its container (2026-10-01 起在「连接与设置」抽屉的「连接」段)。
  // Escape-key and outside-click are handled inside toggleProviderMenu itself.
  document.querySelector('#settings-drawer .drawer-connection')?.addEventListener("click", ev => {
    const target = ev.target instanceof HTMLElement ? ev.target : null
    const addSubUser = target?.closest("[data-action='add-sub-user']")
    if (addSubUser) {
      setMode("wizard")
      showStep("wechat")
      return
    }
    const btn = target?.closest(".provider-switch")
    if (!btn) return
    ev.stopPropagation()
    toggleProviderMenu(deps, doctorPoller.current)
  })

  document.querySelectorAll("[data-action='open-wizard']").forEach(btn =>
    btn.addEventListener("click", () => setMode("wizard"))
  )
  document.querySelectorAll("[data-action='open-dashboard']").forEach(btn =>
    btn.addEventListener("click", () => setMode("dashboard"))
  )

  // 「浮到桌面」(spec 2026-10-01 §9-3):鱼缸画布退休后,浮窗桌宠只剩这一个入口,住在此刻页右上的连接面板里。
  const companionDesktopStart = /** @type {HTMLButtonElement | null} */ (document.getElementById("companion-desktop-start"))
  companionDesktopStart?.addEventListener("click", async () => {
    // The browser/dev shim cannot spawn a native Tauri window. Open the same
    // isolated scene in a popup there so visual work remains previewable.
    if (mock || /** @type {any} */ (window).__WECHAT_CC_SHIM__) {
      window.open("./companion-window.html", "wechat-cc-companion", "popup,width=260,height=330")
      return
    }
    companionDesktopStart.disabled = true
    try {
      await invoke("open_companion_window", {})
    } catch (err) {
      console.error("open companion window failed:", err)
      showToast(`无法打开桌面陪伴：${formatInvokeError(err)}`)
    } finally {
      companionDesktopStart.disabled = false
    }
  })

  document.querySelectorAll(".dash-nav-link[data-pane]").forEach(btn => {
    const el = /** @type {HTMLElement} */ (btn)
    el.addEventListener("click", () => {
      if (el.classList.contains("disabled")) return
      if (el.id === 'topbar-cc') switchPane('overview')
      else navigateDeskPane(el.dataset.pane ?? "", el.dataset.pane === "notebook" ? notebookMail.day() : undefined)
    })
  })

  // ─── Lightbox for chat-bubble image / file attachments ─
  document.body.addEventListener("click", (ev) => {
    const img = /** @type {HTMLImageElement | null} */ (ev.target instanceof HTMLElement ? ev.target.closest(".wechat-image") : null)
    if (img) {
      ev.preventDefault()
      openImageLightbox(img.src)
      return
    }
    const fileCard = /** @type {HTMLElement | null} */ (ev.target instanceof HTMLElement ? ev.target.closest(".wechat-file-card") : null)
    if (fileCard) {
      ev.preventDefault()
      openFileLightbox(fileCard.dataset.path, fileCard.dataset.name, fileCard.dataset.ext)
      return
    }
    const lightbox = ev.target instanceof HTMLElement ? ev.target.closest("#lightbox") : null
    if (lightbox && !(ev.target instanceof HTMLElement ? ev.target.closest(".lightbox-body") : null)) {
      closeLightbox()
    }
  })
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLightbox()
  })
}

/** @param {string} src */
function openImageLightbox(src) {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  // Build the <img> via DOM APIs instead of innerHTML interpolation —
  // `src` originates from .wechat-image elements whose src is set from
  // ilink-delivered attachment URLs (attacker-controllable). The old
  // template-string sink let a crafted src with a `"` escape the
  // attribute context and inject HTML/JS.
  body.textContent = ""
  const img = document.createElement("img")
  img.className = "lightbox-img"
  img.alt = "image"
  img.src = src  // setter coerces; never parsed as HTML
  body.appendChild(img)
  lb.hidden = false
  lb.setAttribute("aria-hidden", "false")
}

/**
 * @param {string | undefined} path
 * @param {string | undefined} name
 * @param {string | undefined} ext
 */
async function openFileLightbox(path, name, ext) {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  body.innerHTML = `
    <div class="lightbox-file">
      <div class="lightbox-file-head">
        <span class="lightbox-file-name">${escapeHtml(name || path || "")}</span>
        <span class="lightbox-file-tag">${escapeHtml(ext || "FILE")}</span>
      </div>
      <div class="lightbox-file-content is-empty">加载中…</div>
    </div>
  `
  lb.hidden = false
  lb.setAttribute("aria-hidden", "false")
  const content = /** @type {HTMLElement} */ (body.querySelector(".lightbox-file-content"))

  try {
    const url = "/attachment?path=" + encodeURIComponent(path ?? "")
    const r = await fetch(url)
    if (!r.ok) {
      content.classList.add("is-empty")
      content.textContent = `无法预览：${r.status} ${r.statusText}`
      return
    }
    const TEXT_EXTS = new Set(["TXT","MD","JSON","CSV","LOG","YAML","YML","XML","HTML","HTM","JS","TS","JSX","TSX","CSS","PY","SH","C","CPP","H","HPP","JAVA","GO","RS","TOML","INI","ENV","RB","PHP","SQL","CONF","DIFF","PATCH"])
    const e = (ext || "").toUpperCase()
    if (TEXT_EXTS.has(e)) {
      let text = await r.text()
      // Cap preview at ~200KB to keep DOM tractable.
      if (text.length > 200_000) text = text.slice(0, 200_000) + "\n\n…(预览已截断)"
      content.classList.remove("is-empty")
      content.textContent = text
    } else {
      // Binary: show first 1KB as hex preview so the user has *some* sense
      const buf = await r.arrayBuffer()
      const bytes = new Uint8Array(buf.slice(0, 1024))
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ")
      content.classList.remove("is-empty")
      content.textContent = `(二进制文件，前 ${bytes.length} 字节 hex 预览):\n\n${hex}`
    }
  } catch (err) {
    content.classList.add("is-empty")
    content.textContent = "读取失败：" + (/** @type {any} */ (err)?.message || String(err))
  }
}

// ─── Avatar edit modal ──────────────────────────────────────────────
//
// Click an avatar (.wechat-avatar with data-avatar-key) → modal opens
// inside the lightbox container, lets the user pick a new image (or
// remove the current one). Image is canvas-resized to 80×80 PNG before
// it's sent to the daemon CLI as base64. Reload reopens the chat to
// pick up the new avatar.

/**
 * @param {typeof deps} deps
 * @param {string | undefined} key
 */
async function openAvatarModal(deps, key) {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  const titleSubject = key === "claude" ? executorName(key) : (extractContactNameFromOpenChat() || "联系人")
  // Look up current avatar (if any) for the preview slot.
  /** @type {AvatarInfo | null} */
  let info = null
  try {
    info = /** @type {AvatarInfo} */ (await v1(deps.invokeWorkbenchApi, V1.avatar.info, { query: { key: key ?? "" } }))
  } catch { /* ignore — preview falls back */ }
  const previewHtml = info?.exists
    ? `<img src="/attachment?path=${encodeURIComponent(info.path)}&v=${Date.now()}"/>`
    : `<span style="background:${key === "claude" ? "#586672" : "#6B655C"}; width:100%; height:100%; display:flex; align-items:center; justify-content:center;">${escapeHtml(key === "claude" ? "cc" : (titleSubject.charAt(0).toUpperCase()))}</span>`

  body.innerHTML = `
    <div class="avatar-modal">
      <h3 class="avatar-modal-title">为 ${escapeHtml(titleSubject)} 设置头像</h3>
      <div class="avatar-modal-preview" id="avatar-modal-preview">${previewHtml}</div>
      <div class="avatar-modal-drop" id="avatar-modal-drop">
        点击选择图片，或拖拽到此处
        <input type="file" id="avatar-modal-input" accept="image/png,image/jpeg,image/webp" hidden />
      </div>
      <div class="avatar-modal-actions">
        <button class="btn ghost" id="avatar-modal-remove" ${info?.exists ? "" : "disabled"}>移除自定义</button>
        <span class="btn-spacer"></span>
        <button class="btn ghost" id="avatar-modal-cancel">取消</button>
      </div>
    </div>
  `
  lb.hidden = false
  lb.setAttribute("aria-hidden", "false")

  const input = /** @type {HTMLInputElement} */ (body.querySelector("#avatar-modal-input"))
  const drop = /** @type {HTMLElement} */ (body.querySelector("#avatar-modal-drop"))
  const preview = /** @type {HTMLElement} */ (body.querySelector("#avatar-modal-preview"))

  drop.addEventListener("click", () => input.click())
  input.addEventListener("change", () => handleAvatarFile(deps, key, input.files?.[0], preview))
  ;["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add("is-dragover")
  }))
  ;["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove("is-dragover")
  }))
  drop.addEventListener("drop", e => {
    const file = /** @type {DragEvent} */ (e).dataTransfer?.files?.[0]
    if (file) handleAvatarFile(deps, key, file, preview)
  })
  body.querySelector("#avatar-modal-cancel")?.addEventListener("click", closeLightbox)
  body.querySelector("#avatar-modal-remove")?.addEventListener("click", async () => {
    try {
      /** @type {AvatarRemove} */ (await v1(deps.invokeWorkbenchApi, V1.avatar.remove, { body: { key } }))
      closeLightbox()
      reopenCurrentSession(deps)
    } catch (err) {
      preview.innerHTML = `<span style="font-size:11px; color:var(--ink-3); padding:4px;">${escapeHtml(/** @type {any} */ (err)?.message || String(err))}</span>`
    }
  })
}

/**
 * @param {typeof deps} deps
 * @param {string | undefined} key
 * @param {File | undefined} file
 * @param {HTMLElement} previewEl
 */
async function handleAvatarFile(deps, key, file, previewEl) {
  if (!file) return
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    previewEl.innerHTML = `<span style="font-size:11px; color:var(--red); padding:4px;">仅支持 PNG / JPEG / WEBP</span>`
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    previewEl.innerHTML = `<span style="font-size:11px; color:var(--red); padding:4px;">图片太大（>5MB）</span>`
    return
  }
  try {
    const base64 = await imageToResizedPngBase64(file, 80)
    const _avatarSetResult = /** @type {AvatarSet} */ (await v1(deps.invokeWorkbenchApi, V1.avatar.set, { body: { key, base64 } }))
    void _avatarSetResult
    closeLightbox()
    reopenCurrentSession(deps)
  } catch (err) {
    previewEl.innerHTML = `<span style="font-size:11px; color:var(--red); padding:4px;">${escapeHtml(/** @type {any} */ (err)?.message || String(err))}</span>`
  }
}

/**
 * Read a File / Blob → draw onto canvas square-cropped + resized → PNG base64
 * @param {Blob} blob
 * @param {number} size
 * @returns {Promise<string>}
 */
function imageToResizedPngBase64(blob, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = size; canvas.height = size
        const ctx = canvas.getContext("2d")
        if (!ctx) { reject(new Error("canvas 2d context unavailable")); return }
        // Square-crop from center (cover behavior)
        const sw = img.naturalWidth, sh = img.naturalHeight
        const side = Math.min(sw, sh)
        const sx = (sw - side) / 2, sy = (sh - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
        const dataUrl = canvas.toDataURL("image/png")
        URL.revokeObjectURL(url)
        // Strip the data: prefix when sending to CLI
        resolve(dataUrl.replace(/^data:image\/png;base64,/, ""))
      } catch (e) { reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法读取图片")) }
    img.src = url
  })
}

function extractContactNameFromOpenChat() {
  return document.querySelector(".phone-title-name")?.textContent?.trim() || null
}

/** @param {typeof deps} deps */
function reopenCurrentSession(deps) {
  // (The old #sessions-detail branch was removed 2026-09-27: that DOM has been
  // gone since 2026-06-04, so it never fired.)
  // If the dialogue pane is mounted, refresh its timeline so new avatars appear.
  const dialogueRoot = document.getElementById("dialogue-root")
  if (dialogueRoot?.dataset.ready === "true") {
    import("./modules/dialogue-page.js").then(m => m.initDialoguePage(deps))
  }
}

function closeLightbox() {
  const lb = document.getElementById("lightbox")
  const body = document.getElementById("lightbox-body")
  if (!lb || !body) return
  if (lb.hidden) return
  body.innerHTML = ""
  lb.hidden = true
  lb.setAttribute("aria-hidden", "true")
}

/** @param {string | null | undefined} s */
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

// ─── boot ────────────────────────────────────────────────────────────

function showDevBannerIfShim() {
  // window.__WECHAT_CC_SHIM__ and __WECHAT_CC_DRY_RUN__ are injected by the
  // dev shim and not part of the standard Window type.
  const w = /** @type {any} */ (window)
  if (!w.__WECHAT_CC_SHIM__) return
  const banner = document.getElementById("dev-banner")
  if (!banner) return
  const allowMut = w.__WECHAT_CC_ALLOW_MUTATIONS__
  banner.innerHTML = w.__WECHAT_CC_DRY_RUN__
    ? `<b>演示模式 (DRY_RUN)</b> · 界面状态是假的，但未被拦下的命令仍会走真实 CLI`
    : allowMut
      ? `<b>开发模式 · 安全阀已关闭</b> · 删账号 / service / setup / update 会真实生效`
      : w.__WECHAT_CC_WORKBENCH_WRITES__
        ? `<b>开发模式</b> · 交给 CC 的事已连接真实执行 · 其他页面保持只读`
        : `<b>开发模式</b> · 操作会使用这台电脑上的 CC 和命令行组件，只允许执行已知的只读命令`
  // 关阀是唯一能毁掉真实状态的模式，颜色上必须一眼可辨（spec §3）。
  banner.classList.toggle("is-unsafe", Boolean(allowMut) && !w.__WECHAT_CC_DRY_RUN__)
  banner.hidden = false
}

/** 全局页头的下沿写进 --topbar-bottom,全屏事项层从这里开始,不被页头盖住返回键。 */
function trackTopbarBottom() {
  const heading = document.querySelector('.desk-heading')
  if (!heading) return
  const write = () => document.documentElement.style.setProperty('--topbar-bottom', `${Math.round(heading.getBoundingClientRect().bottom)}px`)
  write()
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(write)
    observer.observe(heading)
  }
  window.addEventListener('resize', write)
}

/** @param {ReturnType<typeof mountPlacesStrip>} strip @param {AbortSignal} signal */
function mountDeskHistory(strip, signal) {
  const root = document.documentElement
  const mac = root.dataset.platform === 'macos'
  const back = /** @type {HTMLButtonElement} */ (document.getElementById('desk-back'))
  const forward = /** @type {HTMLButtonElement} */ (document.getElementById('desk-forward'))
  back.title = `后退 ${mac ? '⌘[' : 'Alt+←'}`
  forward.title = `前进 ${mac ? '⌘]' : 'Alt+→'}`

  const searching = () => !!document.querySelector('.dash-main > #conversation-matter-layer[data-workbench-view="search"]:not([hidden])')

  /** @returns {import('./modules/desk-history.js').DeskLocation} */
  function location() {
    const pane = document.body.dataset.pane ?? 'overview'
    if (searching()) return { pane, place: null, detail: null, searchQuery: deskSearch.query }
    const task = pane === 'workbench' && document.querySelector('#conversation-matter-layer[data-workbench-view="detail"]')
      ? getViewedWorkbenchTaskId() : null
    if (pane === 'thing') {
      const item = thingThread?.current()
      const sessionId = item?.kind === 'terminal' ? item.id : item?.terminal?.sessionId
      if (searchTerminal && searchTerminal.id === sessionId) {
        return { pane, place: searchTerminal.place.key, detail: { kind: 'terminal', id: sessionId }, terminalPlace: searchTerminal.place }
      }
      return {pane,place:strip.selected(),detail:item ? {kind:item.kind,id:item.id} : null}
    }
    return { pane, place: strip.selected(), detail: rosterDock?.item() ?? expandedDetail
      ?? (task ? { kind: 'matter', id: task } : null) }
  }
  const history = createDeskHistory(location())
  const searchShortcut = document.getElementById('desk-search-shortcut')
  if (searchShortcut) searchShortcut.textContent = mac ? '⌘K' : 'Ctrl K'

  const buttons = /** @type {const} */ ([[back, -1], [forward, 1]])
  const reflect = () => {
    for (const [button, direction] of buttons) {
      const disabled = !history.canMove(direction)
      // Native disabling blurs a focused button. Keep it in place until focus leaves.
      button.disabled = disabled && document.activeElement !== button
      if (disabled && !button.disabled) button.setAttribute('aria-disabled', 'true')
      else button.removeAttribute('aria-disabled')
    }
  }
  recordDeskNavigation = () => { history.push(location()); reflect() }
  let moving = false
  const available = () => root.dataset.mode === 'dashboard' && !document.querySelector('dialog[open]')

  /** @param {import('./modules/desk-history.js').DeskLocation} entry */
  async function applyLocation({ pane, place, detail, terminalPlace, searchQuery }) {
    if (searchQuery !== undefined) {
      deskSearch.restoreQuery(searchQuery)
      switchPane('all')
      return true
    }
    if (pane === 'thing') {
      if (terminalPlace && detail?.kind === 'terminal') {
        const destination = searchTerminalDestination(detail, terminalPlace)
        if (!destination) return false
        openThing(destination, { id: detail.id, place: terminalPlace })
        return true
      }
      const next = strip.places().find(p => p.key === place)
      if (!next) return false
      const item = detail && thingThread?.find(next,detail)
      if (detail && !item) return false
      thingThread?.forgetView(next.key)
      if (item) openThing({place:next,item})
      else { switchPane('thing'); thingThread?.open(next); strip.selectKey(next.key) }
      return true
    }
    const before = location()
    const sameDetail = pane === before.pane && detail?.kind === before.detail?.kind && detail?.id === before.detail?.id
    if (!sameDetail) {
      rosterDock?.close()
      disposeExpandedDetail?.()
      disposeExpandedDetail = undefined
      expandedDetail = null
    }
    if (pane === 'workbench' && !detail) switchPane('all')
    else if (pane !== before.pane || pane === 'workbench') switchPane(pane)
    if (place) strip.selectKey(place)
    else strip.clear()
    if (!detail || sameDetail) return true
    if (pane === 'workbench' && detail.kind === 'matter') {
      await openWorkbenchTask(detail.id)
      return getViewedWorkbenchTaskId() === detail.id
    }
    return await rosterDock?.open(detail) === true
  }

  /** @type {{entry: ReturnType<typeof location>, focus: Element|null}|undefined} */
  let beforeSearch
  openDeskSearch = () => {
    if (!searching()) {
      beforeSearch = {entry: location(), focus: document.activeElement}
      switchPane('all')
    }
    document.getElementById('wb-search')?.focus()
  }
  async function closeSearch() {
    const destination = beforeSearch
    beforeSearch = undefined
    let restored = false
    try { restored = !!destination && await applyLocation(destination.entry) }
    catch { /* The item may have disappeared while search was open. */ }
    if (!restored) switchPane('converse')
    const focus = destination?.focus
    if (focus instanceof HTMLElement && focus.getClientRects().length) focus.focus({preventScroll: true})
  }

  /** @param {import('./modules/desk-history.js').Direction} direction */
  async function move(direction) {
    if (moving || !available() || !history.canMove(direction)) return
    moving = true
    const focus = document.activeElement
    try {
      await history.move(direction, async (entry, current) => {
        const { pane, place, detail, terminalPlace } = entry
        const searchTerminalEntry = pane === 'thing' && detail?.kind === 'terminal' && terminalPlace
        const hasPlace = () => searchTerminalEntry || !place || strip.places().some(p => p.key === place)
        if (!hasPlace()) return false
        const before = location()
        const sameDetail = detail?.kind === before.detail?.kind && detail?.id === before.detail?.id && pane === before.pane
        if (pane === 'thing' && detail && !searchTerminalEntry) {
          const next = strip.places().find(p => p.key === place)
          if (!next || !thingThread?.find(next,detail)) return false
        }
        if (pane !== 'thing' && detail && !sameDetail) {
          // Check existence before touching the currently displayed pane, selection or draft.
          try {
            if (detail.kind === 'matter') {
              const data = await v1(invokeWorkbenchApi, V1.matter.get, { query: { id: detail.id } })
              if (data.matter?.id !== detail.id) return false
              if (data.matter.kind === 'task') {
                const task = /** @type {{task?: {id:string}}} */ (
                  await v1(invokeWorkbenchApi, V1.workbench.task, { query: { id: detail.id } }))
                if (task.task?.id !== detail.id) return false
              }
            } else {
              const data = await v1(invokeWorkbenchApi, V1.cli.sessions, { query: { owner: 1, session_id: detail.id } })
              if (!data.sessions?.some((/** @type {{session_id:string}} */ session) => session.session_id === detail.id)) return false
            }
          } catch { return false }
        }
        if (!current() || !available()) return
        if (!hasPlace()) return false
        preserveNavigationFocus = true
        try {
          try {
            if (await applyLocation(entry)) return true
          } catch { /* The detail may disappear between validation and opening. */ }
          if (!current()) return
          await applyLocation(before).catch(() => {})
          return false
        } finally {
          preserveNavigationFocus = false
        }
      })
    } finally {
      moving = false
      if (focus instanceof HTMLElement && focus !== document.activeElement && focus.getClientRects().length
        && !focus.closest('[hidden], [inert]')) focus.focus({ preventScroll: true })
      reflect()
    }
  }
  for (const [button, direction] of buttons) {
    button.addEventListener('blur', () => {
      if (!history.canMove(direction)) {
        button.disabled = true
        button.removeAttribute('aria-disabled')
      }
    }, { signal })
    button.addEventListener('click', () => {
      if (!history.canMove(direction)) return
      button.focus({ preventScroll: true })
      void move(direction)
    }, { signal })
  }
  document.addEventListener('keydown', event => {
    if (!available()) return
    if (!event.defaultPrevented && !event.isComposing && event.keyCode !== 229) {
      const shortcut = !event.altKey && !event.shiftKey && event.metaKey === mac && event.ctrlKey === !mac
        && event.key.toLowerCase() === 'k'
      if (event.key === 'Escape' && searching() && deskSearch.composing) return
      if (shortcut || (event.key === 'Escape' && searching())) {
        event.preventDefault()
        if (!event.repeat) {
          if (searching()) { if (event.key !== 'Escape' || !deskSearch.clear()) void closeSearch() }
          else openDeskSearch?.()
        }
        return
      }
    }
    const direction = deskHistoryShortcut(event, mac)
    if (!direction) return
    event.preventDefault()
    void move(direction)
  }, { signal, capture: true })
  const sideButton = (/** @type {MouseEvent} */ event) => {
    if (event.button !== 3 && event.button !== 4) return
    if (!available()) return
    event.preventDefault()
    if (event.type === 'mouseup') void move(event.button === 3 ? -1 : 1)
  }
  document.addEventListener('mousedown', sideButton, { signal, capture: true })
  document.addEventListener('mouseup', sideButton, { signal, capture: true })
  document.addEventListener('auxclick', sideButton, { signal, capture: true })
  signal.addEventListener('abort', () => { recordDeskNavigation = openDeskSearch = undefined }, { once: true })
}

/** @param {ReturnType<typeof mountPlacesStrip>} strip */
function mountDeskLayout(strip) {
  const expandedRail = window.matchMedia(DESK_EXPANDED_RAIL_QUERY)
  const overlayRail = window.matchMedia(DESK_OVERLAY_RAIL_QUERY)
  const more = dashRail?.querySelector('.topbar-more')
  const scroll = document.getElementById('converse-scroll')
  const toggle = document.getElementById('desk-rail-toggle')
  const heading = document.querySelector('.desk-heading')
  if (!dashRail || !more || !scroll || !toggle || !heading) return
  const rail = dashRail
  const root = document.documentElement
  const hover = window.matchMedia('(hover: hover)')
  const listeners = new AbortController()
  const { signal } = listeners
  if (more instanceof HTMLDetailsElement) wireDeskDisclosure(more, signal)
  mountDeskHistory(strip, signal)
  const mac = root.dataset.platform === 'macos'
  const stopFullscreen = mac ? watchDeskFullscreen(
    /** @type {any} */ (window).__TAURI__?.window?.getCurrentWindow?.(),
    fullscreen => root.toggleAttribute('data-desk-fullscreen', fullscreen),
  ) : undefined
  if (stopFullscreen) signal.addEventListener('abort', stopFullscreen, { once: true })
  let collapsed = !expandedRail.matches || readDeskCollapsed(window)
  let peeking = false
  let pointerInTrigger = false
  let pointerInRail = false
  let waitForReentry = false
  let closeTimer = 0

  const renderCollapse = () => {
    const closed = collapsed
    const visible = !closed || peeking
    if (!visible) {
      if (rail.contains(document.activeElement)) toggle.focus({ preventScroll: true })
      strip.closeActions()
      rail.querySelector('.cc-home-details')?.removeAttribute('open')
      more?.removeAttribute('open')
    }
    root.toggleAttribute('data-desk-collapsed', closed)
    root.toggleAttribute('data-desk-peeking', closed && peeking)
    root.toggleAttribute('data-desk-overlay', overlayRail.matches)
    syncNotebookMail()
    toggle.setAttribute('aria-expanded', String(visible))
    const label = closed ? '展开左边' : '收起左边'
    toggle.setAttribute('aria-label', label)
    toggle.title = `${label} ${mac ? '⌘B' : 'Ctrl+B'}`
  }
  const cancelClose = () => {
    window.clearTimeout(closeTimer)
    closeTimer = 0
  }
  const dismissPeek = () => {
    cancelClose()
    if (!peeking) return
    peeking = false
    pointerInRail = false
    renderCollapse()
  }
  const scheduleClose = () => {
    if (!peeking || pointerInTrigger || pointerInRail || closeTimer) return
    closeTimer = window.setTimeout(() => {
      closeTimer = 0
      if (!rail.matches(':hover') && !rail.querySelector(':focus-visible')) dismissPeek()
    }, 300)
  }
  // Read the window edge without laying a hit target over the native drag strips.
  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !hover.matches || root.dataset.mode !== 'dashboard') return
    pointerInTrigger = toggle.contains(/** @type {Node} */ (event.target))
      || (event.clientX >= 0 && event.clientX < 8 && event.clientY >= heading.getBoundingClientRect().bottom)
    pointerInRail = peeking && rail.contains(/** @type {Node} */ (event.target))
    if (!pointerInTrigger) waitForReentry = false
    if (pointerInTrigger || pointerInRail) {
      cancelClose()
      if (collapsed && !peeking && !waitForReentry) {
        peeking = true
        renderCollapse()
      }
    } else scheduleClose()
  }, { signal })
  document.documentElement.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'mouse') return
    pointerInTrigger = pointerInRail = waitForReentry = false
    scheduleClose()
  }, { signal })
  rail.addEventListener('focusout', scheduleClose, { signal })
  hover.addEventListener('change', () => {
    if (!hover.matches) dismissPeek()
  }, { signal })

  const notebookScroll = document.querySelector('.notebook-scroll')
  const notebookEntries = document.getElementById('notebook-entries')
  const preserveReadingPosition = (/** @type {() => void} */ change) => {
    const focus = document.activeElement
    const inNotebook = !!notebookScroll?.getClientRects().length
    const activeThread = document.querySelector('#thing-thread:not([hidden]) .thing-terminal:not([hidden]) .thing-scroll')
    const scroller = inNotebook ? notebookScroll : activeThread ?? scroll
    const rows = inNotebook ? notebookEntries?.children : scroller.querySelectorAll(':scope > [data-converse-message]')
    const top = scroller.getBoundingClientRect().top
    const anchor = Array.from(rows ?? []).find(row => row.getBoundingClientRect().bottom > top)
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0
    // 这一页此刻正藏着(比如在一件事的页面里时,对话那一页不显示):量出来全是 0,会被当成「在底部」。它自己记着位置,这里不插手。
    const measurable = scroller.getClientRects().length > 0
    const atBottom = measurable && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
    // 左栏收展会改变行高，按消息编号保持阅读位置。
    const remembered = !inNotebook && measurable && !atBottom ? rememberConversationPosition(/** @type {HTMLElement} */ (scroller)) : null
    change()
    if (focus instanceof HTMLElement && focus !== document.activeElement && focus.isConnected && focus.getClientRects().length) {
      focus.focus({ preventScroll: true })
    }
    if (!measurable) return
    if (atBottom) scroller.scrollTop = scroller.scrollHeight
    else if (remembered) remembered()
    else if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
  }
  const renderRailState = (/** @type {boolean} */ next) => {
    cancelClose()
    peeking = pointerInRail = false
    waitForReentry = next && (pointerInTrigger || toggle.matches(':hover'))
    collapsed = next
    renderCollapse()
  }
  const setCollapsed = (/** @type {boolean} */ next) => {
    preserveReadingPosition(() => renderRailState(next))
    // Compact-window choices belong to this visit to the size range.
    if (expandedRail.matches) writeDeskCollapsed(window, next)
  }
  const onShortcut = (/** @type {KeyboardEvent} */ event) => {
    if (root.dataset.mode !== 'dashboard' || event.defaultPrevented) return
    if (event.key === 'Escape' && (peeking || (overlayRail.matches && !collapsed))
      && !event.isComposing && !document.querySelector('dialog[open]')) {
      event.preventDefault()
      if (collapsed) {
        waitForReentry = pointerInTrigger
        dismissPeek()
      } else setCollapsed(true)
    } else if (isDeskCollapseShortcut(event, mac)) {
      event.preventDefault()
      setCollapsed(!collapsed)
    }
  }
  toggle.addEventListener('click', () => {
    setCollapsed(!collapsed)
    toggle.focus({ preventScroll: true })
  }, { signal })
  document.addEventListener('click', event => {
    if (overlayRail.matches && !collapsed
      && event.composedPath().some(node => node instanceof Element && node.matches('.dash-main'))) {
      setCollapsed(true)
    }
  }, { signal })
  document.addEventListener('keydown', onShortcut, { signal })
  root.toggleAttribute('data-desk-compact', !expandedRail.matches)
  renderCollapse()
  reflectTopbarWaiting()
  expandedRail.addEventListener('change', () => preserveReadingPosition(() => {
    root.toggleAttribute('data-desk-compact', !expandedRail.matches)
    renderRailState(!expandedRail.matches)
  }), { signal })
  overlayRail.addEventListener('change', () => preserveReadingPosition(renderCollapse), { signal })
  window.addEventListener('pagehide', () => {
    listeners.abort()
    cancelClose()
  }, { once: true })
}

async function boot() {
  trackTopbarBottom()
  showDevBannerIfShim()
  mountHugeicons()
  wireDoctorSubscribers()
  wireEvents()
  startWorkbenchAttention()
  initConversePage(deps, { focus: false })
  wireDeskWake(async () => {
    await restartDaemon(deps)
    if (lastDaemon?.alive) await presencePoller.refresh()
  })
  const conversationRoot=document.getElementById('converse-root')
  if(conversationRoot){
    const search = () => openDeskSearch?.()
    document.getElementById('topbar-search')?.addEventListener('click',search)
    mountConversationTools({root:conversationRoot,
      delegate:()=>openConversationDelegation(deps),
      search,
      projects:openConversationProjects,
      history:async()=>{await terminalWaiting.refresh();return openComputerSessions(()=>terminalSessions,session=>addConversationTerminal(session),async()=>{try{const list=/** @type {import('./modules/workbench.js').ListResult} */(await v1(invokeWorkbenchApi,V1.workbench.list));mountHistoryDialog(invokeWorkbenchApi,list.historyProviders??[],openDeskTask,list.agentNames??{})}catch{showToast('暂时读不到电脑上的会话，请稍后再试')}})},
      navigate:navigateDeskPane})
    const topics=mountMemoryTopics({root:/** @type {HTMLElement} */(document.getElementById('memory-topics')),call:invokeWorkbenchApi,
      openMatter:id=>deps.onOpenMatter(id),
      locateMessage:id=>{navigateDeskPane('overview');return locateConversationMessage(id)},
      manage:()=>navigateDeskPane('memory')})
    memoryTopics=topics
    document.getElementById('topbar-cc')?.addEventListener('click',()=>{topics.close();document.getElementById('converse-input')?.focus()})
    window.addEventListener('pagehide',()=>topics.destroy(),{once:true})
  }
  const rosterAside=document.getElementById('roster-aside'),matterLayer=document.getElementById('conversation-matter-layer')
  if(rosterAside&&matterLayer)rosterDock=createRosterDock({aside:rosterAside,layer:matterLayer,call:invokeWorkbenchApi,wide:()=>window.innerWidth>=1080,
    openTask:async id=>{initWorkbenchPage(deps);await openWorkbenchTask(id)},
    onClose:()=>stopWorkbenchPolling(),onChange:setDockedMatter,onUserClose:()=>recordDeskNavigation?.(),
    onExpand:async item=>{
      rosterAside.removeAttribute('data-open')
      document.getElementById('topbar-roster')?.setAttribute('aria-expanded','false')
      let closed = false
      const close = () => {
        closed = true
        expandedDetail = null
        disposeExpandedDetail = undefined
        recordDeskNavigation?.()
      }
      const result = item.kind === 'terminal'
        ? await openConversationTerminal(invokeWorkbenchApi, item.id, close)
        : await openConversationWork(invokeWorkbenchApi, item.id, async id => {
          switchPane('workbench')
          await openWorkbenchTask(id)
          return getViewedWorkbenchTaskId() === id
        }, close)
      if (typeof result !== 'function') return result === true
      if (closed) return false
      expandedDetail = item
      disposeExpandedDetail = /** @type {() => void} */ (result)
      return true
    }})
  window.addEventListener('pagehide',()=>rosterDock?.destroy(),{once:true})
  const rosterRoot = document.getElementById('roster-list')
  if (rosterRoot) {
    const roster = mountRosterPane({root:rosterRoot,call:invokeWorkbenchApi,onOpen:item=>item.kind==='terminal'?deps.onOpenTerminal(item.id):deps.onOpenMatter(item.id),onItems:items=>{
      deskHero.setRoster(items)
      thingThread?.setRoster(items)
      const button=document.getElementById('topbar-roster');if(button)button.textContent=`在做 ${items.length}`
    }})
    window.addEventListener('pagehide',()=>roster.destroy(),{once:true})
  }
  // 左栏一个地方一行，点开进入这件事。
  const placesRoot=document.getElementById('places-root')
  if(placesRoot){
    const waitingRoot = document.getElementById('desk-waiting')
    const situation = document.getElementById('desk-cc-situation')
    const homeButton = document.getElementById('topbar-cc')
    const strip=mountPlacesStrip({root:placesRoot,call:invokeWorkbenchApi,waitingRoot:waitingRoot ?? undefined,
      onPlaceMap: enabled => thingThread?.setPlaceMap(enabled),
      onCurrent: place => {
        homeButton?.toggleAttribute('data-place-selected', !!place)
        reflectTopbarWaiting()
      },
      onSituation: (text, stale) => {
        if (!situation) return
        situation.textContent = text
        situation.toggleAttribute('data-stale', stale)
        renderRail()
      },
      onSelect:place=>{
        if (!place) {
          if (document.body.dataset.pane === 'thing') switchPane('overview')
          return
        }
        if (document.body.dataset.pane !== 'thing') { rosterDock?.close(); switchPane('thing') }
        thingThread?.open(place)
      },
      onOpen:target=>target.kind==='terminal'?deps.onOpenTerminal(target.id):deps.onOpenMatter(target.id),
      // 左栏和收起按钮共用 CC 的等待计数。
      onPlaces:places=>{
        updateConversationPlaces(places)
        const current = places.find(place=>place.key === deskPlaces?.selected())
        if (current && document.body.dataset.pane === 'thing') thingThread?.open(current)
        const count = places.reduce((sum,p)=>sum+(p.waiting?.count??0),0)
        const cc = document.getElementById('topbar-cc')
        if (!cc) return
        if (count) cc.dataset.waiting = String(count)
        else delete cc.dataset.waiting
        reflectTopbarWaiting()
      }})
    deskPlaces = strip
    strip.setTerminalWaitingRows(terminalWaitingRows)
    const threadRoot = document.getElementById('thing-thread')
    if (threadRoot && matterLayer instanceof HTMLElement) {
      const original = document.createComment('工作台详情原位')
      matterLayer.before(original)
      thingThread = mountThingThread({root:threadRoot,call:invokeWorkbenchApi,focusEnabled:!mock,
        openTask:async (id,host)=>{
          rosterDock?.close()
          host.append(matterLayer)
          matterLayer.setAttribute('role','region')
          matterLayer.removeAttribute('aria-modal')
          matterLayer.dataset.workbenchView = 'detail'
          matterLayer.hidden = false
          setWorkbenchDocked(true)
          initWorkbenchPage(deps)
          await openWorkbenchTask(id)
        },
        closeTask:()=>{
          if (!matterLayer.closest('.thing-detail')) return
          stopWorkbenchPolling()
          setWorkbenchDocked(false)
          matterLayer.hidden = true
          matterLayer.setAttribute('role','dialog')
          matterLayer.setAttribute('aria-modal','true')
          original.after(matterLayer)
        },
        home:()=>{strip.clear();switchPane('converse');recordDeskNavigation?.()},
        onLabWrite:()=>void strip.refreshAfterWrite(),
        onSession:()=>recordDeskNavigation?.(),
        onWaiting:value=>strip.setInlineWaiting(value),
      })
      window.addEventListener('pagehide',()=>thingThread?.destroy(),{once:true})
    }
    connectConversationPlaces({selectKey:key=>{strip.selectKey(key);recordDeskNavigation?.()}})
    mountDeskLayout(strip)
    homeButton?.addEventListener('click', () => {
      strip.clear()
      recordDeskNavigation?.()
    })
    placesRoot.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('.place-row')) recordDeskNavigation?.()
    })
    window.addEventListener('pagehide',()=>strip.destroy(),{once:true})
  }
  document.getElementById('topbar-roster')?.addEventListener('click',()=>{
    const aside=document.getElementById('roster-aside'),button=document.getElementById('topbar-roster')
    const open=aside?.toggleAttribute('data-open');button?.setAttribute('aria-expanded',String(!!open))
    if (open) button?.closest('details')?.removeAttribute('open')
  })
  startAppUpdateChecks()
  // Refresh an already-configured local WeChat archive on every desktop
  // launch. Keep it off the critical render path: decrypting larger archives
  // can take seconds, while the dashboard should remain immediately usable.
  void refreshWxvaultOnAppStart({ invoke })
    .then(result => {
      // Log the skip reason too. A silent no-op here means 待办 / knowledge
      // read a stale archive, and "not-ready"/"disabled" is indistinguishable
      // from success unless we say so.
      if (result.refreshed) console.info('[wxvault] startup refresh complete')
      else console.info(`[wxvault] startup refresh skipped: ${result.reason}`)
    })
    .catch(err => console.warn('[wxvault] startup refresh failed:', err))
  const tauriEvent = /** @type {any} */ (window).__TAURI__?.event
  const connectNavigation = tauriEvent?.listen ? createNativeNavigation({
    navigation: mainNavigation,
    listen: (name, callback) => tauriEvent.listen(name, callback),
    takePending: () => invoke("take_pending_navigate", {}),
    onError: err => console.warn("navigate listener failed", err),
  }) : null
  await connectNavigation?.()
  // Retry a failed listener without acknowledging or discarding native targets.
  window.addEventListener('focus', () => { void connectNavigation?.() })
  await loadAgentConfig().catch(err => console.error("agent config load failed", err))
  void connectNavigation?.()
  // Wire after the native entry listener, so provider loading cannot lose it.
  initA2AAgentsTab().catch(err => console.error("a2a-agents init failed", err))
  initPluginsTab({ invoke }).catch(err => console.error("plugins init failed", err))
  initLicense().catch(err => console.error("license init failed", err))
  let report = await doctorPoller.refresh()
  if (!report) {
    setMode("wizard")
    showStep("doctor")
    return
  }
  const switchedProvider = await ensureUsableProviderSelected(report)
  if (switchedProvider) report = await doctorPoller.refresh() ?? report
  const decision = initialMode(report)
  if (decision.mode === "wizard" && decision.step) showStep(decision.step)
  setMode(decision.mode)
}

boot()

// A detail layer owns keyboard input until it closes; drafts remain in their original scopes.
window.addEventListener('keydown',event=>{
  const layer=/** @type {HTMLElement|null} */(document.querySelector('.workbench-pane:not([hidden])'))
  if(!layer||layer.closest('.thing-detail')||(layer.dataset.workbenchView === 'search')||event.defaultPrevented||document.querySelector('dialog[open]'))return
  if(event.key==='Escape'){
    event.preventDefault()
    if (rosterDock?.item()) {
      rosterDock.close()
      recordDeskNavigation?.()
    } else navigateDeskPane('overview')
    return
  }
  if(event.key==='Tab'){
    const controls=[...layer.querySelectorAll('button,input,textarea,select,summary,[tabindex="0"]')].filter(el=>!el.hasAttribute('disabled')&&el.getClientRects().length)
    const first=/** @type {HTMLElement|undefined} */(controls[0]),last=/** @type {HTMLElement|undefined} */(controls.at(-1))
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }
})

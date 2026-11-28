// @ts-check
// terminal-waiting.js — 「此刻」的「N 件事等你」里也列出终端里等批准的 Claude Code / Codex(2026-10-14)。
//
// 不另开一页:终端会话登记处(GET /v1/cli/sessions,admin,走原生宿主的 operator 凭据)里 status=waiting 的
// 那几条,接在工作台的等你行后面。中继在微信里开了码(主人不在、问到了微信 / 手机)⇒ 行上给「看清楚 ›」,
// 点开小窗看清命令再「允许 / 拒绝」,拍板走桌宠权限卡同一条路(pet_permission_resolve → POST /v1/permissions/resolve);
// 没开码(主人在电脑前,终端自己在问)⇒ 只写「回终端处理」,不给按钮。
// 桌面上只写「项目」,哪家画成行尾的圆头像(2026-10-19,同手机 app;名字进读屏标签和小窗):
// 「终端」和微信回话用的码是微信那头的东西,桌面用不上(2026-10-16)。
import { escapeHtml } from '../view.js'
import { V1, v1 } from '../daemon-client.js'
import { permissionTextSegments, permissionCwd, PermissionDisplaySchema, permissionDisplay, permissionOperationSource, permissionToolAction, permissionWaitingTitle } from '../generated/permission-display.js'

/** @typedef {{session_id:string,code:string,source:string,displayName?:string,unhooked?:true,status:string,project:string,cwd?:string,machine?:string|null,terminal?:object,can_focus?:true,pending:{tool:string,summary:string|null,since:number,hash?:string|null,display?:unknown,cwd?:unknown,truncated?:boolean,showSnapshotNotice?:boolean,hasScriptPreview?:boolean}|null}} CliSession */
/** @typedef {import('./permission-operation.js').TerminalOperation} TerminalOperation */
/** @typedef {{id:string,title:string,detail:string,agent:string,source:string,hash:string|null,canFocus?:true} & TerminalOperation} TerminalRow */

const TITLE_MAX = 120
const SUMMARY_LIMIT = 200

// 原始工具名 → 一句人话的动词。认不出的工具照实写「想用 X」,不猜。
/** @type {Record<string,string>} */
const VERB = {
  Bash: '想运行', shell: '想运行', exec_command: '想运行', local_shell: '想运行', run_terminal_cmd: '想运行',
  Edit: '想改', MultiEdit: '想改', apply_patch: '想改', Write: '想写',
}

/** 行标题:「Bash: npm publish」⇒「想运行 npm publish」。 @param {string} tool @param {string} summary @param {string} source @param {TerminalOperation['display']} [display] */
export function terminalTitle(tool, summary, source, display) {
  if (permissionToolAction(tool, 'zh-Hans')) return permissionWaitingTitle(display, tool, summary, 'zh-Hans')
  const verb = Object.hasOwn(VERB, tool) ? VERB[tool] : undefined
  if (tool && summary) return oneLine(verb ? `${verb} ${summary}` : `想用 ${tool}：${summary}`)
  if (tool) return oneLine(`想用 ${tool}`)
  if (summary) return oneLine(summary)
  return `${source} 要你批准`
}


/** @param {string} s */
const oneLine = s => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1)}…` }

/**
 * 旧版摘要和结构化内容各有自己的截断标记。执行目录只取本次请求里的核实值。
 * @param {Pick<CliSession,'project'|'cwd'> & {pending:NonNullable<CliSession['pending']>}} session
 * @returns {TerminalOperation & {titleSummary:string}}
 */
export function terminalPendingOperation({ pending, cwd }) {
  const tool = pending.tool === 'permission' ? '' : String(pending.tool ?? '')
  const summary = String(pending.summary ?? '')
  const titleSummary = permissionTextSegments(summary).map(part => part.text).join('').trim()
  const structured = /** @type {TerminalOperation['display']} */ (PermissionDisplaySchema.safeParse(pending.display).data)
  const summaryTruncated = pending.truncated ?? (summary.length >= SUMMARY_LIMIT || /(?:…|\.\.\.)\s*$/.test(summary))
  const display = structured ?? (titleSummary ? { ...permissionDisplay(tool, summary), ...(summaryTruncated ? { truncated: true } : {}) } : undefined)
  return {
    tool, titleSummary, display, summaryTruncated, summaryOnly: !structured && !!display,
    ...(structured && !structured.truncated ? { raw: permissionOperationSource(structured) }
      : summary && !summaryTruncated ? { summary } : {}),
    // 项目目录只写真的路径:会话没报目录时,项目名不是目录,也不能拿来当相对路径的起点。
    cwd: permissionCwd(pending.cwd), projectPath: permissionCwd(cwd),
    ...(typeof pending.showSnapshotNotice === 'boolean' ? { showSnapshotNotice: pending.showSnapshotNotice } : {}),
    ...(typeof pending.hasScriptPreview === 'boolean' ? { hasScriptPreview: pending.hasScriptPreview } : {}),
  }
}

/**
 * 只要等批准的那几条;别的状态(在跑 / 做完了)不是「等你」。
 * @param {unknown} sessions @returns {TerminalRow[]}
 */
export function terminalWaitingRows(sessions) {
  if (!Array.isArray(sessions)) return []
  /** @type {TerminalRow[]} */ const rows = []
  for (const raw of sessions) {
    const s = /** @type {CliSession} */ (raw)
    if (!s || s.unhooked || s.status !== 'waiting' || typeof s.session_id !== 'string' || !s.pending) continue
    const { titleSummary, ...operation } = terminalPendingOperation({ ...s, pending: s.pending })
    // 没写 source 的是老 daemon(那时只有 Claude);写了个不认识的 ⇒ 照它的名字画首字母,别冒充 Claude。
    const said = typeof s.source === 'string' ? s.source.trim() : ''
    const agent = said || 'claude'
    // 叫什么由 daemon 定(收敛清单 ⑥,行里的 displayName);老 daemon 不带 ⇒ 照 id 写。
    const source = typeof s.displayName === 'string' && s.displayName ? s.displayName : agent
    const hash = typeof s.pending.hash === 'string' && /^[a-z0-9]{5}$/.test(s.pending.hash) ? s.pending.hash : null
    const detail = String(s.project ?? '')
    rows.push({
      id: s.session_id,
      title: terminalTitle(operation.tool, titleSummary, source, operation.summaryOnly ? undefined : operation.display),
      detail, agent, source,
      hash, ...operation,
      ...(canFocusTerminal(s) ? { canFocus: true } : {}),
    })
  }
  return rows
}

/**
 * 轮询终端会话登记处。读不到 ⇒ 发空列表(不留上一拍的行冒充现在;工作台那份 attention 管「暂时不知道」)。
 * onSessions:整份会话(在跑 / 歇着的也在),给主页的「在做」「带回来的」(设计稿 2026-10-31 U4);同样只在变化时通知。
 * @param {{call:(method:'GET',path:string)=>Promise<unknown>,onChange:(rows:TerminalRow[])=>void,onSessions?:(sessions:CliSession[])=>void,intervalMs?:number,includeUnhooked?:boolean}} o
 */
export function createTerminalWaitingPoller({ call, onChange, onSessions, intervalMs = 10_000, includeUnhooked = false }) {
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null
  let stopped = true, ticket = 0
  let last = '[]', lastSessions = '[]'
  /** @param {TerminalRow[]} rows */
  function publish(rows) {
    const key = JSON.stringify(rows)
    if (key === last) return
    last = key
    onChange(rows)
  }
  async function refresh() {
    const mine = ++ticket
    /** @type {TerminalRow[]} */ let rows = []
    /** @type {CliSession[]} */ let sessions = []
    try {
      const r = /** @type {{sessions?:unknown}} */ (await v1(call, V1.cli.sessions, { query: { limit: 20, ...(includeUnhooked ? { unhooked: '1' } : {}) } }))
      rows = terminalWaitingRows(r?.sessions)
      sessions = Array.isArray(r?.sessions) ? /** @type {CliSession[]} */ (r.sessions.filter(x => x && typeof x.session_id === 'string')) : []
    } catch { rows = []; sessions = [] }
    if (mine !== ticket) return
    publish(rows)
    const key = JSON.stringify(sessions)
    if (onSessions && key !== lastSessions) { lastSessions = key; onSessions(sessions) }
  }
  function loop() {
    if (stopped) return
    timer = setTimeout(async () => { await refresh(); loop() }, intervalMs)
  }
  return {
    refresh,
    start() { if (!stopped) return; stopped = false; void refresh().then(loop) },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null } },
  }
}

/** @param {{terminal?:object,can_focus?:true}|null|undefined} session */
export function canFocusTerminal(session) {
  return !!session?.terminal && session.can_focus === true
}

/** @param {string} sessionId */
export function terminalFocusHtml(sessionId) {
  return `<span class="terminal-focus"><button type="button" class="desk-text-button" data-terminal-focus="${escapeHtml(sessionId)}">到终端</button> <small role="status"></small></span>`
}

/** @param {HTMLButtonElement} button @param {(method:any,path:string,body?:any)=>Promise<any>} call */
export async function focusTerminalFromButton(button, call) {
  const sessionId = button.dataset.terminalFocus
  const status = button.parentElement?.querySelector('[role="status"]')
  if (!sessionId || !status || button.disabled) return
  button.disabled = true
  status.textContent = '正在找终端…'
  try {
    const result = await v1(call, V1.cli.focus, { body: { session_id: sessionId } })
    if (result?.reason === 'automation_denied') {
      status.textContent = '请在系统设置的「自动化」里允许 CC 控制终端'
    } else if (result?.reason === 'other_machine') {
      status.textContent = '这次会话在另一台电脑上'
    } else if (result?.reason === 'not_found' || result?.method === 'none') {
      status.textContent = '找不到那个窗口了'
    } else {
      status.textContent = result?.ok ? '' : '暂时打不开终端，请重试'
    }
  } catch {
    status.textContent = '暂时打不开终端，请重试'
  } finally {
    button.disabled = false
  }
}

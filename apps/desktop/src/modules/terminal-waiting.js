// @ts-check
// terminal-waiting.js — 「此刻」的「N 件事等你」里也列出终端里等批准的 Claude Code / Codex(2026-10-14)。
//
// 不另开一页:终端会话登记处(GET /v1/cli/sessions,admin,走原生宿主的 operator 凭据)里 status=waiting 的
// 那几条,接在工作台的等你行后面。中继在微信里开了码(主人不在、问到了微信 / 手机)⇒ 行上给「看清楚 ›」,
// 点开小窗看清命令再「允许 / 拒绝」,拍板走桌宠权限卡同一条路(pet_permission_resolve → POST /v1/permissions/resolve);
// 没开码(主人在电脑前,终端自己在问)⇒ 只写「回终端处理」,不给按钮。
// 桌面上只写「项目」,哪家画成行尾的圆头像(2026-10-19,同手机 app;名字进读屏标签和小窗):
// 「终端」和微信回话用的码是微信那头的东西,桌面用不上(2026-10-16)。
import { V1, v1 } from '../daemon-client.js'

/** @typedef {{session_id:string,code:string,source:string,displayName?:string,status:string,project:string,machine?:string|null,pending:{tool:string,summary:string|null,since:number,hash?:string|null}|null}} CliSession */
/** @typedef {{id:string,title:string,detail:string,agent:string,source:string,hash:string|null,tool:string,command:string,commandLabel?:string}} TerminalRow */

const TITLE_MAX = 120

// 原始工具名 → 一句人话的动词。认不出的工具照实写「想用 X」,不猜。
/** @type {Record<string,string>} */
const VERB = {
  Bash: '想运行', shell: '想运行', exec_command: '想运行', local_shell: '想运行', run_terminal_cmd: '想运行',
  Edit: '想改', MultiEdit: '想改', NotebookEdit: '想改', apply_patch: '想改', Write: '想写',
  Read: '想读', WebFetch: '想打开', WebSearch: '想搜',
}

/** 行标题:「Bash: npm publish」⇒「想运行 npm publish」。 @param {string} tool @param {string} summary @param {string} source */
export function terminalTitle(tool, summary, source) {
  const verb = VERB[tool]
  if (tool && summary) return oneLine(verb ? `${verb} ${summary}` : `想用 ${tool}：${summary}`)
  if (tool) return oneLine(`想用 ${tool}`)
  if (summary) return oneLine(summary)
  return `${source} 要你批准`
}


/** @param {string} s */
const oneLine = s => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1)}…` }

/**
 * 只要等批准的那几条;别的状态(在跑 / 做完了)不是「等你」。
 * @param {unknown} sessions @returns {TerminalRow[]}
 */
export function terminalWaitingRows(sessions) {
  if (!Array.isArray(sessions)) return []
  /** @type {TerminalRow[]} */ const rows = []
  for (const raw of sessions) {
    const s = /** @type {CliSession} */ (raw)
    if (!s || s.status !== 'waiting' || typeof s.session_id !== 'string' || !s.pending) continue
    const tool = s.pending.tool === 'permission' ? '' : String(s.pending.tool ?? '')
    const summary = String(s.pending.summary ?? '').trim()
    // 没写 source 的是老 daemon(那时只有 Claude);写了个不认识的 ⇒ 照它的名字画首字母,别冒充 Claude。
    const said = typeof s.source === 'string' ? s.source.trim() : ''
    const agent = said || 'claude'
    // 叫什么由 daemon 定(收敛清单 ⑥,行里的 displayName);老 daemon 不带 ⇒ 照 id 写。
    const source = typeof s.displayName === 'string' && s.displayName ? s.displayName : agent
    const hash = typeof s.pending.hash === 'string' && /^[a-z0-9]{5}$/.test(s.pending.hash) ? s.pending.hash : null
    rows.push({
      id: s.session_id,
      title: terminalTitle(tool, summary, source),
      detail: String(s.project ?? ''), agent, source,
      hash, tool, command: summary,
      commandLabel: VERB[tool] === '想运行' ? '要运行的命令' : tool ? `${tool} 要做的是` : '具体内容',
    })
  }
  return rows
}

/**
 * 轮询终端会话登记处。读不到 ⇒ 发空列表(不留上一拍的行冒充现在;工作台那份 attention 管「暂时不知道」)。
 * @param {{call:(method:'GET',path:string)=>Promise<unknown>,onChange:(rows:TerminalRow[])=>void,intervalMs?:number}} o
 */
export function createTerminalWaitingPoller({ call, onChange, intervalMs = 10_000 }) {
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null
  let stopped = true, ticket = 0
  let last = '[]'
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
    try {
      const r = /** @type {{sessions?:unknown}} */ (await v1(call, V1.cli.sessions, { query: { limit: 20 } }))
      rows = terminalWaitingRows(r?.sessions)
    } catch { rows = [] }
    if (mine !== ticket) return
    publish(rows)
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

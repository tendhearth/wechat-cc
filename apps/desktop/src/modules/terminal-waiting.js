// @ts-check
// terminal-waiting.js — 「此刻」的「N 件事等你」里也列出终端里等批准的 Claude Code / Codex(2026-10-14)。
//
// 不另开一页:终端会话登记处(GET /v1/cli/sessions,admin,走原生宿主的 operator 凭据)里 status=waiting 的
// 那几条,接在工作台的等你行后面。中继在微信里开了码(主人不在、问到了微信 / 手机)⇒ 行上给「允许 / 拒绝」,
// 拍板走桌宠权限卡同一条路(pet_permission_resolve → POST /v1/permissions/resolve);没开码(主人在电脑前,
// 终端自己在问)⇒ 只写「回终端处理」,不给按钮。

/** @typedef {{session_id:string,code:string,source:'claude'|'codex'|'cursor',status:string,project:string,machine?:string|null,pending:{tool:string,summary:string|null,since:number,hash?:string|null}|null}} CliSession */
/** @typedef {{id:string,title:string,detail:string,hash:string|null}} TerminalRow */

const TITLE_MAX = 120

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
    const what = [tool, s.pending.summary ?? ''].filter(Boolean).join(': ')
    const source = s.source === 'codex' ? 'Codex' : s.source === 'cursor' ? 'Cursor' : 'Claude Code'
    const hash = typeof s.pending.hash === 'string' && /^[a-z0-9]{5}$/.test(s.pending.hash) ? s.pending.hash : null
    rows.push({
      id: s.session_id,
      title: what ? oneLine(what) : `${source} 要你批准`,
      detail: [s.project, `终端 · ${source}`, `码 ${s.code}`, hash ? '' : '回终端处理'].filter(Boolean).join(' · '),
      hash,
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
      const r = /** @type {{sessions?:unknown}} */ (await call('GET', '/v1/cli/sessions?limit=20'))
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

/**
 * 工作台 / 审阅区的错误码:一个码一行,写清它在每个表面的 HTTP 状态与主人看到的那句话(架构审查 2026-10-20 第 1 条)。
 *
 * - desktop:桌面路由 /v1/workbench/*(src/features/workbench/routes.ts);[状态, 对外的码] ⇒ 对外换一个码。
 * - desktopEntry:交办入口那几条路由的状态,只在和 desktop 不同时写。
 * - phone:手机 /m/api/*(daemon mobile-workbench);同上。
 * - 不写某个表面 ⇒ 那个表面没声明这个码,按 FALLBACK 的前缀规则走(大多落到 500)。
 * - entry:交办被拒的码,桌面 task-entry-contract.js 另有一份(桌面 JS 引不到这里),守卫核对两份一致。
 * - rewind:回退那一组,桌面回包带上 service 挂在 Error 上的 reason / detail 等。
 * - wechat:微信回复(features/workbench/wechat-control failure());wechatWorktree:微信独立工作区四个动作被拒时那句。{id} = 任务编号。
 *
 * 桌面与 App 的文案不在这里:桌面按场景各有一张表(同一个码在撤回 / 回退 / 脚本里说法不同),App 先映射成自己的 BackendCode 再走 i18n;
 * 两边都由守卫核对「认的码都在这张表里」。码只当字符串传(协议前向兼容,不做 enum)。
 */
export type WorkbenchErrorOut = number | readonly [status: number, as: string]
export interface WorkbenchErrorSpec {
  readonly desktop?: WorkbenchErrorOut
  readonly desktopEntry?: number
  readonly phone?: WorkbenchErrorOut
  readonly entry?: true
  readonly rewind?: true
  readonly wechat?: string
  readonly wechatWorktree?: string
}
export type WorkbenchErrorSurface = 'desktop' | 'phone'

export const WORKBENCH_ERRORS: Readonly<Record<string, WorkbenchErrorSpec>> = Object.freeze({
  // ── 交办入口:与 apps/desktop/src/shared/task-entry-contract.js 的 rejections 同码同状态(那份是桌面 / 网页判「确实被拒」用的,桌面 JS 引不到这里 ⇒ scripts/workbench-errors.guard.test.ts 核对)
  api_task_attachment_invalid: {desktop: 400, phone: 400, entry: true},
  api_task_attachment_unsupported: {desktop: 422, phone: 422, entry: true},
  api_task_input_invalid: {desktop: 400, phone: 400, entry: true},
  attachment_changed: {desktop: 409, phone: 409, entry: true},
  entry_expired: {desktop: 410, phone: 410, entry: true},
  invalid_attachment: {desktop: 400, phone: 400, entry: true},
  invalid_context: {desktop: 400, phone: 400, entry: true},
  invalid_entry: {desktop: 400, phone: 400, entry: true},
  invalid_execution: {desktop: 400, phone: 400, entry: true},
  invalid_path: {desktop: 400, phone: 400, entry: true},
  invalid_provider: {desktop: 400, phone: 400, entry: true},
  invalid_request_id: {desktop: 400, phone: 400, entry: true},
  invalid_target: {desktop: 400, phone: 400, entry: true},
  invalid_text: {desktop: 400, phone: 400, entry: true},
  invalid_title: {desktop: 400, phone: 400, entry: true},
  invalid_until: {desktop: 400, phone: 400, entry: true},
  project_stale: {desktop: 409, phone: 409, entry: true, wechat: '这个项目编号已失效或目录已变化，没有开始工作。请发送「任务 项目」重新选择。'},
  unattended_ack_required: {desktop: 428, desktopEntry: 422, phone: 422, entry: true, wechat: 'agy 是免审执行者：跑任务时看不到、拦不下单步操作，没有权限卡和提问，只能停止；它用的工具凭据不是按任务隔离的；时间线只有文字；不能带附件、不能选模型。请先在桌面工作台确认一次，之后微信也能直接用。没有开始工作。'},
  until_requires_worktree: {desktop: 422, phone: 422, entry: true},
  until_unattended_unsupported: {desktop: 422, phone: 422, entry: true},
  workbench_attachments_unsupported: {desktop: 422, phone: 422, entry: true, wechat: '这个执行者暂不支持工作任务附件，没有开始工作。请移除附件，或改用支持附件的执行者。'},
  workbench_execution_unsupported: {desktop: 422, phone: 422, entry: true, wechat: '这个执行者暂不支持所选执行设置，没有开始工作。请改为自动设置，或选择其他执行者。'},
  // ── 回退(2026-10-21):rewind ⇒ 桌面回包带 reason / detail / backupRef / path(s) / rolledBack
  review_round_discarded: {desktop: 409, phone: 409, rewind: true},
  rewind_confirmation_required: {desktop: 409, phone: 409, rewind: true},
  rewind_confirmation_stale: {desktop: 409, phone: 409, rewind: true},
  rewind_failed: {desktop: 502, phone: 502, rewind: true},
  rewind_ignored_conflict: {desktop: 409, phone: 409, rewind: true},
  rewind_merged: {desktop: 409, phone: 409, rewind: true},
  rewind_needs_owner: {desktop: 409, phone: 409, rewind: true},
  rewind_noop: {desktop: 422, phone: 422, rewind: true},
  rewind_not_blocked: {desktop: 409, rewind: true},
  rewind_not_latest: {phone: 409},
  rewind_shared_folder: {desktop: 409, phone: 409, rewind: true},
  rewind_unavailable: {desktop: 422, phone: 422, rewind: true},
  rewind_undo_stale: {desktop: 409, rewind: true},
  rewind_undo_unavailable: {desktop: 409, rewind: true},
  // ── 改动审阅 / 行评论 / 按块撤回
  invalid_review_reference: {desktop: 400},
  review_comment_conflict: {desktop: 409, phone: 409},
  review_comment_limit: {desktop: 409, phone: 409},
  review_comment_not_found: {desktop: 404, phone: 404},
  review_comment_sent: {desktop: 409, phone: 409},
  review_file_changed: {desktop: 409},
  review_file_unmarkable: {desktop: 400},
  review_hunk_stale: {desktop: 409, phone: 409},
  review_revert_unavailable: {desktop: 422},
  // ── 独立工作区(2026-10-07);wechatWorktree = 微信「任务 <编号> 提交 / 合回 / 删除工作区 / 重开工作区」被拒时那句
  not_worktree: {desktop: 422, phone: 422, wechatWorktree: '这件事不在独立工作区里，没有可提交、合回或删除的分支。'},
  project_busy: {desktop: 409, phone: 409, wechatWorktree: '项目目录里还有别的任务在跑，等它收工再合回。'},
  project_detached: {desktop: 409, phone: 409, wechatWorktree: '项目目录现在不在任何分支上，请在电脑上自己合并。'},
  project_dirty: {desktop: 409, phone: 409, wechatWorktree: '项目目录里有没提交的改动，CC 不替你合并。请处理那些改动，或在电脑上自己合并。'},
  worktree_project_missing: {desktop: 409, phone: 409},
  worktree_base_missing: {desktop: 422, phone: 422, wechat: '项目里没有这个分支，没有开始工作。请核对分支名（本地分支），或去掉 @<分支> 从最新提交开始。'},
  worktree_branch_exists: {desktop: 409, phone: 409},
  worktree_branch_missing: {desktop: 409, phone: 409, wechatWorktree: '分支已经不在项目里了，没法重开。请重新交办一件。'},
  worktree_conflict: {desktop: 409, phone: 409, wechatWorktree: '原来的工作区位置被占了，没法重开。请在桌面上看看。'},
  worktree_dirty: {desktop: 409, phone: 409, wechatWorktree: '独立工作区里还有没提交的改动，先发「任务 {id} 提交」再删除。'},
  worktree_git_failed: {desktop: 502, phone: 502, wechatWorktree: 'git 操作没成功，请在电脑上看看这个项目的状态。'},
  worktree_not_ff: {desktop: 409, phone: 409, wechatWorktree: '项目在这之后又有了新提交，不能直接快进。请在电脑上自己合并（可能要处理冲突）。'},
  worktree_not_git: {desktop: 422, phone: 422, wechat: '这个项目不是 Git 仓库，开不了独立工作区。去掉「独立」就能照常交办。'},
  worktree_open: {desktop: 409, phone: 409, wechatWorktree: '独立工作区还开着，不用重开。'},
  worktree_removed: {desktop: 409, phone: 409, wechat: '这件事的独立工作区已经删除了（分支还在项目里）。要接着做，先发「任务 {id} 重开工作区」。', wechatWorktree: '这件事的独立工作区已经删除了，分支还在项目里。要接着做：任务 {id} 重开工作区'},
  worktree_uncommitted: {desktop: 409, phone: 409, wechatWorktree: '独立工作区里还有没提交的改动，先发「任务 {id} 提交」再合回。'},
  // ── 工作区脚本(2026-10-20):批准只在电脑上 ⇒ 手机拿到 script_needs_computer
  no_scripts: {desktop: 422, phone: 422},
  script_approval_required: {desktop: 428, phone: [428, 'script_needs_computer']},
  script_config_changed: {desktop: 409},
  script_running: {desktop: 409, phone: 409},
  script_setup_running: {desktop: 409, phone: 409},
  // ── 附件 / 分块上传
  attachment_conflict: {desktop: 409, phone: 409},
  attachment_in_use: {desktop: 409, phone: 409},
  attachment_limit: {desktop: 413, phone: 413},
  attachment_platform_unsupported: {desktop: 422},
  attachment_scope: {desktop: [404, 'not_found'], phone: 409},
  attachment_storage_limit: {desktop: 413, phone: 413},
  invalid_attachment_size: {desktop: 413, phone: 413},
  request_body_too_large: {desktop: 413},
  upload_changed: {phone: 409},
  upload_conflict: {phone: 409},
  upload_discarded: {desktop: 410, phone: 410},
  upload_expired: {desktop: 410, phone: 410},
  upload_invalid_content: {phone: 400},
  upload_limit: {phone: 413},
  upload_not_found: {phone: 404},
  upload_offset: {phone: 409},
  upload_unfinished_limit: {phone: 413},
  // ── 续接 / 交接 / 原生会话 / 额度接手
  external_close_confirmation_required: {desktop: 409, phone: 409, wechat: '请先在桌面工作台确认原执行程序已关闭，再继续这项任务。'},
  external_close_confirmation_stale: {desktop: 409, phone: 409},
  handoff_artifact_unsupported: {desktop: 422},
  handoff_changed: {desktop: 409},
  native_folder_busy: {desktop: 409, phone: 409},
  native_history_changed: {desktop: 409, phone: 409},
  native_history_empty: {desktop: 409, phone: 409},
  native_history_unavailable: {desktop: 503},
  native_history_unsupported: {desktop: 422},
  native_import_too_large: {desktop: 400},
  native_session_already_managed: {desktop: 409},
  native_session_busy: {desktop: 409, phone: 409},
  native_session_identity_mismatch: {desktop: 409},
  // 桌面以前回 500 internal,「另做一份」那句额度人话出不来(#465 盘点时发现)
  provider_quota_exhausted: {desktop: 503, phone: 503},
  quota_handoff_changed: {desktop: 409, phone: 409},
  quota_handoff_not_needed: {desktop: 409, phone: 409},
  quota_handoff_unavailable: {desktop: 503, phone: 503},
  restart_confirmation_required: {desktop: 409, phone: 409, wechat: '原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'},
  restart_confirmation_stale: {desktop: 409, phone: 409, wechat: '原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'},
  workbench_resume_unsupported: {desktop: 422, wechat: '这个执行者无法安全恢复原会话，没有继续工作。请在桌面查看恢复说明，并决定是否带记录重新开始。'},
  // ── 执行者 / 模型 / 托管工作区 / 没接上
  creation_conflict: {desktop: 409, phone: 409, wechat: '这条消息的内容与已记录的新建要求不一致，未再次创建。请发送一条新消息。'},
  entry_not_wired: {desktop: 503, phone: 503},
  input_storage_unavailable: {desktop: 503, phone: [503, 'unavailable']},
  invalid_entry_owner: {desktop: 403, phone: 403},
  invalid_managed_workspace: {desktop: 503, phone: 503},
  managed_workspace_changed: {desktop: 409, phone: 409},
  managed_workspace_unavailable: {desktop: 503, phone: 503},
  model_catalog_invalid: {desktop: 503},
  model_catalog_unavailable: {desktop: 503},
  network_unprotected: {desktop: 503, phone: 503},
  unattended_ack_unavailable: {desktop: 503},
  unavailable_provider: {desktop: 422, phone: 503, wechat: '暂时没有可用的工作执行者，没有开始工作。请在桌面连接或管理一个支持工作任务的执行者。'},
  workbench_stopping: {desktop: 503, phone: 503},
  // 工作台没接上(开机途中 / 上游没起来 / 测试里不挂):桌面带原码(桌面 JS 与 daemon 同一个包;架构终态 A5 起由模块门统一回 503
  // workbench_not_wired,见 routes.ts 的 MODULE_UNAVAILABLE_CODE —— 以前是桌面路由里 44 处字面量),
  // 手机**有意**收成 503 unavailable —— 和 FALLBACK「手机 *_not_wired ⇒ 503 unavailable」、input_storage_unavailable 同一个口径:
  // 子系统叫什么不给手机,App 只认 unavailable 这一个「电脑那边还没准备好」。换成带原码要 App 先认得它,
  // 而装着的旧版 App 不能强制升级:它会把 workbench_not_wired 落成 unknown(说一句 / 停下就成了「不确定送到没有」)。
  // 2026-10-21 架构复查:这里写明是有意的差异,不再只靠兜底规则。
  workbench_not_wired: {desktop: 503, phone: [503, 'unavailable']},
  // 模块门(第三批 3b,daemon internal-api 的路由层统一回,routes.ts 表里的 module 字段):主人关的 ⇒ module_off;开着却没起来 ⇒
  // module_degraded(带 detail)。手机老 App 不认这两个码 ⇒ 同 workbench_not_wired 收成 unavailable;桌面认原码(wishes / people / a2a-agents)。
  module_off: {desktop: 503, phone: [503, 'unavailable']},
  module_degraded: {desktop: 503, phone: [503, 'unavailable']},
  // 模块开着、只是处理器还没挂上来(开机途中,架构终态 A3):稍后再试,不是关了也不是坏了。
  module_starting: {desktop: 503, phone: [503, 'unavailable']},
  // 配置文件写不进去(第三批 3e,lib/json-file):旧文件读不出来就拒写,不拿 {} 覆盖;刚被别处改过两次就让你稍后再试。
  // daemon internal-api 统一回 409(index.ts 的路由 catch),带 detail(哪个文件、为什么)。
  config_unreadable: {desktop: 409},
  config_busy: {desktop: 409},
  // 记忆编辑(2026-10-23,设计稿 memory-edits-stick;记忆功能 src/features/memory/routes.ts 的 POST /v1/memory/view|edit,桌面经 CLI `memory view|edit --json`)。
  // 前四个是业务上的拒绝:HTTP 200 + { ok: false, code },磁盘一个字节没动,所以表里写 200(不是失败的 HTTP 状态)。
  //   memory_changed:view 之后文件或 owner.md 被改过 ⇒ 重新 view、让主人再改一次;memory_edit_stale_key:回来的键不是这次 view 给的 ⇒ 同上;
  //   memory_edit_bulk:更正超过 5 条 ⇒ 带 { count, deleted, rewritten },问主人后带 confirmBulk 重发;memory_edit_too_large:带 limit。
  memory_changed: {desktop: 200},
  memory_edit_stale_key: {desktop: 200},
  memory_edit_bulk: {desktop: 200},
  memory_edit_too_large: {desktop: 200},
  // 还没有主人(没绑微信)⇒ 409;daemon 内部出错 ⇒ 500,不带原文。
  memory_no_owner: {desktop: 409},
  memory_edit_failed: {desktop: 500},
  // 收回的话(架构终态 G6,主人 10-26 第 2 / 3 条):要恢复的那一条不在(已经恢复过 / 编号不对)⇒ 404。
  memory_retraction_not_found: {desktop: 404, phone: 404},
  // ── 补充 / 提问 / 权限 / 轮次
  artifact_changed: {desktop: 409, phone: 409, wechat: '成果文件已变化或未通过校验，没有发送。请在桌面查看保存的版本。'},
  execution_conflict: {desktop: 409},
  input_conflict: {desktop: 409, phone: 409, wechat: '这条消息的内容与已记录的补充不一致，未再次发送。请重新查询任务。'},
  input_delivery_busy: {desktop: 409, phone: 409, wechat: '仍有补充等待交付，请稍后再试。'},
  input_limit: {desktop: 409, wechat: '仍有补充等待交付，请稍后再试。'},
  input_stale: {desktop: 409, phone: 409, wechat: '任务轮次已变化或正在停止，这条补充没有发送。请重新查询任务后再提交。'},
  invalid_answer: {desktop: 400, wechat: '答案格式或选项不正确，尚未提交。请按问题中的示例回答。'},
  invalid_question: {desktop: 400},
  invalid_state: {desktop: 409},
  matter_not_found: {desktop: 404, phone: 404},
  matter_say_unsupported: {phone: 400},
  matter_task_required: {phone: 400},
  not_found: {desktop: 404, phone: [404, 'matter_not_found']},
  permission_stale: {desktop: 409, phone: 409, wechat: '这条请求已失效或不属于这个任务。请重新查询任务，使用当前请求编号。'},
  question_stale: {desktop: 409, phone: 409, wechat: '这条请求已失效或不属于这个任务。请重新查询任务，使用当前请求编号。'},
  reply_sink_busy: {phone: 409},
  workbench_archived: {desktop: 409, phone: 409, wechat: '这项任务已归档。请在桌面工作台恢复任务后再继续。', wechatWorktree: '这项任务已归档，请先在桌面恢复任务。'},
  workbench_busy: {desktop: 409, phone: 409, wechat: '任务轮次已变化或正在停止，这条补充没有发送。请重新查询任务后再提交。', wechatWorktree: '这个工作区还有会话开着，先「停止」或等它收工再操作。'},
  writer_alive: {desktop: 409},
  // ── CC 代主人对终端会话说一句(terminal_say,2026-10-24;features/terminal/routes.ts 的 /v1/cli/say,调用方只有 CC 的 MCP 工具)。
  // 业务上的拒绝回 409 + detail(登记处里的原状态,工具照实转给模型,不说成「它忙」);一句都没送出去。
  terminal_say_not_owner: {desktop: 403},
  terminal_say_not_wired: {desktop: 503},
  terminal_say_unknown_session: {desktop: 404},
  terminal_say_ticket_unknown: {desktop: 404},
  terminal_say_remote: {desktop: 409},
  terminal_say_ended: {desktop: 409},
  terminal_say_turn_open: {desktop: 409},
  terminal_say_pending: {desktop: 409},
  // ── 输出评测(2026-10-29,features/output-eval/routes.ts 的 POST /v1/eval/run,调用方只有 `wechat-cc eval run`)。
  // 跑了没跑好(超时、模型报错)是 200 + ok:false;下面是请求本身不成立:字段不对(带 detail)/ 执行者没注册 / 没有便宜模型可打分。
  eval_invalid_request: {desktop: 400},
  eval_unknown_provider: {desktop: 404},
  eval_no_cheap_model: {desktop: 503},
  // ── 只在微信(features/workbench/wechat-control)
  artifact_delivery_conflict: {wechat: '这条文件请求与已记录的内容不一致，没有再次发送。请重新查看任务成果。'},
  artifact_transport_unavailable: {wechat: '文件发送暂不可用，已保存的成果仍可在桌面工作台查看。'},
  control_conflict: {wechat: '这条消息的内容与已记录的操作不一致，未再次执行。请重新查询任务。'},
  control_stale: {wechat: '原请求对应的轮次已结束，未停止当前轮次。请重新查询任务。'},
  invalid_wechat_identity: {wechat: '无法确认这条微信消息的账号和发送者，没有创建任务。请在原聊天重新发送。'},
  // GitHub issue 开工不给免审执行者;createTask 抛,桌面交办 / 续做理论上也会走到 ⇒ 两端也带码(#466 评审)
  issue_unattended_unsupported: {desktop: 422, phone: 422, wechat: '从 GitHub issue 开工的任务不交给免审执行者:issue 是外面的人写的,免审时又没人看着单步操作。换一位执行者再发,比如「任务 新建 <项目编号> 用 @claude issue <编号>」。没有开始工作。'},
  subscription_conflict: {wechat: '提醒绑定的账号已变化，没有把旧提醒转发到新账号。请在原聊天关闭提醒后重新设置。'},
})

/** 表里查一个码;原型链上的键(constructor 之类)不算。 */
export function workbenchErrorSpec(code: string): WorkbenchErrorSpec | undefined {
  return Object.hasOwn(WORKBENCH_ERRORS, code) ? WORKBENCH_ERRORS[code] : undefined
}

/** 表里没声明这个表面时的兜底:桌面 execution_*_(unsupported|unknown) / invalid_* ⇒ 400,其余 500 internal;手机 *_not_wired ⇒ 503 unavailable,invalid_* ⇒ 400,其余 500 unavailable。 */
function fallback(code: string, surface: WorkbenchErrorSurface): {status: number; error: string} {
  if (surface === 'desktop') {
    if (/^execution_.+_(unsupported|unknown)$/.test(code) || code.startsWith('invalid_')) return {status: 400, error: code}
    return {status: 500, error: 'internal'}
  }
  if (code.endsWith('_not_wired')) return {status: 503, error: 'unavailable'}
  if (code.startsWith('invalid_')) return {status: 400, error: code}
  return {status: 500, error: 'unavailable'}
}

/** 一个码在这个表面回什么:状态 + 对外的码。entry = 桌面交办入口路由。 */
export function workbenchErrorHttp(code: string, surface: WorkbenchErrorSurface, entry = false): {status: number; error: string} {
  const spec = workbenchErrorSpec(code)
  const out = surface === 'desktop' ? (entry && spec?.desktopEntry !== undefined ? spec.desktopEntry : spec?.desktop) : spec?.phone
  if (out === undefined) return fallback(code, surface)
  return typeof out === 'number' ? {status: out, error: code} : {status: out[0], error: out[1]}
}

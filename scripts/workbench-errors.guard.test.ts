/**
 * 工作台错误码一张表(packages/protocol/src/workbench-errors.ts)的守卫。
 *
 * daemon 的桌面路由 / 手机路由 / 微信回复直接读那张表,不用守。这里守的是引不到它的两处:
 * - 桌面 task-entry-contract.js 的 rejections(桌面 / 网页判「确实被拒」用):码与状态必须和表里 entry 那几行一致;
 * - 桌面 modules/workbench*.js 里按场景写的「码 → 人话」表与 match(/\b(a|b)\b/):认的每个码都得是桌面路由真会回的码
 *   (表里声明了桌面状态,或落在 invalid_* / execution_*_(unsupported|unknown) 这类前缀规则上),
 *   要么是任务记录里的失败码(core executionFailureMessage 认得的,不走 HTTP)。daemon 改名 / 删码 ⇒ 这里红。
 * App 那半在 apps/app/src/net/errors.test.ts。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { WORKBENCH_ERRORS, workbenchErrorHttp } from '../packages/protocol/src/workbench-errors'
import { entryErrorStatus } from '../apps/desktop/src/shared/task-entry-contract.js'
import { executionFailureMessage } from '../src/core/workbench/execution-settings'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = join(ROOT, 'apps', 'desktop', 'src', 'modules')
const CODE = /^[a-z]+(_[a-z]+)+$/
// 任务记录里的失败码,core executionFailureMessage 没收(桌面单独有一句)
const TASK_ONLY = new Set(['writer_not_closed'])

describe('WORKBENCH_ERRORS 自身', () => {
  it('每行至少在一个表面出现;desktopEntry 只给交办码;rewind 一定有桌面状态', () => {
    for (const [code, spec] of Object.entries(WORKBENCH_ERRORS)) {
      expect(code, code).toMatch(CODE)
      expect(spec.desktop ?? spec.phone ?? spec.wechat ?? spec.wechatWorktree, code).toBeDefined()
      if (spec.desktopEntry !== undefined) expect(spec.entry, code).toBe(true)
      if (spec.rewind) expect(spec.desktop, code).toBeDefined()
    }
  })
})

describe('桌面 task-entry-contract.js 与表一致', () => {
  const contract = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'shared', 'task-entry-contract.js'), 'utf8')
  const codes = [...contract.matchAll(/^\s+([a-z_]+):\{status:/gm)].map(m => m[1]!)
  it('码一样多', () => {
    expect(codes.length).toBeGreaterThan(10)
    expect(codes.sort()).toEqual(Object.keys(WORKBENCH_ERRORS).filter(c => WORKBENCH_ERRORS[c]!.entry).sort())
  })
  it.each(codes)('%s 的状态:交办入口 / 手机都和 contract 一样', code => {
    expect(workbenchErrorHttp(code, 'desktop', true).status).toBe(entryErrorStatus(code))
    expect(workbenchErrorHttp(code, 'phone').status).toBe(entryErrorStatus(code))
  })
})

/** 一个桌面模块里认的码:全是字符串值、键全是码的对象字面量(≥2 个键),加 match(/\b(a|b|c)\b/) 里的候选。 */
function desktopCodes(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n) && n.properties.length >= 2) {
      const keys = n.properties.map(p => ts.isPropertyAssignment(p) && (ts.isStringLiteralLike(p.initializer) || ts.isIdentifier(p.initializer)) ? p.name.getText().replace(/^'|'$/g, '') : null)
      if (keys.every(k => k !== null && CODE.test(k))) out.push(...keys as string[])
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const m of src.matchAll(/\\b\(([a-z_|]+)\)\\b/g)) out.push(...m[1]!.split('|').filter(c => CODE.test(c)))
  return [...new Set(out)]
}

describe('桌面 modules/workbench*.js 认的码都还在', () => {
  const files = readdirSync(MODULES).filter(f => /^workbench.*\.js$/.test(f))
  const known = (code: string) => {
    const spec = Object.hasOwn(WORKBENCH_ERRORS, code) ? WORKBENCH_ERRORS[code]! : undefined
    if (spec?.desktop !== undefined) return true
    if (workbenchErrorHttp(code, 'desktop').status < 500) return true
    return executionFailureMessage(code) !== code || TASK_ONLY.has(code)
  }
  it('扫到了这些表(LINE_ERRORS、回退、脚本、执行设置、交接…)', () => {
    expect(files.flatMap(f => desktopCodes(join(MODULES, f))).length).toBeGreaterThan(60)
  })
  it.each(files)('%s', file => {
    expect(desktopCodes(join(MODULES, file)).filter(c => !known(c)), file).toEqual([])
  })
})

describe('桌面路由里直接写死的 {status, body:{error}} 与表一致(10-21:workbench_not_wired 字面量 503、表里却落到 500 internal)', () => {
  const src = readFileSync(join(ROOT, 'src', 'daemon', 'internal-api', 'routes-workbench.ts'), 'utf8')
  const literals = [...src.matchAll(/status\s*:\s*(\d{3})\s*,\s*body\s*:\s*\{\s*error\s*:\s*'([a-z_]+)'\s*\}/g)].map(m => ({ status: Number(m[1]), code: m[2]! }))
  it('扫到了(workbench_not_wired 那 40 多处在里面)', () => {
    expect(literals.filter(l => l.code === 'workbench_not_wired').length).toBeGreaterThan(30)
  })
  it.each([...new Map(literals.map(l => [`${l.status} ${l.code}`, l])).values()])('$status $code', ({ status, code }) => {
    expect(workbenchErrorHttp(code, 'desktop')).toEqual({ status, error: code })
  })
})

describe('workbench_not_wired:桌面带码、手机有意收成 unavailable(表里明写,不靠兜底)', () => {
  it('两个表面各回什么', () => {
    expect(WORKBENCH_ERRORS.workbench_not_wired).toBeDefined()
    expect(workbenchErrorHttp('workbench_not_wired', 'desktop')).toEqual({ status: 503, error: 'workbench_not_wired' })
    expect(workbenchErrorHttp('workbench_not_wired', 'phone')).toEqual({ status: 503, error: 'unavailable' })
  })
})

describe('桌面路由能回的、桌面 UI 在等的码(#465 盘点发现)', () => {
  it('额度用完 / 文件夹正被占着 ⇒ 桌面带码回,不再是 500 internal', async () => {
    const { workbenchErrorHttp } = await import('../packages/protocol/src/workbench-errors')
    expect(workbenchErrorHttp('provider_quota_exhausted', 'desktop')).toEqual({ status: 503, error: 'provider_quota_exhausted' })
    expect(workbenchErrorHttp('native_folder_busy', 'desktop')).toEqual({ status: 409, error: 'native_folder_busy' })
  })
})

/**
 * 反向:工作台 core 里抛出的每个码(Error('码') 与 fail('码') 这类 helper;模板 / 变量拼出来的扫不到),要么桌面路由认得(表里有桌面状态 / 落在前缀规则上),要么明列在这里 =「不走桌面 HTTP 的内部码」
 * (执行者运行时、任务失败记录、只有手机 / 微信才走的路)。没归类的新码会静默变成 500 internal ——
 * provider_quota_exhausted 就是这么丢的(#465 评审)。表里补上了的、或者已经不再抛的,从这里删掉。
 */
const INTERNAL_ONLY = new Set([
    // api-task 执行者运行时:落进任务失败记录,不走桌面 HTTP
    'api_task_private_scope', 'api_task_scope_invalid', 'api_task_scope_changed', 'api_task_output_limit', 'api_task_incomplete',
    'api_task_response_invalid', 'permission_denied', 'api_task_step_limit', 'api_task_closed', 'api_task_busy',
    'api_artifact_exists_or_invalid_path', 'api_file_not_text', 'api_file_operation_failed', 'api_messages_too_large', 'api_model_aborted',
    'api_model_stream_already_consumed', 'api_model_stream_incomplete', 'api_project_changed', 'api_session_binding', 'api_session_conflict',
    'api_task_cancelled', 'api_task_close_unconfirmed', 'artifact_delivery_conflict', 'artifact_delivery_not_found', 'artifact_delivery_scope',
    'artifact_delivery_stale', 'artifact_transport_unavailable', 'attachment_data_missing', 'attachment_image_unsupported', 'close_timeout',
    'codex_child_message_limit', 'codex_empty_input', 'codex_events_already_consumed', 'codex_input_id_conflict', 'codex_input_limit',
    'codex_invalid_rpc_response', 'codex_missing_thread_id', 'codex_missing_turn_id', 'codex_no_active_turn', 'codex_process_not_exited',
    'codex_resume_thread_mismatch', 'codex_runtime_already_started', 'codex_runtime_record_limit', 'codex_runtime_requires_lifetime_stream',
    'codex_session_closed', 'codex_steer_no_longer_active', 'codex_steer_turn_mismatch', 'codex_terminal_cleanup_unverified',
    'codex_turn_already_running', 'codex_turn_cancelled', 'codex_turn_start_mismatch', 'codex_unverified_thread_cwd',
    'codex_unverified_thread_policy', 'control_conflict', 'control_stale', 'diff_limit', 'entry_already_accepted', 'entry_matter_link_failed',
    'entry_not_accepted', 'input_not_delivered', 'matters_not_wired', 'missing_finish_reason',
    'notification_conflict', 'question_limit', 'review_cancelled', 'review_deadline', 'review_size_limit', 'rewind_backup_exists',
    'rewind_git_failed', 'rewind_verify_tree', 'runtime_closed_before_input_acknowledgement', 'session_start_timeout', 'subscription_conflict',
    'subscription_inactive', 'subscription_mismatch', 'turn_timeout', 'unsupported_api_tool', 'upload_conflict', 'upload_invalid_content',
    'upload_not_found', 'upload_unfinished_limit',
])
describe('工作台抛出的码都归了类(反向守卫)', () => {
  it('every Error(\'code\') literal under src/core/workbench and the executor adapters is desktop-mapped or listed INTERNAL_ONLY; the list has no stale entries', async () => {
    const { workbenchErrorHttp } = await import('../packages/protocol/src/workbench-errors')
    const { join } = await import('node:path')
    const { statSync } = await import('node:fs')
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.includes('.test.')) files.push(p) } }
    walk('src/core/workbench')
    // 原来在 core/workbench 下、架构终态 E2 搬进 src/adapters/executors 的那些(codex app-server、api-task、原生历史 ……):
    // 它们抛出的码同样经工作台的路由出去,照旧扫。别的适配器(对话侧、claude-workbench-*)原来就不在这一扫里 ——
    // 那是另一件事(没归类的码),记在稿子的 E 阶段,不在搬家这一步改。
    for (const f of ['openai/api-files', 'openai/api-model', 'openai/api-sessions', 'openai/api-task-provider', 'claude/claude-model-catalog',
      'claude/claude-native-config', 'claude/native-claude-history', 'codex/codex-activity', 'codex/codex-app-server', 'codex/codex-config',
      'codex/codex-execution-error', 'codex/codex-history-rpc', 'codex/codex-mcp-approval', 'codex/codex-model-catalog', 'codex/codex-runtime',
      'codex/native-codex-history']) files.push(join('src/adapters/executors', `${f}.ts`))
    const thrown = new Set<string>()
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/(?:Error|\bfail)\(\s*['"`]([a-z][a-z0-9_]+)['"`]\s*[,)]/g)) thrown.add(m[1]!)
    const unmapped = [...thrown].filter(c => workbenchErrorHttp(c, 'desktop').error === 'internal')
    expect(unmapped.filter(c => !INTERNAL_ONLY.has(c)), '新抛的码:在 workbench-errors 里给桌面状态,或者确实不走桌面 HTTP 就列进 INTERNAL_ONLY').toEqual([])
    expect([...INTERNAL_ONLY].filter(c => !unmapped.includes(c)), '已经归了类或不再抛,从 INTERNAL_ONLY 删掉').toEqual([])
  })
})

describe('记忆编辑回的 code 字面量都在表里(10-23:原来的扫描只认 Error(…) / {error:…},漏了 { ok:false, code:… })', () => {
  const files = ['src/daemon/internal-api/routes-memory.ts', 'src/daemon/memory/nightly-runtime.ts', 'src/lib/memory-edit.ts']
  const codes = [...new Set(files.flatMap(f => [...readFileSync(join(ROOT, f), 'utf8').matchAll(/'(memory_(?:changed|no_owner|edit_[a-z_]+))'/g)].map(m => m[1]!)))]
  // 记忆编辑这一族:memory_changed / memory_no_owner / memory_edit_*(别的 memory_* 是老路由的 error 字段,不归这张表)
  it('扫到了', () => { expect(codes.sort()).toEqual(['memory_changed', 'memory_edit_bulk', 'memory_edit_failed', 'memory_edit_stale_key', 'memory_edit_too_large', 'memory_no_owner']) })
  it.each(codes)('%s', code => { expect(WORKBENCH_ERRORS[code]?.desktop, code).toBeDefined() })
})

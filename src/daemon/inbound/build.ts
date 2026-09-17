import type { PipelineRun } from './types'
import { compose } from './compose'
import { makeMwTrace, type TraceMwDeps } from './mw-trace'
import { makeMwIdentity, type IdentityMwDeps } from './mw-identity'
import { makeMwAccess, type AccessMwDeps } from './mw-access'
import { makeMwDedup, type DedupMwDeps } from './mw-dedup'
import { makeMwCaptureCtx, type CaptureCtxMwDeps } from './mw-capture-ctx'
import { makeMwTyping, type TypingMwDeps } from './mw-typing'
import { makeMwAdmin, type AdminMwDeps } from './mw-admin'
import { makeMwMode, type ModeMwDeps } from './mw-mode'
import { makeMwOnboarding, type OnboardingMwDeps } from './mw-onboarding'
import { makeMwPermissionReply, type PermissionReplyMwDeps } from './mw-permission-reply'
import { makeMwCliReply, type CliReplyMwDeps } from './mw-cli-reply'
import { makeMwGuard, type GuardMwDeps } from './mw-guard'
import { makeMwAttachments, type AttachmentsMwDeps } from './mw-attachments'
import { makeMwTranscribeVoice, type TranscribeVoiceMwDeps } from './mw-transcribe-voice'
import { makeMwMessages, type MessagesMwDeps } from './mw-messages'
import { makeMwActivity, type ActivityMwDeps } from './mw-activity'
import { makeMwMilestone, type MilestoneMwDeps } from './mw-milestone'
import { makeMwWelcome, type WelcomeMwDeps } from './mw-welcome'
import { makeMwRecall, type RecallMwDeps } from './mw-recall'
import { makeMwLlmHealth, type MwLlmHealthDeps } from './mw-llm-health'
import { makeMwDispatch, type DispatchMwDeps } from './mw-dispatch'
import {makeMwWorkbench,type WorkbenchMwDeps} from './mw-workbench'
import { makeMwTaskReference, type TaskReferenceMwDeps } from './mw-task-reference'
import { makeMwMatter, type MatterMwDeps } from './mw-matter'
import { makeMwRoute, type RouteMwDeps } from './mw-route'

export interface InboundPipelineDeps {
  trace: TraceMwDeps
  identity: IdentityMwDeps
  access: AccessMwDeps
  dedup: DedupMwDeps
  capture: CaptureCtxMwDeps
  workbench?:WorkbenchMwDeps
  /** 管家式指称:主人用自然语言说某件事 ⇒ 落定到活跃任务再走 workbench 命令;缺席 ⇒ 不挂。 */
  taskReference?: TaskReferenceMwDeps
  /** 每个进门的 chat 登记成一条「一件事」;只登记不改逻辑。 */
  matter?: MatterMwDeps
  /** 意图路由(intent.ts):闸门之后、消费者之前算一次;第一步只记不改。 */
  route?: RouteMwDeps
  typing: TypingMwDeps
  admin: AdminMwDeps
  mode: ModeMwDeps
  onboarding: OnboardingMwDeps
  permissionReply: PermissionReplyMwDeps
  /** 「看 码」「@码 文本」;缺席 ⇒ 不挂(测试 / 最小嵌入)。 */
  cliReply?: CliReplyMwDeps
  guard: GuardMwDeps
  attachments: AttachmentsMwDeps
  transcribeVoice: TranscribeVoiceMwDeps
  messages: MessagesMwDeps
  activity: ActivityMwDeps
  milestone: MilestoneMwDeps
  welcome: WelcomeMwDeps
  recall: RecallMwDeps
  llmHealth: MwLlmHealthDeps
  dispatch: DispatchMwDeps
}

export function buildInboundPipeline(d: InboundPipelineDeps): PipelineRun {
  // 管家的探针要和它的中间件共用同一份状态(焦点 / 待选 / 接管),所以在这里建一次、两头用。
  const taskReference = d.taskReference ? makeMwTaskReference(d.taskReference) : null
  const route = d.route ? makeMwRoute({ ...d.route, probes: { ...d.route.probes, ...(taskReference ? { 'task-reference': taskReference.probe } : {}) } }) : null
  return compose([
    makeMwTrace(d.trace),
    makeMwIdentity(d.identity),
    // Access gate runs immediately after identity (so chatId is normalized
    // and the trace records the drop) and BEFORE typing/admin/onboarding/
    // welcome — non-allowlisted senders must not trigger any downstream
    // side effects (no typing indicator, no welcome leak, no API tokens).
    makeMwAccess(d.access),
    // Dedup runs immediately after access (only allow-listed senders are
    // tracked) and BEFORE every side-effecting middleware below, so its
    // `await next()` wraps the whole turn: a redelivered message that was
    // already answered is short-circuited here, while one whose first turn
    // crashed is left unmarked and reprocessed. See mw-dedup for the macOS
    // sleep/wake re-reply bug this guards against.
    makeMwDedup(d.dedup),
    ...(d.matter?[makeMwMatter(d.matter)]:[]),
    makeMwMessages(d.messages),
    makeMwCaptureCtx(d.capture),
    // Explicit local task controls need sender authorization and reply context,
    // but must not enter companion memory, permission selection or LLM health.
    ...(route?[route]:[]),
    ...(d.workbench?[makeMwWorkbench(d.workbench)]:[]),
    makeMwTyping(d.typing),
    makeMwAdmin(d.admin),
    makeMwMode(d.mode),
    makeMwOnboarding(d.onboarding),
    // Guard runs BEFORE permission-reply: when the network is down we want
    // the "🛑 出口 IP" notice to surface, not a silent forwarding of a
    // `y/n abc12` approval into an in-flight tool call that probably needs
    // the network we just lost.
    makeMwGuard(d.guard),
    makeMwPermissionReply(d.permissionReply),
    ...(d.cliReply ? [makeMwCliReply(d.cliReply)] : []),
    makeMwAttachments(d.attachments),
    makeMwTranscribeVoice(d.transcribeVoice),
    makeMwActivity(d.activity),
    makeMwMilestone(d.milestone),
    makeMwWelcome(d.welcome),
    // 管家指称在 transcribe-voice 之后(语音先转文字)、recall 之前(被它消费的
    // 消息不付嵌入成本);落不定就 next(),普通聊天照旧。
    ...(taskReference ? [taskReference] : []),
    // Recall runs after every consuming middleware (only messages that will
    // reach dispatch pay the embed cost) and BEFORE llm-health/dispatch so
    // the <recall> element is on ctx.msg when dispatch formats the envelope.
    makeMwRecall(d.recall),
    // LLM health gate runs immediately BEFORE dispatch (the terminal
    // middleware where the LLM turn actually happens) — degraded LLM means
    // every inbound would otherwise drive one doomed API call per message
    // (unlike the wechat side: inbound still arrives fine when the LLM is
    // down, so this is where "hammering a failing API" actually happens).
    makeMwLlmHealth(d.llmHealth),
    makeMwDispatch(d.dispatch),
  ])
}

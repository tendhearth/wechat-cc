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
import { makeMwGuard, type GuardMwDeps } from './mw-guard'
import { makeMwAttachments, type AttachmentsMwDeps } from './mw-attachments'
import { makeMwTranscribeVoice, type TranscribeVoiceMwDeps } from './mw-transcribe-voice'
import { makeMwMessages, type MessagesMwDeps } from './mw-messages'
import { makeMwActivity, type ActivityMwDeps } from './mw-activity'
import { makeMwMilestone, type MilestoneMwDeps } from './mw-milestone'
import { makeMwWelcome, type WelcomeMwDeps } from './mw-welcome'
import { makeMwDispatch, type DispatchMwDeps } from './mw-dispatch'

export interface InboundPipelineDeps {
  trace: TraceMwDeps
  identity: IdentityMwDeps
  access: AccessMwDeps
  dedup: DedupMwDeps
  capture: CaptureCtxMwDeps
  typing: TypingMwDeps
  admin: AdminMwDeps
  mode: ModeMwDeps
  onboarding: OnboardingMwDeps
  permissionReply: PermissionReplyMwDeps
  guard: GuardMwDeps
  attachments: AttachmentsMwDeps
  transcribeVoice: TranscribeVoiceMwDeps
  messages: MessagesMwDeps
  activity: ActivityMwDeps
  milestone: MilestoneMwDeps
  welcome: WelcomeMwDeps
  dispatch: DispatchMwDeps
}

export function buildInboundPipeline(d: InboundPipelineDeps): PipelineRun {
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
    makeMwMessages(d.messages),
    makeMwCaptureCtx(d.capture),
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
    makeMwAttachments(d.attachments),
    makeMwTranscribeVoice(d.transcribeVoice),
    makeMwActivity(d.activity),
    makeMwMilestone(d.milestone),
    makeMwWelcome(d.welcome),
    makeMwDispatch(d.dispatch),
  ])
}

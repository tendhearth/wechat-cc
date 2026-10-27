/**
 * 终端会话接进 daemon 的那一份(模块清单在 index.ts):它要的从地基 / 上游模块里填。只有 daemon-modules.ts import 这个文件。
 */
import { pick } from '../../lib/pick'
import type { DaemonModule } from '../../daemon/modules/container'
import type { Foundation } from '../../daemon/foundation'
import type { Bootstrap } from '../../daemon/bootstrap'
import type { WiredDeps } from '../../daemon/wiring'
import type { GuardRuntime } from '../../daemon/guard/runtime'
import { isOwnerOf } from '../../daemon/owner-chat'
import { summarizeJobs } from '../../adapters/store/scheduled-jobs-store'
import { WECHAT_PORTS as W, type WechatLinkStatus, type WechatPages, type WechatPermissions, type WechatSend } from '../../ports/wechat'
import type { WorkbenchService } from '../workbench'
import { terminalFeature, type TerminalFeature } from './index'

export function terminalModule(f: Foundation): DaemonModule<TerminalFeature> {
  const { stateDir, dangerously, db } = f
  return terminalFeature({
    needs: ['bootstrap', W.send, W.pages, W.link, W.permissions, 'network-gate'],
    lazy: ['workbench', 'wired'],
    deps: (ctx) => {
      const wired = ctx.late<WiredDeps>('wired')
      const workbench = ctx.late<WorkbenchService>('workbench')
      const wxSend = ctx.get<WechatSend>(W.send)
      const wxPages = ctx.get<WechatPages>(W.pages)
      const wxLink = ctx.get<WechatLinkStatus>(W.link)
      const wxPerm = ctx.get<WechatPermissions>(W.permissions)
      return {
        speech: () => wired()?.speech ?? null,
        stateDir, dangerously, db, projects: f.projects, own: (n, s) => ctx.own(n, s),
        ilink: {
          ...pick(wxSend, 'sendMessage'), ...pick(wxPages, 'sharePage'), ...pick(wxLink, 'proactiveClosedSince'),
          ...pick(wxPerm, 'askUser', 'registerPendingPermission', 'sweepPendingPermissions', 'pendingPermissionCodeOf'),
        },
        boot: ctx.get<Bootstrap>('bootstrap'), networkGate: ctx.get<GuardRuntime>('network-gate').gate,
        workbench: () => workbench(),
        appPush: () => wired()?.appPush ?? null,
        jobsSince: (since) => summarizeJobs(f.jobsStore, since),
        isOwner: isOwnerOf(stateDir),
        resolvePermission: (h, d) => { const ok = wxPerm.resolvePermission(h, d); if (ok) f.petSignals.noteContact(); return ok },
      }
    },
  })
}

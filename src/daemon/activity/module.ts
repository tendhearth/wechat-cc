/**
 * 「CC 做过的事」接进 daemon 的那一份:手机时间线 / 微信「做过的事」/ 周报共用一组来源。只有模块表 daemon-modules.ts 引这个文件。
 */
import type { TerminalFeature } from '../../features/terminal'
import { WECHAT_PORTS as W, type WechatSend } from '../../ports/wechat'
import type { DaemonModule } from '../modules/container'
import type { Foundation } from '../foundation'
import { wireActivity, type Activity } from '../bootstrap/wire-activity'

export function activityModule(f: Foundation): DaemonModule<Activity> {
  const { stateDir, db } = f
  return {
    name: 'activity',
    needs: ['terminal', W.send],
    init(ctx): Activity {
      const cli = ctx.get<TerminalFeature>('terminal')
      return wireActivity({ stateDir, db, ilink: ctx.get<WechatSend>(W.send), permissionDecisions: cli.permissionDecisions, cliEvents: cli.cliEvents, jobsStore: f.jobsStore })
    },
  } satisfies DaemonModule<Activity>
}

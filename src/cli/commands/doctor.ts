// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { analyzeDoctor, defaultDoctorDeps, printDoctor, probeFsAccessWarning, probeOutboundWarning, setupStatus } from '../doctor'
import { DoctorOutput, SetupStatusOutput } from '../schema'
export const doctorCmd = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose install/setup state' },
  args: {
    json: { type: 'boolean', description: 'machine-readable output' },
  },
  async run({ args }) {
    const report = analyzeDoctor(defaultDoctorDeps())
    if (args.json) console.log(JSON.stringify(DoctorOutput.parse(report), null, 2))
    else {
      printDoctor(report)
      const warn = await probeOutboundWarning(report.checks.daemon)
      if (warn) console.log(warn)
      const fsWarn = await probeFsAccessWarning(report.checks.daemon)
      if (fsWarn) console.log(fsWarn)
    }
  },
})

export const setupStatusCmd = defineCommand({
  meta: { name: 'setup-status', description: 'Machine-readable setup status for desktop UI' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (vs single-line text)' },
  },
  run({ args }) {
    const deps = defaultDoctorDeps()
    const status = setupStatus(deps)
    if (args.json) console.log(JSON.stringify(SetupStatusOutput.parse(status), null, 2))
    else console.log(status.bound ? 'wechat: bound' : 'wechat: not bound')
  },
})

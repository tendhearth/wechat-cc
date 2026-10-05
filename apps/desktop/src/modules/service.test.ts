import { describe, it, expect, vi, afterEach } from "vitest"
import { serviceAction, silentInstallAndStart } from "./service.js"

describe("silentInstallAndStart", () => {
  it("returns ok=true when install + start + alive all succeed", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      const sub = args.args[0]
      if (sub === "service" && args.args[1] === "install") return { ok: true, kind: "launchagent" }
      if (sub === "service" && args.args[1] === "start") return { ok: true }
      if (sub === "doctor") return { checks: { daemon: { alive: true, pid: 4242 } } }
      return null
    })
    const labels: string[] = []
    const result = await silentInstallAndStart({ invoke }, (l) => labels.push(l))
    expect(result.ok).toBe(true)
    expect((result as { serviceKind: string }).serviceKind).toBe("launchagent")
    expect((result as { daemonPid: number }).daemonPid).toBe(4242)
    expect(labels).toContain("安装后台服务…")
    expect(labels).toContain("启动后台服务…")
  })

  it("returns ok=false stage=install when install fails", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service" && args.args[1] === "install") return { ok: false, error: "denied", stderr: "no perms" }
      return null
    })
    const result = await silentInstallAndStart({ invoke }, () => {})
    expect(result).toMatchObject({ ok: false, stage: "install", error: "denied", details: "no perms" })
  })

  it("returns ok=false stage=start when start fails", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service" && args.args[1] === "install") return { ok: true, kind: "systemd-user" }
      if (args.args[0] === "service" && args.args[1] === "start") return { ok: false, error: "unit not found" }
      return null
    })
    const result = await silentInstallAndStart({ invoke }, () => {})
    expect(result).toMatchObject({ ok: false, stage: "start", error: "unit not found" })
  })

  it("returns ok=false stage=alive when daemon never responds", async () => {
    const invoke = vi.fn(async (_cmd: string, args: { args: string[] }) => {
      if (args.args[0] === "service") return { ok: true, kind: "systemd-user" }
      if (args.args[0] === "doctor") return { checks: { daemon: { alive: false } } }
      return null
    })
    vi.useFakeTimers()
    const promise = silentInstallAndStart({ invoke }, () => {})
    // Drain 15s of fake time in 500ms slices (32 slices > 15000 / 500 = 30).
    for (let i = 0; i < 32; i++) {
      await vi.advanceTimersByTimeAsync(500)
    }
    const result = await promise
    vi.useRealTimers()
    expect(result).toMatchObject({ ok: false, stage: "alive" })
  })
})

describe("serviceAction install choices", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    { unattended: false, autoStart: true, drawerUnattended: true, drawerAutoStart: false, expected: ["service", "install", "--json", "--unattended", "false", "--auto-start", "true"] },
    { unattended: true, autoStart: false, drawerUnattended: false, drawerAutoStart: true, expected: ["service", "install", "--json", "--unattended", "true", "--auto-start", "false"] },
  ])("installs the current choices (unattended=$unattended, autoStart=$autoStart) despite stale hidden drawer toggles", async ({ unattended, autoStart, drawerUnattended, drawerAutoStart, expected }) => {
    const summary = { textContent: "" }
    const drawerToggles = new Map([
      ["unattended-toggle", drawerUnattended],
      ["autostart-toggle", drawerAutoStart],
    ])
    vi.stubGlobal("document", {
      getElementById(id: string) {
        if (id === "service-summary") return summary
        if (drawerToggles.has(id)) {
          return { hidden: true, classList: { contains: (name: string) => name === "on" && drawerToggles.get(id) } }
        }
        return null
      },
    })
    const calls: string[][] = []
    const invoke = async (_cmd: string, { args }: { args: string[] }) => {
      calls.push(args)
      if (args[0] === "install-progress") return null
      if (args[0] === "service" && args[1] === "status") return { alive: false, installed: false, pid: null }
      if (args[0] === "service" && args[1] === "install") return { ok: true, kind: "launchagent", dryRun: false }
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    }
    const readyReport = { checks: { daemon: { alive: true, pid: 4242 }, service: { installed: true } } }
    const state = { unattended, autoStart }
    await serviceAction({
      invoke,
      formatInvokeError: String,
      doctorPoller: {
        current: { checks: { provider: { ok: true } } },
        waitForCondition: async () => readyReport,
        refresh: async () => readyReport,
      },
    }, state, "install")

    expect(calls.find(args => args[0] === "service" && args[1] === "install")).toEqual(expected)
    expect(state).toEqual({ unattended, autoStart })
  })
})


describe('finished installation progress',()=>{
 afterEach(()=>vi.unstubAllGlobals())
 it('does not let a late progress response replace the finished button',async()=>{
  const button={innerHTML:'安装并启动',disabled:false},summary={textContent:''}
  vi.stubGlobal('document',{getElementById:(id:string)=>id==='service-install'?button:id==='service-summary'?summary:null})
  let resolve!:(value:unknown)=>void
  const progress=new Promise(r=>{resolve=r})
  const ready={checks:{provider:{ok:true},daemon:{alive:true,pid:4242},service:{installed:true}}}
  const invoke=async(_cmd:string,{args}:{args:string[]})=>args[0]==='install-progress'?progress:args[1]==='status'?{alive:false,installed:false}:{ok:true,kind:'launchagent',dryRun:false}
  await serviceAction({invoke,formatInvokeError:String,doctorPoller:{current:ready,refresh:async()=>ready,waitForCondition:async()=>ready}},{unattended:false,autoStart:false},'install')
  resolve({step:2,total:5,label:'注册后台服务',ts:Date.now()})
  for(let i=0;i<5;i++)await Promise.resolve()
  expect(button).toEqual({innerHTML:'安装并启动',disabled:false})
 })
})

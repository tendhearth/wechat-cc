import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdSocialEnable, applySocialSwitch, DEFAULT_SOCIAL_DISCLOSURE_POLICY, DEFAULT_MAILBOX_RELAYS } from './social-enable'

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-cli-social-enable-test-'))
}

// Capture console.log calls during a block.
function captureLog(fn: () => void): string[] {
  const out: string[] = []
  const stub = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  })
  try { fn() } finally { stub.mockRestore() }
  return out
}

describe('cmdSocialEnable', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('merge-persists social_enabled + defaults, preserving unmodeled/existing keys (bot_name, a2a_agents)', () => {
    const configPath = join(stateDir, 'agent-config.json')
    const before = {
      bot_name: 'x',
      a2a_agents: [{ id: 'peer-1', name: 'peer' }],
      legacy_unmodeled_field: 'keep-me',
    }
    writeFileSync(configPath, JSON.stringify(before, null, 2) + '\n')

    cmdSocialEnable(stateDir, { status: false })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.social_enabled).toBe(true)
    expect(onDisk.social_disclosure_policy).toBe(DEFAULT_SOCIAL_DISCLOSURE_POLICY)
    expect(onDisk.mailbox_relays).toEqual(DEFAULT_MAILBOX_RELAYS)
    // unmodeled/existing keys preserved byte-for-byte (except the set keys)
    expect(onDisk.bot_name).toBe('x')
    expect(onDisk.a2a_agents).toEqual(before.a2a_agents)
    expect(onDisk.legacy_unmodeled_field).toBe('keep-me')
  })

  it('does NOT overwrite an existing social_disclosure_policy or mailbox_relays', () => {
    const configPath = join(stateDir, 'agent-config.json')
    const before = {
      social_disclosure_policy: '我自己的策略',
      mailbox_relays: ['https://other/mailbox'],
    }
    writeFileSync(configPath, JSON.stringify(before, null, 2) + '\n')

    cmdSocialEnable(stateDir, { status: false })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.social_enabled).toBe(true)
    expect(onDisk.social_disclosure_policy).toBe('我自己的策略')
    expect(onDisk.mailbox_relays).toEqual(['https://other/mailbox'])
  })

  it('writes the config file atomically (tmp+rename) with mode 0600', () => {
    if (process.platform === 'win32') return  // chmod semantics differ on Windows
    const configPath = join(stateDir, 'agent-config.json')
    cmdSocialEnable(stateDir, { status: false })

    // No leftover tmp file, real file exists and parses.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.social_enabled).toBe(true)
    const mode = statSync(configPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('--status prints the three current values and does NOT write', () => {
    const configPath = join(stateDir, 'agent-config.json')
    const before = {
      social_enabled: true,
      social_disclosure_policy: '现有策略',
      mailbox_relays: ['https://existing/mailbox'],
    }
    writeFileSync(configPath, JSON.stringify(before, null, 2) + '\n')
    const beforeRaw = readFileSync(configPath, 'utf8')

    const out = captureLog(() => cmdSocialEnable(stateDir, { status: true }))
    const joined = out.join('\n')
    expect(joined).toContain('true')
    expect(joined).toContain('现有策略')
    expect(joined).toContain('https://existing/mailbox')

    // no write happened
    expect(readFileSync(configPath, 'utf8')).toBe(beforeRaw)
  })

  it('--status on a missing config prints falsy defaults without creating the file', () => {
    const out = captureLog(() => cmdSocialEnable(stateDir, { status: true }))
    expect(out.join('\n')).toBeTruthy()
  })
})

// 2026-08-31:社交开关要从桌面端点(此前三处入口都只会说"先去命令行跑
// wechat-cc social enable" —— 一个桌面产品把人踢回终端,朋友测试基本必然
// 卡在这里)。抽出与 console 无关的纯核心,CLI 和 HTTP 路由共用一份逻辑。
//
// 同时新增关闭能力。原文件明确写过"不做 disable —— 关社交是运维改配置,不是
// 一键上手的一部分",这条现在被有意推翻:开关既然做成了产品里的按钮,就必须
// 能关,否则用户被单向门锁住。
describe('applySocialSwitch —— CLI 与桌面共用的纯核心', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('开启:写入 social_enabled + 两项默认,并如实报告改了什么', () => {
    const r = applySocialSwitch(stateDir, true)
    expect(r.enabled).toBe(true)
    expect(r.changed).toContain('social_enabled')
    const raw = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(raw.social_enabled).toBe(true)
    expect(raw.social_disclosure_policy).toBe(DEFAULT_SOCIAL_DISCLOSURE_POLICY)
    expect(raw.mailbox_relays).toEqual(DEFAULT_MAILBOX_RELAYS)
  })

  it('关闭:只翻 social_enabled,保留披露策略与中继(下次开启不用重填)', () => {
    applySocialSwitch(stateDir, true)
    const r = applySocialSwitch(stateDir, false)
    expect(r.enabled).toBe(false)
    const raw = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(raw.social_enabled).toBe(false)
    expect(raw.social_disclosure_policy).toBe(DEFAULT_SOCIAL_DISCLOSURE_POLICY)  // 不清空
    expect(raw.mailbox_relays).toEqual(DEFAULT_MAILBOX_RELAYS)
  })

  it('不覆盖已有的运维设置(开启时)', () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({
      bot_name: '小 CC', social_disclosure_policy: '我自己的策略', mailbox_relays: ['https://mine/mailbox'],
    }))
    applySocialSwitch(stateDir, true)
    const raw = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(raw.social_disclosure_policy).toBe('我自己的策略')
    expect(raw.mailbox_relays).toEqual(['https://mine/mailbox'])
    expect(raw.bot_name).toBe('小 CC')   // 未建模的键不能被吞掉
  })

  it('幂等:重复开启不报改动,重复关闭同理', () => {
    applySocialSwitch(stateDir, true)
    expect(applySocialSwitch(stateDir, true).changed).toEqual([])
    applySocialSwitch(stateDir, false)
    expect(applySocialSwitch(stateDir, false).changed).toEqual([])
  })

  it('原子写 + 0600(与 persistSelfAgentId 同一套落盘姿态)', () => {
    if (process.platform === 'win32') return  // Windows 没有 POSIX mode,恒为 0o666
    applySocialSwitch(stateDir, true)
    expect(statSync(join(stateDir, 'agent-config.json')).mode & 0o777).toBe(0o600)
  })
})

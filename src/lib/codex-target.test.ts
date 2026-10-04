/**
 * 守护:Codex 实际连到哪里(2026-10-03)。
 *
 * codex 0.153 **不认** `OPENAI_BASE_URL` / `OPENAI_API_KEY` —— 它只按自己的配置走
 * (CODEX_HOME/config.toml 的 model_provider → model_providers.<id>.base_url,`openai_base_url`,
 * `-c` 覆盖)。守护过去按 OPENAI_BASE_URL 判:环境变量指向国内网关、config 还是默认 ⇒ 守护说不用保护,
 * codex 却直连 api.openai.com。这里全用临时目录里的 fixture,不起 codex、不碰网络、不读主人的 ~/.codex。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyCall } from './call-classifier'
import { codexCallTarget, codexTargetFromConfig, resolveCodexTarget } from './codex-target'

let root: string
let home: string
let codexHome: string
const opts = (extra: Partial<Parameters<typeof resolveCodexTarget>[0]> = {}) => ({ env: { HOME: home, CODEX_HOME: codexHome }, systemDir: join(root, 'etc-codex'), ...extra })
const writeConfig = (body: string, dir = codexHome) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'config.toml'), body) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-target-'))
  home = join(root, 'home')
  codexHome = join(root, 'codex-home')
  mkdirSync(home, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const classified = (o = opts()) => classifyCall(codexCallTarget({ model: 'gpt-5.5' }, o))

describe('codex 实际目标:按 codex 自己的配置,不按 OPENAI_BASE_URL', () => {
  it('没有 config.toml ⇒ 官方 api.openai.com,需要保护', () => {
    expect(resolveCodexTarget(opts())).toMatchObject({ baseUrl: null, providerId: 'openai' })
    expect(classified()).toMatchObject({ protected: true, kind: 'official', host: 'api.openai.com' })
  })

  it('默认配置(没写 model_provider)⇒ 官方,需要保护', () => {
    writeConfig('model = "gpt-5.5"\n[mcp_servers.x]\ncommand = "x"\n')
    expect(classified()).toMatchObject({ protected: true, kind: 'official' })
  })

  it('bug:OPENAI_BASE_URL 指向国内网关、config 是默认 ⇒ 仍然需要保护(codex 根本不看这个变量)', () => {
    writeConfig('model = "gpt-5.5"\n')
    const o = opts({ env: { HOME: home, CODEX_HOME: codexHome, OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } })
    expect(resolveCodexTarget(o)).toMatchObject({ baseUrl: null, providerId: 'openai' })
    expect(classified(o)).toMatchObject({ protected: true, kind: 'official' })
  })

  it('自定义 provider 指到国内平台 ⇒ 不需要保护', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "DeepSeek"\nbase_url = "https://api.deepseek.com/v1"\nwire_api = "chat"\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ baseUrl: 'https://api.deepseek.com/v1', providerId: 'ds' })
    expect(classified()).toMatchObject({ protected: false, kind: 'domestic' })
  })

  it('自定义 provider 指到自建 / 局域网 ⇒ 不需要保护', () => {
    writeConfig('model_provider = "lan"\n[model_providers.lan]\nname = "L"\nbase_url = "http://192.168.1.20:8000/v1"\n')
    expect(classified()).toMatchObject({ protected: false, kind: 'self_hosted' })
  })

  it('自定义 provider 指回 OpenAI / OpenRouter ⇒ 需要保护', () => {
    writeConfig('model_provider = "or"\n[model_providers.or]\nname = "OR"\nbase_url = "https://openrouter.ai/api/v1"\n')
    expect(classified()).toMatchObject({ protected: true, kind: 'aggregator' })
  })

  it('openai_base_url 改了内置 openai 的端点 ⇒ 按那个 host 判', () => {
    writeConfig('openai_base_url = "https://llm.example.cn/v1"\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ baseUrl: 'https://llm.example.cn/v1', providerId: 'openai' })
    expect(classified()).toMatchObject({ protected: false, kind: 'custom_gateway' })
  })

  it('CODEX_HOME 决定读哪份:缺省 $HOME/.codex', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n', join(home, '.codex'))
    expect(classified(opts({ env: { HOME: home } }))).toMatchObject({ protected: false, kind: 'domestic' })
    // 换一个 CODEX_HOME(里面什么都没有)⇒ 默认官方
    expect(classified(opts({ env: { HOME: home, CODEX_HOME: join(root, 'other') } }))).toMatchObject({ protected: true, kind: 'official' })
  })

  it('读不出来的 config.toml ⇒ 拿不准 ⇒ 需要保护', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nbase_url = "https://api.deepseek.com"\n')
    chmodSync(join(codexHome, 'config.toml'), 0o000)
    try {
      const r = resolveCodexTarget(opts())
      // root 跑测试时 chmod 不生效;那种情况下照常读到 = 国内
      if ('unresolved' in r) expect(classified()).toMatchObject({ protected: true, kind: 'unresolved' })
      else expect(r.baseUrl).toBe('https://api.deepseek.com')
    } finally { chmodSync(join(codexHome, 'config.toml'), 0o600) }
  })

  it('坏 TOML ⇒ 拿不准 ⇒ 需要保护', () => {
    writeConfig('model_provider = "ds\n[[[ nope\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ unresolved: true })
    expect(classified()).toMatchObject({ protected: true, kind: 'unresolved' })
  })

  it('CODEX_HOME 指到一个目录形状不对的地方(config.toml 是目录)⇒ 拿不准', () => {
    mkdirSync(join(codexHome, 'config.toml'), { recursive: true })
    expect(resolveCodexTarget(opts())).toMatchObject({ unresolved: true })
  })

  it('model_provider 指到没定义的 provider ⇒ 拿不准', () => {
    writeConfig('model_provider = "ghost"\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ unresolved: true })
  })

  it('自定义 provider 没写 base_url ⇒ 拿不准', () => {
    writeConfig('model_provider = "x"\n[model_providers.x]\nname = "x"\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ unresolved: true })
  })

  it('model_providers 里重定义内置 id(codex 会拒绝起)⇒ 拿不准', () => {
    writeConfig('[model_providers.openai]\nname = "x"\nbase_url = "https://api.deepseek.com"\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ unresolved: true })
  })

  it('老式顶层 profile = "…"(codex 0.153 已不认,会报错)⇒ 拿不准', () => {
    writeConfig('profile = "cn"\n[profiles.cn]\nmodel_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    expect(resolveCodexTarget(opts())).toMatchObject({ unresolved: true })
  })

  it('[profiles.x] 表不生效:daemon 从不传 --profile ⇒ 仍按顶层 model_provider', () => {
    writeConfig('[profiles.cn]\nmodel_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    expect(classified()).toMatchObject({ protected: true, kind: 'official' })
  })

  it('-c model_provider=… 覆盖(daemon 传的 config)压过文件', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    expect(classified(opts({ overrides: { model_provider: 'openai' } }))).toMatchObject({ protected: true, kind: 'official' })
  })

  it('-c model_providers.x.base_url=… 覆盖压过文件里的 base_url', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    const o = opts({ overrides: { 'model_providers.ds.base_url': 'https://api.openai.com/v1' } })
    expect(resolveCodexTarget(o)).toMatchObject({ baseUrl: 'https://api.openai.com/v1' })
    expect(classified(o)).toMatchObject({ protected: true, kind: 'official' })
    // 嵌套对象写法(SDK 的 config 形状)同样生效
    expect(classified(opts({ overrides: { model_providers: { ds: { base_url: 'https://api.openai.com/v1' } } } }))).toMatchObject({ protected: true })
  })

  it('daemon 平常传的 -c(mcp_servers / bypass)不影响端点', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    expect(classified(opts({ overrides: { mcp_servers: { wechat: { command: 'x' } }, dangerously_bypass_approvals_and_sandbox: true } }))).toMatchObject({ protected: false })
  })

  it('系统层 /etc/codex/config.toml 在用户层之下', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n', join(root, 'etc-codex'))
    expect(classified()).toMatchObject({ protected: false, kind: 'domestic' })
    writeConfig('model_provider = "openai"\n')
    expect(classified()).toMatchObject({ protected: true, kind: 'official' })
  })

  it('managed_config.toml 压过用户层', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    writeFileSync(join(codexHome, 'managed_config.toml'), 'model_provider = "openai"\n')
    expect(classified()).toMatchObject({ protected: true, kind: 'official' })
  })

  it('项目层 .codex/config.toml 改了端点相关的键 ⇒ 拿不准(是否生效看信任,daemon 判不了)', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    const proj = join(root, 'proj', 'sub')
    mkdirSync(join(root, 'proj', '.codex'), { recursive: true })
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(root, 'proj', '.codex', 'config.toml'), 'model_provider = "openai"\n')
    expect(resolveCodexTarget(opts({ cwd: proj }))).toMatchObject({ unresolved: true })
    // 项目层只写了别的键(mcp / 模型)⇒ 不影响
    writeFileSync(join(root, 'proj', '.codex', 'config.toml'), 'model = "x"\n')
    expect(classified(opts({ cwd: proj }))).toMatchObject({ protected: false, kind: 'domestic' })
  })

  it('$HOME/.codex 不算项目层(那是用户层本身)', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n', join(home, '.codex'))
    mkdirSync(join(home, 'work'), { recursive: true })
    expect(classified(opts({ env: { HOME: home }, cwd: join(home, 'work') }))).toMatchObject({ protected: false, kind: 'domestic' })
  })

  it('内置 ollama / lmstudio ⇒ 本机;CODEX_OSS_BASE_URL 改了就按它', () => {
    writeConfig('model_provider = "ollama"\n')
    expect(classified()).toMatchObject({ protected: false, kind: 'self_hosted' })
    expect(classified(opts({ env: { HOME: home, CODEX_HOME: codexHome, CODEX_OSS_BASE_URL: 'https://api.openai.com/v1' } }))).toMatchObject({ protected: true })
    writeConfig('model_provider = "lmstudio"\n')
    expect(classified()).toMatchObject({ protected: false, kind: 'self_hosted' })
  })

  it('codexCallTarget 带 exact(配置后来改了,守护也不拿此刻的环境变量补)', () => {
    writeConfig('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com"\n')
    expect(codexCallTarget({ model: 'm' }, opts())).toEqual({ provider: 'codex', model: 'm', baseUrl: 'https://api.deepseek.com', exact: true })
    writeConfig('model_provider = "ghost"\n')
    expect(codexCallTarget({ model: 'm' }, opts())).toEqual({ provider: 'codex', model: 'm', unresolved: true })
  })
})

describe('codexTargetFromConfig:直接吃 codex app-server config/read 的结果', () => {
  it('config/read 的形状(model_provider + model_providers.<id>.base_url)', () => {
    const cfg = { model_provider: 'local', model: 'm1', profile: null, openai_base_url: null, model_providers: { local: { name: 'Local', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses' } } }
    expect(codexTargetFromConfig(cfg, {})).toMatchObject({ baseUrl: 'http://127.0.0.1:9/v1', providerId: 'local', wireApi: 'responses' })
  })
  it('model_provider 为 null(默认)⇒ 官方', () => {
    expect(codexTargetFromConfig({ model_provider: null, profile: null, openai_base_url: null, model_providers: {} }, {})).toMatchObject({ baseUrl: null, providerId: 'openai' })
  })
  it('不是对象 ⇒ 拿不准', () => {
    expect(codexTargetFromConfig(null, {})).toMatchObject({ unresolved: true })
    expect(codexTargetFromConfig({ model_provider: 7 }, {})).toMatchObject({ unresolved: true })
  })
})

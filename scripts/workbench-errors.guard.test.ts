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

describe('桌面路由能回的、桌面 UI 在等的码(#465 盘点发现)', () => {
  it('额度用完 / 文件夹正被占着 ⇒ 桌面带码回,不再是 500 internal', async () => {
    const { workbenchErrorHttp } = await import('../packages/protocol/src/workbench-errors')
    expect(workbenchErrorHttp('provider_quota_exhausted', 'desktop')).toEqual({ status: 503, error: 'provider_quota_exhausted' })
    expect(workbenchErrorHttp('native_folder_busy', 'desktop')).toEqual({ status: 409, error: 'native_folder_busy' })
  })
})

/**
 * 带 BOM 容忍的 JSON 读取。
 *
 * 2026-09-01 真机事故(Windows 域机首次跑 daemon):`ilink-glue.ts` 直接
 * `JSON.parse(readFileSync(...))` 读 account.json,遇到 UTF-8 BOM 直接
 * `SyntaxError: Unrecognized token '﻿'`,daemon fatal 退出、连日志都没有。
 *
 * 而 **PowerShell 的 `Set-Content -Encoding UTF8` 默认就写 BOM** —— 任何在
 * Windows 上手写或用脚本生成配置的人都会踩,而且症状(daemon 起不来)离
 * 根因(文件头三个不可见字节)极远。
 *
 * 全仓有 54 处同形状的 `JSON.parse(readFileSync(...))`;这个 helper 是给它们
 * 准备的统一入口,本次先接最要命的两处(账号加载 / agent-config)。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile, stripBom } from './read-json-file'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'read-json-')) }

describe('stripBom', () => {
  it('去掉 UTF-8 BOM,没有 BOM 的原样返回', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}')
    expect(stripBom('{"a":1}')).toBe('{"a":1}')
    expect(stripBom('')).toBe('')
  })
  it('只去开头那一个,不动内容里的同码点', () => {
    expect(stripBom('﻿{"a":"x﻿y"}')).toBe('{"a":"x﻿y"}')
  })
})

describe('readJsonFile', () => {
  it('带 BOM 的文件能正常解析(这正是 Windows 上 daemon 起不来的那个 bug)', () => {
    const d = tmp()
    try {
      writeFileSync(join(d, 'a.json'), '﻿{"botId":"x","userId":"y"}')
      expect(readJsonFile(join(d, 'a.json'))).toEqual({ botId: 'x', userId: 'y' })
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('不带 BOM 的照常', () => {
    const d = tmp()
    try {
      writeFileSync(join(d, 'b.json'), '{"n":1}')
      expect(readJsonFile(join(d, 'b.json'))).toEqual({ n: 1 })
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('文件不存在 / 内容不是 JSON → 抛,由调用方决定怎么办(不静默吞)', () => {
    const d = tmp()
    try {
      expect(() => readJsonFile(join(d, 'nope.json'))).toThrow()
      writeFileSync(join(d, 'bad.json'), '{ 不是 json')
      expect(() => readJsonFile(join(d, 'bad.json'))).toThrow()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

// ── 仓库级守卫 ────────────────────────────────────────────────────────────
//
// 光有 helper 没用 —— 2026-09-01 加它的时候文件头就写着「全仓另有 ~50 处同
// 形状的调用,按需逐步接过来」。**「按需逐步」= 永远不会做完**,而且下一个
// 新写的读配置代码会照着旧的抄。所以这里改成硬规则:生产代码里不许再出现
// 裸的 `JSON.parse(readFileSync(...))`。
//
// 测试文件豁免:它们读的是自己刚写出来的夹具,不会带 BOM,而且强制走 helper
// 只会给夹具增加噪音。
import { readdirSync, statSync } from 'node:fs'
import { join as pjoin, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// import.meta.dir 是 Bun 专有的,vitest 下为 undefined —— 与
// test-runner-guard.test.ts 用同一套 fileURLToPath 解法。
const REPO_ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'target') continue
    const full = pjoin(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

describe('仓库守卫 —— 生产代码不许再出现裸的 JSON.parse(readFileSync(...))', () => {
  it('每一处读 JSON 文件都走 readJsonFile(容忍 BOM)', () => {
    const root = REPO_ROOT
    const offenders: string[] = []
    for (const file of [...walk(pjoin(root, 'src')), ...walk(pjoin(root, 'apps'))]) {
      if (file.endsWith(pjoin('lib', 'read-json-file.ts'))) continue   // helper 自己
      const text = readFileSync(file, 'utf8')
      // 单行与跨行两种写法都要抓
      const re = /JSON\.parse\(\s*readFileSync\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length
        offenders.push(`${file.slice(root.length + 1)}:${line}`)
      }
    }
    expect(
      offenders,
      offenders.length === 0 ? '' :
        `这些地方还在裸读 JSON —— 换成 readJsonFile(path)：\n  ${offenders.join('\n  ')}\n`
        + `为什么重要:PowerShell 的 Set-Content -Encoding UTF8 默认写 BOM,`
        + `而 JSON.parse 不接受 BOM。症状(daemon 起不来)离根因(文件头三个`
        + `不可见字节)极远 —— 2026-09-01 在 Windows 域机上真栽过一次。`,
    ).toEqual([])
  })
})

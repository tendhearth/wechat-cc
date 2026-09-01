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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

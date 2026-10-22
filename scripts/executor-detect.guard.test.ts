/**
 * 执行者「在不在」只判一处(3c 第 2 步,设计稿 docs/superpowers/specs/2026-10-22-executor-detect-once-design.md)。
 *
 * 以前五六处各写一遍 `cursorAgentBin ?? findOnPath('cursor-agent')`、`process.env.GEMINI_API_KEY ?? …`,
 * 判法还不一样(空串一边当配了、一边回落 PATH)。现在规则只在 src/lib/executor-detect.ts(读 executor-facts 的
 * `detect`),生产代码里再出现这几种手写 ⇒ 红,改成调 executorBinary / executorCredential / executorMissingConfig。
 * 只扫生产代码(排除 *.test.ts);注释行不算。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const HOME = 'src/lib/executor-detect.ts'

const HAND_WRITTEN: Record<string, RegExp> = {
  '自己在 PATH 上找执行者的二进制': /findOnPath\(\s*['"](cursor-agent|agy)['"]\s*\)/,
  '自己判覆盖路径(空串规则会写歪)': /\b(cursorAgentBin|agyBin)\s*(\?\?|\|\|)/,
  '自己读执行者密钥判在不在': /\benv\.(GEMINI_API_KEY|GOOGLE_API_KEY|CURSOR_API_KEY)\b/,
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out) }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line)

describe('执行者「在不在」只在 lib/executor-detect 判', () => {
  it('生产代码里没有手写的二进制查找 / 覆盖路径判断 / 密钥判断', () => {
    const hits: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (rel === HOME) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (isComment(line)) return
        for (const [why, re] of Object.entries(HAND_WRITTEN)) if (re.test(line)) hits.push(`${rel}:${i + 1} ${why}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })
})

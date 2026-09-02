/**
 * read-json-file — `JSON.parse(readFileSync(...))`,但容忍 UTF-8 BOM。
 *
 * WHY(2026-09-01,Windows 域机首次跑 daemon 时的真机事故):`ilink-glue.ts`
 * 直接 `JSON.parse` 读 account.json,文件带 BOM 时抛
 * `SyntaxError: Unrecognized token '﻿'`,daemon 直接 fatal 退出、日志里什么
 * 都没留下。而 **PowerShell 的 `Set-Content -Encoding UTF8` 默认就写 BOM**,
 * 所以任何在 Windows 上手写或用脚本生成配置的人都会踩 —— 症状(起不来)
 * 离根因(文件头三个不可见字节)极远。
 *
 * BOM 是**合法的** UTF-8 文件开头,`JSON.parse` 不接受只是 JSON 规范的选择。
 * 读配置文件时容忍它是正确的宽容度:我们读的是人和工具写出来的文件,不是
 * 协议报文。
 *
 * 全仓另有 ~50 处同形状的 `JSON.parse(readFileSync(...))`。这里是给它们准备
 * 的统一入口,按需逐步接过来 —— 优先那些「读不到就起不来」的路径。
 */
import { readFileSync } from 'node:fs'

/** 去掉开头的 UTF-8 BOM(U+FEFF);没有就原样返回。只去开头那一个。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 读并解析一个 JSON 文件,容忍 BOM。
 *
 * 刻意**不吞异常**:文件缺失和内容损坏是两种调用方必须自己决定怎么办的
 * 情况(有的该跳过、有的该 fail loud),在这里统一压成 null 会抹掉那个决定权。
 */
export function readJsonFile<T = unknown>(path: string): T {
  return JSON.parse(stripBom(readFileSync(path, 'utf8'))) as T
}

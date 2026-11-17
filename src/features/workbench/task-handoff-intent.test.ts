import { describe, expect, it } from 'vitest'
import { isTaskHandoffRequest } from './task-reference'

// 精确优先:判成「是」会把日常补充从执行者手里劫走。两张表都来自 2026-11-13 的真模型验收与两轮复核,
// 新句式先加进表里再改规则。
const EXECUTORS = ['claude', '克劳德', 'codex', 'api', 'qwen', 'deepseek', 'kimi', 'cursor', 'agy', 'gemini']

const NOT_HANDOFF = ['claude 跑了',
  'codex 做了',
  'Claude 继续',
  'claude 写了一半',
  'codex 改完了',
  'gemini 看看',
  'Claude 来了',
  '把请求交给 api 网关处理',
  '这个接口交给 API 层去校验',
  '把 token 交给 codex 的配置文件里那个字段',
  '让 claude 继续做的那个分支先别合',
  '上次交给 Claude 的那版不对,你按原方案改',
  '交给 Claude 之前先把测试补上',
  '为什么不换 Claude 来做?',
  '让 cursor 继续闪烁的 bug 修一下',
  '把光标 cursor 接管的逻辑删掉',
  '给 gemini 做适配层',
  '给 Claude 做一个头像',
  'kimi 来继续支持流式输出',
  '文档里写:交给 Claude 接着做',
  '把这段交给 lint 跑一下',
  '提交给 codex 分支',
  '换成 Claude 继续用的那个配色',
  'let claude take over the world 这句文案删掉',
'做完后把结果交给我',
  '把表单提交给后端',
  '对接手机端的接口也改一下',
  '连接管理器那里加个重试',
  '把货币换人民币',
  '让它继续做',
  '让测试继续处理剩下的用例',
  '让我想想再继续做',
  '不要让它继续做了,停',
  '把参数换成 Claude 风格的命名',
  '换个模型名的变量',
  'README 里写上 handoff 流程',
  '任务 a85aec02 把结果交给我看一下',
  '任务 a85aec02 补充 提交给后端',
  '任务 a85aec02 停止,别交给别人',
  '任务 a85aec02 文件 交给我',
  '接着做,别停',
  '换个文件名',
  '任务 3 把结果交给我',
  '别交给 Claude',
  '不要让 Codex 接着做了,停',
  '先不换 Claude',
  'claude 的回复太长了',
  'codex 跑完了吗',
  '用 claude 的风格写注释',
  '按钮文案改成「交给 Claude 接着做」',
  'claude-code 的配置看一下',
  '把 codex/config.toml 改一下',
  'gemini 做的图不好看',
  '让 kimi 模型的温度固定为 1']

const REVIEW_NOT_HANDOFF = [
  '不是让 Codex 接手,你继续补测试。', '错误日志里出现:交给 Claude 接手。', 'README 示例改成:让 Codex 继续。',
  '函数名保留 matter_handoff,别顺手重命名。', '别调用 matter_handoff,先把报错修掉。', '复现步骤最后一行是:交给 Codex 接手。',
  'Rename the helper that wraps matter_handoff.', 'UI 提示改为:hand over to Codex。', '不要调用 matter_handoff',
  'Don’t switch to Claude!', 'No need to switch to Claude!', "测试输入用 '交给 Claude 接手。'",
  'The log line currently says: switch to Codex!', '不是交给 Claude', '日志原文是 foo.codex 来接手', '日志原文是 foo@codex 来接手',
]
const REVIEW_HANDOFF = [
  'Claude 太慢了,接下来由 Codex 负责这个修复。', 'Please reassign this task to Codex.', 'Can Claude take over from here?',
  '把当前任务的后半段交给Ｃｌａｕｄｅ。', 'Please switch to Codex.', '交给 ＠Claude 接手', '交给 Ｃｌａｕｄｅ 接手', 'switch to Claude.',
  '我的意思是:交给 Claude 接着做',
]

const HANDOFF = ['Claude 来做',
  'codex 来接手吧',
  '交给 Claude 接着做',
  '这个让 Codex 接手吧',
  '剩下的转给 claude',
  '换 Claude 来做',
  '改由 Codex 继续',
  '后半段给 Codex 做',
  '把事项 a85aec02 交给 Claude',
  'claude 来接着做',
  '不想等了,换成 codex 继续',
  'hand it off to claude',
  '麻烦让克劳德接着做',
  '请调用 matter_handoff 把事项 a85aec02 交给 Claude',
  '让 Claude 接着做 a85aec02 的后半段',
  '任务 a85aec02 交给 Claude 接着做',
  '转给 Claude',
  '给 Codex 做吧',
  'switch to claude',
  'let codex take over',
  '如果交给 Codex 会不会更快?',
  '交给 claude 行吗',
  '这步换 Codex 试试',
  '让 gemini 接着做剩下的',
  '不是让你停,而是交给 Claude 继续做',
  '换个 Claude 来做吧',
  '好,交给 Claude']

describe('isTaskHandoffRequest', () => {
  it.each(NOT_HANDOFF)('不是接力:%s', text => { expect(isTaskHandoffRequest(text, EXECUTORS)).toBe(false) })
  it.each(HANDOFF)('是接力:%s', text => { expect(isTaskHandoffRequest(text, EXECUTORS)).toBe(true) })
  it.each(REVIEW_NOT_HANDOFF)('不是接力(复核):%s', text => { expect(isTaskHandoffRequest(text, EXECUTORS)).toBe(false) })
  it.each(REVIEW_HANDOFF)('是接力(复核):%s', text => { expect(isTaskHandoffRequest(text, EXECUTORS)).toBe(true) })
  it('名字里的空格必须有:Ops Team 不匹配 OpsTeam', () => {
    expect(isTaskHandoffRequest('交给 OpsTeam 接手', ['Ops Team'])).toBe(false)
    expect(isTaskHandoffRequest('交给 Ops Team 接手', ['Ops Team'])).toBe(true)
  })
  it('一大串空格或没闭合的引号不会拖慢', () => {
    const started = performance.now()
    expect(isTaskHandoffRequest('交给' + ' '.repeat(5000) + 'Claude' + ' '.repeat(5000) + 'x', EXECUTORS)).toBe(false)
    // 只看开头 400 字:后面的请求被截掉,判「不是」(精确优先),关键是不卡。
    expect(isTaskHandoffRequest('“'.repeat(3000) + '交给 Claude', EXECUTORS)).toBe(false)
    expect(isTaskHandoffRequest('“'.repeat(100) + '交给 Claude', EXECUTORS)).toBe(true)
    expect(performance.now() - started).toBeLessThan(200)
  })
  it('没有登记的执行者时只认显式工具名', () => {
    expect(isTaskHandoffRequest('交给 Claude 接着做', [])).toBe(false)
    expect(isTaskHandoffRequest('请调用 matter_handoff 交接', [])).toBe(true)
  })
})

/** 用户第二轮独立复核的原句；期望由验收任务给定，不由解析器计算。 */
export const handoffNames = ['Claude', '克劳德', 'Codex', 'Cursor', 'agy', 'Gemini', 'API', 'DeepSeek', 'GLM4', '我的 ACP']
export const handoffCases: Array<[string, boolean]> = [
  ...[
    '把这段交给 lint 跑一下', '做完后把结果交给我', '把表单提交给后端', '对接手机端的接口也改一下',
    '连接管理器那里加个重试', '把货币换人民币', '让它继续做', '让测试继续处理剩下的用例',
    '让我想想再继续做', '不要让它继续做了,停', '把参数换成 Claude 风格的命名', '换个模型名的变量',
    'README 里写上 handoff 流程', '任务 a85aec02 把结果交给我看一下', '任务 a85aec02 补充 提交给后端',
    '任务 a85aec02 停止,别交给别人', '任务 a85aec02 文件 交给我', '接着做,别停', '换个文件名', '任务 3 把结果交给我',
    '交给后端', '交给别人', '别交给 Claude', '不要让 Codex 接着做了,停', '提交给 Claude', '任务 a85aec02 补充 先不交给 Claude', '这件不能交给 Claude',
    '任务 a85aec02 补充 把输入交给 Claude.ts 处理', '任务 a85aec02 补充 把日志文案改成“交给 Claude”',
    '把参数换成 Claude 格式', '换成 Claude 命名', '交给 ClaudeStyle', '交给 myCodex',
    '转给后端,Claude 看结果', '让 Claude 看结果,接着做', 'sample-project 换人接着做', '交给另一位来完成',
  ].map(text => [text, false] as [string, boolean]),
  ...[
    '换 Claude 来做', '转给 Claude', '改由 Codex 继续', 'Claude 来接着做', '给 Codex 做吧',
    'switch to claude', 'let codex take over', 'hand it off to claude',
    '请调用 matter_handoff 把事项 a85aec02 交给 Claude', '让 Claude 接着做 a85aec02 的后半段',
    '把事项 a85aec02 交给 Claude 接着做', '换成 GLM4 继续', '交给我的 ACP',
    '让 Gemini 接管', '让 agy 接手', 'hand off to Cursor', '交给克劳德', '别修改代码而是交给 Claude', '交给 @claude 接着做',
  ].map(text => [text, true] as [string, boolean]),
]

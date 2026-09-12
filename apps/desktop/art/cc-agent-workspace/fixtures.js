// Synthetic design content only. IDs model explicit parentage, never inferred from text.
export const projects = {
  desktop: {
    name: 'CC 桌面应用', title: '修复登录问题', path: 'wechat-cc',
    request: '把登录问题修掉。Claude 先查原因，Codex 改，改完再让 Claude 看一下。',
    response: '我会保留登录接口，先定位，再修改和复核。它们各自启动的子任务，也会留在对应步骤里。',
    constraint: '不改登录接口，不修改数据库。',
    findings: '登录状态过期后，旧缓存没有清理。',
    files: ['src/auth/session.ts', 'src/auth/session.test.ts'],
    artifact: '登录状态修复 · 第 1 版',
  },
  site: {
    name: '个人网站', title: '整理作品介绍', path: 'personal-site',
    request: '帮我把作品介绍写得简洁一点。先梳理内容，再调整页面。',
    response: '我会先请 Claude 整理文字，再让 Codex 放到页面里。保留你已经确认的标题。',
    constraint: '保留现有标题，不改线上网站。',
    findings: '三段作品介绍重复了同一段背景，可以合并。',
    files: ['src/pages/work.tsx', 'src/pages/work.test.ts'],
    artifact: '作品介绍 · 文案与页面候选',
  },
}

export function makeNodes(projectId) {
  const p = projects[projectId]
  const node = (id, parentId, owner, title, status, summary, extra = {}) => ({ id, parentId, owner, title, status, summary, received: status !== 'queued', session: `${projectId}/${id}`, ...extra })
  return [
    node('claude', null, 'Claude', '排查与整理', 'completed', p.findings),
    node('claude-source', 'claude', 'Claude', projectId === 'desktop' ? '复现登录问题' : '梳理原始文案', 'completed', '已定位相关内容，结果已返回主执行者。'),
    node('claude-scope', 'claude', 'Claude', '核对修改范围', 'completed', p.constraint),
    node('codex', null, 'Codex', '修改与验证', 'running', '实现已更新，正在等待子任务返回验证结果。'),
    node('codex-edit', 'codex', 'Codex', '实现修改', 'completed', `已更新 ${p.files[0]}。`),
    node('codex-test', 'codex', 'Codex', '补充与运行测试', 'running', '正在验证修改，尚未返回测试结果。'),
    node('review', null, 'Claude', '复核修改', 'queued', '等待 Codex 返回修改与测试结果。', { dependsOn: 'codex' }),
  ]
}

export const labels = {
  completed: '已完成', running: '执行中', queued: '等待前一步',
  permission: '等待你授权', blocked: '受阻', stopping: '等待停止确认',
  stopped: '已停止', unknown: '状态待确认',
}

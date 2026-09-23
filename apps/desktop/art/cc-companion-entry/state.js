export const projects = [
  { id: 'cc', name: 'CC 产品', color: 'amber' },
  { id: 'autumn', name: '秋季分享', color: 'sage' },
  { id: 'life', name: '生活', color: 'blue' },
]

export function createState() {
  const tasks = {
    login: { project: 'cc', title: '登录修复', heading: '让登录重新顺畅起来', status: '进行中', summary: 'Claude 找到一处边界问题，Codex 正在修正。', artifact: '登录修复 · 第二版', items: ['保留登录状态', '补齐过期处理', '核对重新登录'], detail: '模拟检查项：断网恢复后，验证登录状态是否仍然保留。', device: '家里的电脑', helper: 'Codex', session: 'codex-demo-login' },
    website: { project: 'cc', title: '准备初稿', heading: '让官网讲清楚 CC 是谁', status: '进行中', summary: '首页的文字已经收拢，正在整理页面层次。', artifact: '官网首页 · 文字初稿', items: ['一句话介绍 CC', '展示真实的陪伴片段', '简化开始使用的路径'], detail: '这份初稿属于 CC 产品，与分享项目中的同名事情分开保存。', device: '这台电脑', helper: 'Claude', session: 'claude-demo-website' },
    billing: { project: 'cc', title: '账单导出', heading: '把这个月的账单整理好', status: '待确认', summary: '导出范围还需要你选一下。', artifact: '账单导出 · 范围', items: ['本月已完成的交易', '按日期排列', '保留原始金额与币种'], detail: '演示选择：仅本月，还是包含上个月？', device: '这台电脑', helper: 'API 助手', session: 'api-demo-billing' },
    talk: { project: 'autumn', title: '周五的分享', heading: '把想分享的事讲得更清楚', status: '已准备好', summary: '讲稿和配图准备好了，随时可以一起看看。', artifact: '周五的分享 · 讲稿', items: ['从一个真实的小故事开始', '讲清楚遇到的问题', '留下一个可以尝试的想法'], detail: '结尾留一点空白，让大家说说自己的经历。', device: '这台电脑', helper: 'Claude', session: 'claude-demo-talk' },
    slides: { project: 'autumn', title: '准备初稿', heading: '给分享做一份轻一点的提纲', status: '待继续', summary: '已经留好了三个段落，等你补充那个小故事。', artifact: '分享提纲 · 第一版', items: ['一个开始', '一次转折', '一点收获'], detail: '这是秋季分享的初稿，不会使用 CC 产品的项目材料。', device: '这台电脑', helper: 'Codex', session: 'codex-demo-slides' },
    walk: { project: 'life', title: '周末散步', heading: '找一条靠水、慢慢走的路', status: '待继续', summary: '你上次说，想找一条靠水的路。', artifact: '周末的小打算', items: ['不用起得太早', '沿着水边走一走', '留一家小店歇脚'], detail: '还没有搜索真实路线；可以先聊聊想去多远。', device: '这台电脑', helper: 'CC', session: 'cc-demo-walk' },
  }
  /** @type {Record<string, {draft: string, files: string[], messages: {scope: string, role: string, text: string, files: string[]}[], paused: boolean}>} */
  const scopes = Object.fromEntries(['home', ...Object.keys(tasks)].map(id => [id, { draft: '', files: [], messages: [], paused: false }]))
  const state = {
    tasks, scopes, active: 'home',
    select(id) { check(id); state.active = id },
    setDraft(id, text) { check(id); scopes[id].draft = text },
    addFiles(id, names) { check(id); scopes[id].files.push(...names) },
    submit(id) {
      check(id)
      const scope = scopes[id]
      if (!scope.draft.trim() && !scope.files.length) return null
      const message = { scope: id, role: 'user', text: scope.draft.trim(), files: [...scope.files] }
      scope.messages.push(message)
      scope.draft = ''; scope.files = []
      return message
    },
    reply(id, text) { check(id); scopes[id].messages.push({ scope: id, role: 'cc', text, files: [] }) },
    togglePause(id) { check(id); scopes[id].paused = !scopes[id].paused },
  }
  function check(id) { if (!Object.hasOwn(scopes, id)) throw new Error('Unknown scope') }
  return state
}

// 测试 shim 里 invoke 失败时的错误串,与 lib.rs 的 daemon_request 一致(评审 #439;F5 起两个宿主代理合成这一个):
// 只有回退一族(rewind_*)带 reason 时拼成 `code:reason`;别的码原样(前端按整串比对)。lib.rs 主人工作区那一半
// 不拼 reason,但那几条路由不会回 rewind_* —— 这里不分两半,结果一样。纯 JS:test-shim.ts 用 toString() 把它塞进注入页面的脚本。
export function invokeErrorMessage(command, status, text) {
  let j = null
  try { j = JSON.parse(text) } catch (e) { /* 不是 JSON */ }
  const error = j && typeof j.error === 'string' && j.error ? j.error : null
  if (!error) return 'HTTP ' + status
  if (command === 'daemon_request' && error.indexOf('rewind_') === 0 && typeof j.reason === 'string') return error + ':' + j.reason
  return error
}

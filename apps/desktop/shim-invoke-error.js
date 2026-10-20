// 测试 shim 里 invoke 失败时的错误串,与 lib.rs 的 workbench_api / customer_review_api 一致(评审 #439):
// workbench_api 只有回退一族(rewind_*)带 reason 时拼成 `code:reason`;别的码原样(前端按整串比对);
// customer_review_api 一律原样。纯 JS:test-shim.ts 用 toString() 把它塞进注入页面的脚本。
export function invokeErrorMessage(command, status, text) {
  let j = null
  try { j = JSON.parse(text) } catch (e) { /* 不是 JSON */ }
  const error = j && typeof j.error === 'string' && j.error ? j.error : null
  if (!error) return 'HTTP ' + status
  if (command === 'workbench_api' && error.indexOf('rewind_') === 0 && typeof j.reason === 'string') return error + ':' + j.reason
  return error
}

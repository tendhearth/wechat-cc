/**
 * TTS 请求的超时。主人自己的 TTS 网关(VoxCPM2,经 Tailscale / VPS 中转)可能接了
 * 连接却一直不回 —— 没有超时的话 reply_voice、/v1/companion/speak、手机朗读全都
 * 永远挂着,也不会回落成文字。signal 跟着 response 走,读 body 也在超时范围内。
 */
export const TTS_TIMEOUT_MS = 60_000

/**
 * 整段(请求 + 读 body)放进 `run`,共用一个到点就 abort 的 signal;超时抛
 * `<label> 504: timed out …`,让上游按「暂时性故障」处理(5xx)。
 */
export async function withTtsTimeout<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS)
  try {
    return await run(ctrl.signal)
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${label} 504: timed out after ${TTS_TIMEOUT_MS / 1000}s`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

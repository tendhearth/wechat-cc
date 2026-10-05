// @ts-check
/// <reference lib="dom" />
/**
 * 把字节存成「下载」里的文件(2026-10-05)。
 *
 * 桌面 app 里 `<a download>` 点了什么也不发生(wry 没有下载处理就一律取消),所以真 app 走 Rust 的
 * save_file:写进 ~/Downloads、同名不覆盖,返回实际路径。浏览器 / 开发 shim 里没有 Tauri,才退回 blob 链接。
 *
 * @param {{ invoke?: ((cmd: string, args: Record<string, unknown>) => Promise<unknown>)|null }} deps
 * @param {string} filename @param {string} mime @param {Uint8Array} bytes
 * @returns {Promise<string|null>} 存到的路径;浏览器里交给浏览器下载时为 null
 */
export async function saveFile(deps, filename, mime, bytes) {
  if (deps.invoke && /** @type {any} */ (window).__TAURI__?.core?.invoke) {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return String(await deps.invoke('save_file', { filename, data_b64: btoa(binary) }))
  }
  const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: mime }))
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  return null
}

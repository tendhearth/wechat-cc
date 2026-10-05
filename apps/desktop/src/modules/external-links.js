// @ts-check
/// <reference lib="dom" />
/**
 * 外部链接一律交给系统浏览器(2026-10-05)。
 *
 * 桌面 app 的 webview(wry)没有新窗口处理:`target="_blank"` 的链接点了什么也不发生 ——
 * CC 回复里的 Markdown 链接、「去安装」「安装指南」「打开链接 →」在浏览器测试里都好好的,真 app 里全哑。
 * 没带 target 的外部链接更糟:会把整个 app 导航走。这里在捕获阶段统一接住 http(s) 链接,
 * 交给 Rust 的 open_url(只认 http/https 等白名单协议);app 自己的页面内链接(#、相对路径)不管。
 *
 * @param {{ invoke?: ((cmd: string, args: Record<string, unknown>) => Promise<unknown>)|null, onError?: (err: unknown) => void, documentTarget?: Document }} deps
 */
export function installExternalLinks(deps) {
  const doc = deps.documentTarget ?? document
  /** @param {MouseEvent} event */
  const onClick = event => {
    if (event.defaultPrevented || event.button !== 0) return
    const a = /** @type {Element|null} */ (event.target instanceof Element ? event.target : null)?.closest('a[href]')
    if (!(a instanceof HTMLAnchorElement)) return
    const href = a.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) return
    event.preventDefault()
    if (deps.invoke) Promise.resolve(deps.invoke('open_url', { url: a.href })).catch(err => deps.onError?.(err))
    else doc.defaultView?.open(a.href, '_blank', 'noopener,noreferrer')
  }
  doc.addEventListener('click', onClick, true)
  return () => doc.removeEventListener('click', onClick, true)
}

// @ts-check

/** @param {string} value */
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] ?? c)

/** @param {string} name @param {string} mime */
export const isHtmlArtifact = (name, mime) => /\.html?$/i.test(name) || mime.split(';')[0] === 'text/html'

/** @param {string} name */
export const artifactDisplayName = name => /\.site\.zip$/i.test(name) ? `${name.replace(/\.site\.zip$/i,'')} · 网页成品` : /\.preview\.json$/i.test(name) ? `${name.replace(/\.preview\.json$/i,'')} · 网页` : name

/** A live preview is explicitly delivered by the task, never inferred from arbitrary links.
 * @param {unknown} value @param {string} [appOrigin] */
export function localPreviewUrl(value, appOrigin = '') {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.port) return null
    if (url.origin === appOrigin) return null
    if (appOrigin && appOrigin !== 'null') {
      const app = new URL(appOrigin)
      if (['localhost','127.0.0.1','[::1]'].includes(app.hostname) && url.port === app.port) return null
    }
    return url.href
  } catch { return null }
}

/** @param {string} name @param {string} text @param {string} [appOrigin] */
export function readWebPreview(name, text, appOrigin = '') {
  if (!/\.preview\.json$/i.test(name)) return null
  let value
  try { value = JSON.parse(text) } catch { throw new Error('网页预览地址没能读取，请让 CC 更新这份成果。') }
  const url = localPreviewUrl(value?.url, appOrigin)
  if (!url) throw new Error('网页预览需要这台电脑上正在运行的页面地址。')
  return url
}

/** @param {string} url @param {string} name @param {'html'|'web'|'pdf'} kind */
export function renderArtifactFrame(url, name, kind) {
  // Live pages have a separate loopback origin. Saved HTML stays opaque to the app.
  const sandbox = kind === 'web' ? 'allow-scripts allow-same-origin allow-forms' : kind === 'html' ? 'allow-scripts' : ''
  return `<iframe id="wb-preview-frame" data-preview-key="${escape(url)}" src="${escape(url)}" title="${escape(name)}"${sandbox ? ` sandbox="${sandbox}"` : ''} referrerpolicy="no-referrer"></iframe>`
}

/** @typedef {{artifactId:string,html:string,source?:string,url?:string,pdfData?:Uint8Array,kind?:'html'|'web'|'pdf',mode?:'preview'|'source',narrow?:boolean}} ArtifactPreview */
/** @param {{id:string,name:string,size:number,approvedAt:number|null}[]} artifacts
 * @param {{id:string,name:string,size:number,approvedAt:number|null}|undefined} selected
 * @param {ArtifactPreview|null} preview */
export function renderArtifactPanel(artifacts, selected, preview) {
  if (!selected) return ''
  const current = preview?.artifactId === selected.id ? preview : null
  const liveFile = /\.preview\.json$/i.test(selected.name)
  const source = current?.mode === 'source'
  const content = current ? source ? `<pre>${escape(current.source ?? '')}</pre>` : current.html : '<p class="wb-preview-hint" role="status">正在打开成果…</p>'
  return `<aside class="wb-artifact-panel" aria-label="成果预览"><header><label for="wb-artifact-choice">成果</label><select id="wb-artifact-choice" aria-label="选择成果">${artifacts.map(artifact => `<option value="${escape(artifact.id)}"${artifact.id === selected.id ? ' selected' : ''}>${escape(artifactDisplayName(artifact.name))}</option>`).join('')}</select><button type="button" class="wb-new" data-action="back-to-dialogue" aria-label="关闭成果预览">关闭</button></header>
  ${current?.source !== undefined || current?.kind === 'web' ? `<nav class="wb-preview-tools" aria-label="预览工具">${current.source !== undefined ? `<button type="button" class="wb-new" data-action="artifact-preview-mode" aria-pressed="${!source}">预览</button><button type="button" class="wb-new" data-action="artifact-source-mode" aria-pressed="${!!source}">源码</button>` : ''}${!source ? `<button type="button" class="wb-new" data-action="artifact-width" aria-pressed="${!!current.narrow}">窄屏</button>` : ''}${current.kind === 'web' ? '<button type="button" class="wb-new" data-action="refresh-artifact">刷新</button><button type="button" class="wb-new" data-action="open-preview-browser">浏览器打开</button>' : ''}</nav>` : ''}
  <div id="wb-preview" class="wb-preview${current?.narrow && !source ? ' is-narrow' : ''}"><div class="wb-preview-content">${content}</div></div>
  <footer><small>${current?.kind === 'web' ? '运行中的网页 · 内容随项目更新' : liveFile ? '网页预览' : '已保存的成果版本'}</small>${current?.kind === 'web' || liveFile ? '' : `<div><button type="button" class="wb-btn" data-action="download-artifact">下载</button>${selected.approvedAt ? '<span class="wb-approved">已确认此版本</span>' : '<button type="button" class="wb-btn wb-btn-primary" data-action="approve-artifact">确认这份成果</button>'}</div>`}</footer></aside>`
}

/** Keep the browsing context connected while task data and preview controls update.
 * Moving an iframe out of the document destroys its form and JavaScript state.
 * @param {HTMLElement} root @param {string} html */
export function paintWorkbenchWithPreview(root, html) {
  const panel = root.querySelector('.wb-artifact-panel')
  const frame = panel?.querySelector('#wb-preview-frame, .cc-pdf-reader[data-preview-key]')
  const shell = root.querySelector('.workbench-shell')
  if (panel && frame && shell) {
    const template = document.createElement('template')
    template.innerHTML = html
    const nextShell = template.content?.querySelector('.workbench-shell')
    const nextPanel = nextShell?.querySelector('.wb-artifact-panel')
    const nextFrame = nextPanel?.querySelector('#wb-preview-frame, .cc-pdf-reader[data-preview-key]')
    if (nextShell && nextPanel && nextFrame && frame.getAttribute('data-preview-key') === nextFrame.getAttribute('data-preview-key')) {
      shell.className = nextShell.className
      for (const child of Array.from(shell.children)) if (child !== panel) child.remove()
      for (const child of Array.from(nextShell.children)) if (child !== nextPanel) shell.insertBefore(child, panel)
      panel.querySelector('header')?.replaceWith(/** @type {HTMLElement} */ (nextPanel.querySelector('header')))
      panel.querySelector('.wb-preview-tools')?.remove()
      const tools = nextPanel.querySelector('.wb-preview-tools')
      if (tools) panel.querySelector('header')?.after(tools)
      panel.querySelector('footer')?.replaceWith(/** @type {HTMLElement} */ (nextPanel.querySelector('footer')))
      const content = panel.querySelector('#wb-preview')
      if (content) content.className = nextPanel.querySelector('#wb-preview')?.className ?? 'wb-preview'
      return
    }
  }
  root.innerHTML = html
}

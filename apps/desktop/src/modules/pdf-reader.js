// @ts-check
/** One visible page at a time bounds canvas memory, even for long documents. */
/** @param {string} value */
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] ?? c)
/** @type {Promise<typeof import('pdfjs-dist')>|undefined} */
let library
const loadLibrary = () => library ??= import('../vendor/pdfjs/pdf.mjs').then(pdf => {
  pdf.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href
  return /** @type {typeof import('pdfjs-dist')} */ (/** @type {unknown} */ (pdf))
})

/** @param {string} key @param {string} name */
export function renderPdfReader(key, name) {
  return `<section class="cc-pdf-reader" data-preview-key="${escape(key)}" aria-label="${escape(name)}"><p class="cc-pdf-status" role="status">正在打开 PDF…</p></section>`
}

/** @param {HTMLElement} host @param {Uint8Array} bytes @param {string} name
 * @returns {()=>void} */
export function mountPdfReader(host, bytes, name) {
  let alive = true, generation = 0, pageNumber = 1, zoom = 'auto'
  /** @type {import('pdfjs-dist').PDFDocumentProxy|undefined} */ let documentPdf
  /** @type {import('pdfjs-dist').PDFDocumentLoadingTask|undefined} */ let loading
  /** @type {import('pdfjs-dist').RenderTask|undefined} */ let renderTask
  /** @type {import('pdfjs-dist').TextLayer|undefined} */ let textLayer
  /** @type {import('pdfjs-dist').PDFPageProxy|undefined} */ let currentPage
  /** @type {ResizeObserver|undefined} */ let observer
  /** @type {((password:string)=>void)|null} */
  let updatePassword = null
  host.innerHTML = `<nav class="cc-pdf-tools" aria-label="PDF 阅读工具" hidden><button type="button" data-pdf-prev>上一页</button><form data-pdf-page-form><label>页码 <input data-pdf-page type="number" min="1" value="1" inputmode="numeric" aria-label="页码"></label><span data-pdf-count></span></form><button type="button" data-pdf-next>下一页</button><label>缩放 <select data-pdf-zoom aria-label="缩放"><option value="auto">适合宽度</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></nav><p class="cc-pdf-status" role="status">正在打开 PDF…</p><form class="cc-pdf-password" hidden><label>PDF 密码 <input type="password" autocomplete="off" required></label><button type="submit">打开</button></form><div class="cc-pdf-viewport"><div class="cc-pdf-page" hidden><canvas aria-hidden="true"></canvas><div class="cc-pdf-text" role="document"></div></div></div>`
  /** The selectors below refer to the static reader template. @param {string} selector @returns {any} */
  const get = selector => host.querySelector(selector)
  const status = get('.cc-pdf-status'), tools = get('.cc-pdf-tools'), viewport = get('.cc-pdf-viewport'), paper = get('.cc-pdf-page')
  const canvas = get('canvas'), text = get('.cc-pdf-text'), pageInput = get('[data-pdf-page]'), zoomSelect = get('[data-pdf-zoom]')
  const passwordForm = get('.cc-pdf-password'), passwordInput = passwordForm.querySelector('input')
  const showError = () => {
    if (!alive) return
    status.textContent = '这份 PDF 暂时没能显示。可以重新打开，或下载后查看。'
    status.setAttribute('role', 'alert')
    tools.hidden = true; paper.hidden = true; passwordForm.hidden = true
  }
  const render = async () => {
    if (!alive || !documentPdf) return
    const request = ++generation
    renderTask?.cancel(); textLayer?.cancel()
    const previousPage = currentPage
    status.setAttribute('role', 'status'); status.textContent = '正在显示页面…'
    try {
      const page = await documentPdf.getPage(pageNumber)
      if (!alive || request !== generation) return
      currentPage = page
      const normal = page.getViewport({scale:1})
      const scale = zoom === 'auto' ? Math.max(0.1, (viewport.clientWidth - 24) / normal.width) : Number(zoom)
      const view = page.getViewport({scale})
      // Limit the backing bitmap to 16 million pixels. CSS size still follows zoom.
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16000000 / (view.width * view.height)))
      const context = canvas.getContext('2d')
      if (!context) throw Error('canvas_unavailable')
      canvas.width = Math.max(1, Math.floor(view.width * density)); canvas.height = Math.max(1, Math.floor(view.height * density))
      paper.style.width = `${view.width}px`; paper.style.height = `${view.height}px`
      paper.style.setProperty('--total-scale-factor', String(scale))
      canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`
      paper.hidden = false; text.replaceChildren()
      renderTask = page.render({canvas,canvasContext:context,viewport:view,transform:density === 1 ? undefined : [density,0,0,density,0,0],background:'rgb(255,255,255)'})
      await renderTask.promise
      if (!alive || request !== generation) return
      const pdf = await loadLibrary()
      if (!alive || request !== generation) return
      textLayer = new pdf.TextLayer({textContentSource:page.streamTextContent(),container:text,viewport:view})
      await textLayer.render()
      if (!alive || request !== generation) return
      status.textContent = ''
      text.setAttribute('aria-label', `${name}，第 ${pageNumber} 页`)
      pageInput.value = String(pageNumber)
      get('[data-pdf-prev]').disabled = pageNumber <= 1
      get('[data-pdf-next]').disabled = pageNumber >= documentPdf.numPages
      host.dataset.pdfPage = String(pageNumber)
      host.dataset.pdfReady = 'true'
      if (previousPage && previousPage !== page) previousPage.cleanup()
    } catch (error) {
      if (alive && request === generation && !(error instanceof Error && error.name === 'RenderingCancelledException')) showError()
    }
  }
  /** @param {number} value */
  const changePage = value => {
    if (!documentPdf) return
    const next = Math.max(1, Math.min(documentPdf.numPages, Number.isFinite(value) ? Math.round(value) : pageNumber))
    pageInput.value = String(next)
    if (next !== pageNumber) { pageNumber = next; viewport.scrollTop = 0; viewport.scrollLeft = 0; void render() }
  }
  /** @param {MouseEvent} event */
  const onClick = event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button?.hasAttribute('data-pdf-prev')) changePage(pageNumber - 1)
    if (button?.hasAttribute('data-pdf-next')) changePage(pageNumber + 1)
  }
  /** @param {Event} event */
  const onPage = event => { event.preventDefault(); changePage(Number(pageInput.value)) }
  const onZoom = () => { zoom = zoomSelect.value; void render() }
  /** @param {SubmitEvent} event */
  const onPassword = event => {
    event.preventDefault()
    if (!updatePassword) return
    passwordForm.hidden = true; status.textContent = '正在打开 PDF…'
    const value = passwordInput.value; passwordInput.value = ''
    updatePassword(value)
  }
  host.addEventListener('click', onClick)
  get('[data-pdf-page-form]').addEventListener('submit', onPage)
  pageInput.addEventListener('change', onPage)
  zoomSelect.addEventListener('change', onZoom)
  passwordForm.addEventListener('submit', onPassword)
  void (async () => {
    try {
      const pdf = await loadLibrary()
      if (!alive) return
      const assets = new URL('../vendor/pdfjs/', import.meta.url).href
      loading = pdf.getDocument({data:bytes.slice(),cMapUrl:`${assets}cmaps/`,cMapPacked:true,standardFontDataUrl:`${assets}standard_fonts/`,useWorkerFetch:false,useWasm:false,maxImageSize:16000000,canvasMaxAreaInBytes:64000000})
      /** @param {(password:string)=>void} callback @param {number} reason */
      loading.onPassword = (callback, reason) => {
        if (!alive) return
        updatePassword = callback
        status.textContent = reason === pdf.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请再试一次。' : '这份 PDF 需要密码。'
        passwordForm.hidden = false; passwordInput.focus({preventScroll:true})
      }
      documentPdf = await loading.promise
      if (!alive) return
      tools.hidden = false
      get('[data-pdf-count]').textContent = `/ ${documentPdf.numPages}`
      pageInput.max = String(documentPdf.numPages)
      await render()
      if (!alive) return
      let width = viewport.clientWidth
      observer = new ResizeObserver(() => {
        if (zoom === 'auto' && viewport.clientWidth !== width) { width = viewport.clientWidth; void render() }
      })
      observer.observe(viewport)
    } catch { showError() }
  })()
  return () => {
    alive = false; generation++; observer?.disconnect(); renderTask?.cancel(); textLayer?.cancel()
    host.removeEventListener('click', onClick)
    get('[data-pdf-page-form]').removeEventListener('submit', onPage)
    pageInput.removeEventListener('change', onPage); zoomSelect.removeEventListener('change', onZoom)
    passwordForm.removeEventListener('submit', onPassword)
    void loading?.destroy().catch(() => {})
    canvas.width = 0; canvas.height = 0
  }
}

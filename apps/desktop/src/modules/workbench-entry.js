// @ts-check
import { escapeHtml } from '../view.js'

/** @typedef {{path:string,providerId:string}} ProjectChoice */

/** Read project identities from the same list used by the workbench. Selection
 * only prepares a draft; the existing workbench form remains the execution gate.
 * @param {import('./workbench.js').WorkbenchDeps['invokeWorkbenchApi']} invokeWorkbenchApi
 * @returns {Promise<ProjectChoice|null>} */
export async function chooseWorkbenchProject(invokeWorkbenchApi) {
  const list = /** @type {import('./workbench.js').ListResult} */ (await invokeWorkbenchApi('GET', '/v1/workbench'))
  if (!Array.isArray(list.projects)) throw new Error('workbench_projects_unavailable')
  const projects = list.projects
  if (!projects.length) return { path: '', providerId: list.defaultProvider ?? '' }
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'wb-history-dialog wb-handoff-dialog wb-entry-dialog'
    dialog.setAttribute('aria-label', '交给 CC 做')
    dialog.innerHTML = `<form class="wb-entry-form">
      <header class="wb-history-head"><div><h2>在哪个项目里做？</h2><p>选好后，可在一起做中检查要求并开始。</p></div></header>
      <div class="wb-handoff-body"><label for="wb-entry-project">项目</label>
        <select id="wb-entry-project" class="wb-select" autofocus>${projects.map((project, index) => `<option value="${index}">${escapeHtml(project.name)} · ${escapeHtml(project.path)}</option>`).join('')}</select>
      </div>
      <footer class="wb-handoff-footer"><button type="button" class="wb-btn" data-entry-cancel>取消</button><button type="submit" class="wb-btn wb-btn-primary">继续</button></footer>
    </form>`
    document.body.append(dialog)
    let answer = /** @type {ProjectChoice|null} */ (null)
    dialog.addEventListener('close', () => { dialog.remove(); resolve(answer) })
    dialog.querySelector('[data-entry-cancel]')?.addEventListener('click', () => dialog.close())
    dialog.addEventListener('submit', event => {
      event.preventDefault()
      const selected = /** @type {HTMLSelectElement|null} */ (dialog.querySelector('#wb-entry-project'))
      const project = projects[Number(selected?.value)]
      if (!project) return
      const recent = (list.tasks ?? []).filter(task => task.path === project.path).sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
      answer = { path: project.path, providerId: list.projectProviders?.[project.path] ?? recent?.providerId ?? project.providerId ?? list.defaultProvider ?? '' }
      dialog.close()
    })
    try { dialog.showModal() } catch (error) { dialog.remove(); reject(error) }
  })
}

/**
 * mobile-lessons.ts — 手机上看 / 加 / 删项目经验(10-20,接 #443)。路由字面量被
 * scripts/phone-routes.guard.test.ts 扫描,新增 / 改名要同步 PHONE_ROUTES 与 PHONE_API_SCHEMAS。
 *
 * - GET  /m/api/lessons:有经验的项目(目录 id + 名字 + 经验),外加可选的项目(给「加一条」用)。不回路径。
 * - POST /m/api/lessons/add    {project, text}
 * - POST /m/api/lessons/remove {project, id}:按经验 id 删(旧列表按编号会删错)。
 *
 * 只给设备令牌(LINK_EXCLUDED):经验会进每家执行者的指令,写它等于给执行者下令,分享链接不能碰。
 */
import type { ProjectLessons } from '../core/workbench/project-lessons'

export interface MobileLessonsDeps {
  /** 工作台还没接上(daemon 还在启动)⇒ null。 */
  projects(): Array<{ id: string; name: string; path: string }> | null
  lessons: ProjectLessons
}

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const PROJECT = /^p-[a-f0-9]{20}$/

export async function mobileLessonsRoute(deps: MobileLessonsDeps | undefined, url: URL, req: Request): Promise<Response | null> {
  const list = url.pathname === '/m/api/lessons', add = url.pathname === '/m/api/lessons/add', remove = url.pathname === '/m/api/lessons/remove'
  if (!list && !add && !remove) return null
  if (req.method !== (list ? 'GET' : 'POST')) return json({ ok: false, error: 'method_not_allowed' }, 405)
  const projects = deps?.projects() ?? null
  if (!deps || !projects) return json({ ok: false, error: 'lessons_not_wired' }, 503)
  try {
    if (list) {
      const withLessons = projects.map(p => ({ id: p.id, name: p.name, lessons: deps.lessons.list(p.path).map(l => ({ id: l.id, text: l.text })) })).filter(p => p.lessons.length)
      return json({ ok: true, projects: withLessons, choices: projects.map(p => ({ id: p.id, name: p.name })) })
    }
    let body: { project?: unknown; text?: unknown; id?: unknown }
    try { body = await req.json() as typeof body } catch { return json({ ok: false, error: 'bad_request' }, 400) }
    if (typeof body?.project !== 'string' || !PROJECT.test(body.project)) return json({ ok: false, error: 'bad_request' }, 400)
    const p = projects.find(x => x.id === body.project)
    if (!p) return json({ ok: false, error: 'project_not_found' }, 404)
    if (add) {
      if (typeof body.text !== 'string') return json({ ok: false, error: 'bad_request' }, 400)
      const r = deps.lessons.add(p.path, body.text)
      return r.ok ? json({ ok: true, id: r.lesson.id }) : json({ ok: false, error: r.error })
    }
    if (typeof body.id !== 'string' || !/^[a-f0-9]{8}$/.test(body.id)) return json({ ok: false, error: 'not_found' })
    return deps.lessons.removeById(p.path, body.id) ? json({ ok: true }) : json({ ok: false, error: 'not_found' })
  } catch { return json({ ok: false, error: 'unavailable' }, 500) }
}

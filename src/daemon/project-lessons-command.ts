/**
 * 微信「经验 <项目> [一句话 | 删 N]」(第二轮对标 ★2,对标 Devin Knowledge):主人给某个项目写几句经验,
 * 不管哪家执行者来做这个项目都会在指令里看到。只认主人;项目按名字认(不分大小写,重名就问清楚)。
 */
import { LESSONS_MAX, LESSON_MAX_CHARS, type ProjectLessons } from '../core/workbench/project-lessons'
import type { ReplyHandler } from './scheduled-jobs/command'

const RE = /^\s*经验(?:\s+(\S+)(?:\s+([\s\S]+))?)?\s*$/
const USAGE = `项目经验的写法:\n· 经验 <项目> <一句话>(比如「经验 wechat-cc 这个仓库用 bun,不要 npm」)\n· 经验 <项目>(看)· 经验 <项目> 删 <编号>\n每个项目最多 ${LESSONS_MAX} 条,每条一行、${LESSON_MAX_CHARS} 字以内。不管哪家执行者来做这个项目,都会照着做。`

export function makeProjectLessonsCommand(deps: {
  isOwner: (chatId: string) => boolean
  say: (chatId: string, text: string) => Promise<unknown>
  projects: () => Array<{ name: string; path: string }>
  lessons: ProjectLessons
}): ReplyHandler {
  return {
    probe: (text, chatId) => RE.test(text) && deps.isOwner(chatId),
    async handle(text, chatId) {
      const m = RE.exec(text)
      if (!m || !deps.isOwner(chatId)) return false
      const say = (t: string) => deps.say(chatId, t)
      if (!m[1]) { await say(USAGE); return true }
      const name = m[1], rest = m[2]?.trim() ?? ''
      const hits = deps.projects().filter(p => p.name.toLowerCase() === name.toLowerCase())
      if (!hits.length) { await say(`没找到叫 ${name} 的项目。发「任务 项目」看看有哪些。`); return true }
      // 大小写都对得上的那一个优先;还是分不清 ⇒ 问清楚,什么都不写
      const exact = hits.filter(h => h.name === name)
      const p = hits.length === 1 ? hits[0]! : exact.length === 1 ? exact[0]! : null
      if (!p) { await say(`叫 ${name} 的项目有好几个(${hits.map(h => h.name).join('、')}),名字写准一点(大小写要对上)。`); return true }
      if (!rest) {
        const list = deps.lessons.list(p.path)
        await say(list.length ? `${p.name} 的经验:\n${list.map((l, i) => `${i + 1}. ${l.text}`).join('\n')}\n\n「经验 ${p.name} 删 <编号>」删掉一条。` : `${p.name} 还没有经验。\n\n${USAGE}`)
        return true
      }
      const del = /^删\s*(\d{1,2})$/.exec(rest)
      if (del) { await say(deps.lessons.remove(p.path, Number(del[1])) ? `删了。` : `没有第 ${del[1]} 条。`); return true }
      const r = deps.lessons.add(p.path, rest)
      if (r.ok) await say(`记下了:以后不管哪家执行者做 ${p.name},所有执行者都会照这条做 —— ${r.lesson.text}`)
      else await say(r.error === 'duplicate' ? '这条已经记着了。' : r.error === 'full' ? `${p.name} 已经有 ${LESSONS_MAX} 条了,先删一条再加。` : `每条一行、${LESSON_MAX_CHARS} 字以内,不要带尖括号。`)
      return true
    },
  }
}

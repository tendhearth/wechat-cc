/** SessionStart memory: local evidence only, no model calls or production-state reads in the hook. */
import { readFile, realpath, stat, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { hostname } from 'node:os'
import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { renderTopicsBlock, type MatchTopic } from '../../domain/topic-match'
import { toMatchTopic } from '../../daemon/threads/recall'

export interface ProjectIdentity { key: string; roots: string[]; names: string[] }
/** One unreadable/mounted path cannot hold every project row hostage. */
export async function boundedProjectIdentity(identify:typeof projectIdentity,path:string):Promise<ProjectIdentity|null> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([Promise.resolve().then(()=>identify(path)).catch(()=>null),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),250)})])}
  finally{clearTimeout(timer)}
}
interface History { topicId: string; cwd: string }
export interface ProjectMemoryRequest { source: 'claude' | 'codex'; session_id: string; cwd: string }
const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase()
const within = (path: string, root: string) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) }

/** Bounded regular-file reads: don't hang on a repository's FIFO or read a huge config. */
async function smallFile(path: string): Promise<string> {
  const s = await stat(path)
  if (!s.isFile() || s.size > 65536) throw new Error('not_small_file')
  return readFile(path, 'utf8')
}

/** Resolve .git/commondir, including linked worktrees. No wt-* heuristics or git subprocesses. */
export async function projectIdentity(cwd: string): Promise<ProjectIdentity | null> {
  try {
    if (!isAbsolute(cwd)) return null
    let root = await realpath(cwd)
    for (let depth = 0; depth < 64; depth++) {
      const marker = join(root, '.git')
      let gitDir: string | null = null
      try {
        if ((await stat(marker)).isDirectory()) gitDir = marker
        else {
          const match = (await smallFile(marker)).trim().match(/^gitdir: (.+)$/)
          if (match) gitDir = resolve(root, match[1]!)
        }
      } catch { /* no repository at this level */ }
      if (gitDir) {
        let common = gitDir
        try { common = resolve(gitDir, (await smallFile(join(gitDir, 'commondir'))).trim()) } catch { /* main checkout */ }
        common = await realpath(common)
        const roots = new Set([root])
        const names = new Set<string>()
        if (basename(common) === '.git') { roots.add(dirname(common)); names.add(basename(dirname(common))) }
        // Linked worktrees' folder names are arbitrary; only the main repository and remote name identify a project.
        if (gitDir === marker) names.add(basename(root))
        try {
          const cfg = await smallFile(join(common, 'config'))
          const section = cfg.match(/^\s*\[remote\s+"origin"\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m)?.[1]
          const url = section?.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^"|"$/g, '')
          const remote = url?.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:\\]/).pop()?.replace(/\.git$/, '')
          if (remote) names.add(remote)
        } catch { /* a repository name can stand alone */ }
        try {
          for (const w of (await readdir(join(common, 'worktrees'))).slice(0, 128)) {
            try { roots.add(await realpath(dirname((await smallFile(join(common, 'worktrees', w, 'gitdir'))).trim()))) } catch { /* removed worktree */ }
          }
        } catch { /* no linked worktrees */ }
        return { key: common, roots: [...roots], names: [...names].map(norm).filter(Boolean) }
      }
      const parent = dirname(root)
      if (parent === root) break
      root = parent
    }
  } catch { /* cwd missing or unreadable */ }
  return null
}

/** Exactly one candidate across BOTH kinds of evidence, otherwise abstain. */
export function resolveProjectTopic(cwd: string, identity: ProjectIdentity | null, topics: readonly MatchTopic[], history: readonly History[]): { topicId: string | null; reason: string } {
  if (!isAbsolute(cwd)) return { topicId: null, reason: 'invalid_cwd' }
  const names = new Set(identity?.names.map(norm) ?? [])
  const named = topics.filter(t => [t.title, ...t.aliases].some(k => names.has(norm(k)))).map(t => t.id)
  const historical = history.filter(h => isAbsolute(h.cwd) && (identity ? identity.roots.some(r => within(h.cwd, r)) : resolve(cwd) === resolve(h.cwd))).map(h => h.topicId)
  const available = new Set(topics.map(t => t.id))
  const ids = [...new Set([...named, ...historical])].filter(id => available.has(id))
  return ids.length === 1
    ? { topicId: ids[0]!, reason: named.includes(ids[0]!) ? (historical.includes(ids[0]!) ? 'name+history' : 'name') : 'history' }
    : { topicId: null, reason: ids.length > 1 ? 'ambiguous' : 'no_match' }
}

export function renderProjectMemory(topic: MatchTopic): string {
  const header = 'CC 记下的这个项目的近况,可能过时,以仓库为准。\n'
  const block = renderTopicsBlock('', [{ ...topic, summary: '' }], 1200 - [...header].length - 1, { bodies: false, ongoingFirst: true })
  return header + block
}

/** Shared evidence resolver. Provenance is anchored to the original matter project,
 * never to a terminal's later cwd. Name collisions between independent common dirs abstain. */
export function makeProjectTopicResolver(db: Db, owner: string, topics: readonly MatchTopic[], identify = projectIdentity, knownPaths: readonly string[] = [], options: { includeDoneHistory?: boolean } = {}) {
  const rows = db.query<{topicId:string; kind:string; projectPath:string|null; cwd:string|null; turnPaths:string; currentCwd:string|null; project:string|null; repo:string|null; root:string|null},[string,string,string]>(`
    WITH RECURSIVE valid_entry(id,thread_id,depth) AS (
      SELECT id,thread_id,0 FROM topic_entries WHERE status IN ('live','done')
      UNION ALL
      SELECT e.id,e.thread_id,v.depth+1 FROM topic_entries e JOIN valid_entry v ON e.superseded_by=v.id AND e.thread_id=v.thread_id
        WHERE e.status='superseded' AND v.depth<32
    )
    SELECT DISTINCT e.thread_id AS topicId,m.kind,m.project_path AS projectPath,
      (SELECT json_extract(policy_json,'$.cwd') FROM matter_turns WHERE matter_id=m.id ORDER BY seq LIMIT 1) AS cwd,
      (SELECT json_group_array(json_extract(policy_json,'$.cwd')) FROM matter_turns WHERE matter_id=m.id AND json_type(policy_json,'$.cwd')='text') AS turnPaths,c.cwd AS currentCwd,
      wt.project_path AS project,wt.repo_root AS repo,wt.root
    FROM topic_entries e JOIN valid_entry v ON v.id=e.id JOIN threads t ON t.id=e.thread_id
    JOIN matters m ON m.id=e.matter_id
    LEFT JOIN matter_bindings b ON b.matter_id=m.id AND b.surface='cli'
    LEFT JOIN cli_sessions c ON c.session_id=b.surface_key
    LEFT JOIN workbench_worktrees wt ON wt.task_id=m.id
    WHERE t.chat_id=? AND t.private=0 ${options.includeDoneHistory ? '' : "AND t.status!='done'"} AND e.source='work'
      AND ((m.kind='task' AND m.owner_chat_id=t.chat_id) OR (m.kind='terminal'
        AND (m.owner_chat_id IS NULL OR m.owner_chat_id=t.chat_id) AND b.matter_id IS NOT NULL
        AND (c.origin_agent IS NULL OR c.origin_agent='') AND (c.machine IS NULL OR c.machine='' OR c.machine=?)
        AND NOT EXISTS (SELECT 1 FROM matter_turns mt WHERE mt.matter_id=m.id AND (
          COALESCE(json_extract(mt.policy_json,'$.originAgent'),'')!='' OR COALESCE(json_extract(mt.policy_json,'$.machine'),'') NOT IN ('',?)))
        AND (c.session_id IS NOT NULL OR EXISTS(SELECT 1 FROM matter_turns mt WHERE mt.matter_id=m.id AND json_type(mt.policy_json,'$.cwd')='text'))))
  `).all(owner,hostname(),hostname())
  const identities = new Map<string,Promise<ProjectIdentity|null>>()
  const canonical = new Map<string,Promise<string>>()
  const identityOf = (p:string) => {
    if(!identities.has(p))identities.set(p,boundedProjectIdentity(identify,p))
    return identities.get(p)!
  }
  const pathOf = (p:string) => {
    if(!canonical.has(p))canonical.set(p,(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([realpath(p).catch(()=>p),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve(p),250)})])}finally{clearTimeout(timer)}})())
    return canonical.get(p)!
  }
  const pathsOf = (r:typeof rows[number]) => [...new Set((r.kind==='terminal'?[r.projectPath||r.cwd,r.currentCwd,...JSON.parse(r.turnPaths) as string[]]:[r.projectPath,r.project,r.repo,r.root]).filter((p):p is string=>!!p))]
  const known = [...knownPaths,...db.query<{path:string|null},[string,string]>(`
    SELECT project_path AS path FROM matters WHERE owner_chat_id=?1 OR (kind='terminal' AND owner_chat_id IS NULL)
    UNION SELECT cwd FROM cli_sessions WHERE COALESCE(origin_agent,'')='' AND COALESCE(machine,'') IN ('',?2)
  `).all(owner,hostname()).map(r=>r.path).filter((p):p is string=>!!p)]
  const names = new Map<string,Set<string>>()
  const byIdentity = new Map<string,History[]>(), exact = new Map<string,History[]>()
  const ready = (async()=>{
    await Promise.all([...new Set([...known,...rows.flatMap(pathsOf)])].map(async path=>{
      const identity=await identityOf(path)
      if(identity)for(const name of identity.names){const key=norm(name),keys=names.get(key)??new Set<string>();keys.add(identity.key);names.set(key,keys)}
    }))
    await Promise.all(rows.map(async r=>{
      const paths=pathsOf(r), ids=await Promise.all(paths.map(identityOf))
      // Worktree evidence from different repositories must never bridge them.
      if(new Set(ids.filter(i=>!!i).map(i=>i!.key)).size>1 || (r.kind==='terminal'&&paths.length>1&&ids.some(i=>!i)))return
      for(let i=0;i<paths.length;i++){
        const h={topicId:r.topicId,cwd:await pathOf(paths[i]!)},key=ids[i]?.key
        const map=key?byIdentity:exact,bucket=key??h.cwd
        const list=map.get(bucket)??[];list.push(h);map.set(bucket,list)
      }
    }))
  })()
  return async(cwd:string)=>{
    await ready
    const identity=await identityOf(cwd),path=await pathOf(cwd)
    if(identity)for(const name of identity.names){const key=norm(name),keys=names.get(key)??new Set<string>();keys.add(identity.key);names.set(key,keys)}
    const safeIdentity=identity?{...identity,names:identity.names.filter(name=>(names.get(norm(name))?.size??1)<=1)}:null
    return resolveProjectTopic(path,safeIdentity,topics,identity?byIdentity.get(identity.key)??[]:exact.get(path)??[])
  }
}

export function makeProjectMemory(d: { db: Db; config(): { enabled: boolean; owner: string | null }; identity?: typeof projectIdentity; timeoutMs?: number; log(line: string): void }) {
  const threads = makeThreadsStore(d.db, { filterSources: true })
  return async (request: ProjectMemoryRequest): Promise<{ context: string; reason: string }> => {
    const compute = async () => {
      let context = '', reason = 'error', topicId: string | null = null
      try {
        const cfg = d.config()
        if (!cfg.enabled) reason = 'disabled'
        else if (!cfg.owner) reason = 'no_owner'
        else {
          const list = (await threads.list(cfg.owner)).filter(t => !t.private && t.status !== 'done')
          const entries = await threads.entriesByThread(cfg.owner, { live: true })
          const topics = list.map(t => toMatchTopic(t, entries.get(t.id) ?? []))
          const mapped = await makeProjectTopicResolver(d.db, cfg.owner, topics, d.identity)(request.cwd)
          reason = mapped.reason; topicId = mapped.topicId
          const fresh = topicId ? await threads.get(topicId) : null
          const entriesNow = fresh ? await threads.entries(fresh.id, { live: true }) : []
          const topic = fresh && !fresh.private && fresh.chatId === cfg.owner && d.config().owner === cfg.owner && threads.contextAllowed?.(cfg.owner, [fresh], entriesNow.map(e=>e.id)) !== false ? toMatchTopic(fresh, entriesNow) : null
          if (topic?.entries.length) context = renderProjectMemory(topic)
          else if (topic) reason = 'no_live_entries'
        }
      } catch { reason = 'error' }
      return { context, reason, topicId }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        compute(),
        new Promise<{ context: string; reason: string; topicId: string | null }>(resolve => {
          timer = setTimeout(() => resolve({ context: '', reason: 'timeout', topicId: null }), Math.min(d.timeoutMs ?? 400, 400))
        }),
      ])
      d.log(`session=${JSON.stringify(request.session_id)} source=${request.source} topic=${result.topicId ?? '-'} chars=${[...result.context].length} reason=${result.reason}`)
      return { context: result.context, reason: result.reason }
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
}

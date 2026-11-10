/** Task workspaces contain dependency/cache copies, never repository source inputs. */
export const TASK_CACHE_GLOBS = ['**/.cc-tasks/**', '**/node_modules/.cache/cc-tasks/**']

/** Accept native Windows paths as well as git/glob paths; match complete directory segments. */
export function isTaskCachePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return /(^|\/)\.cc-tasks(\/|$)/.test(normalized)
    || /(^|\/)node_modules\/\.cache\/cc-tasks(\/|$)/.test(normalized)
}

export function repositorySourcePaths<T extends string>(paths: readonly T[]): T[] {
  return paths.filter(path => !isTaskCachePath(path))
}

export const TASK_CACHE_GIT_EXCLUDES = TASK_CACHE_GLOBS.map(pattern => `:(exclude,glob)${pattern}`)

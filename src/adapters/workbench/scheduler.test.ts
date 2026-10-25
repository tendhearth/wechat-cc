import { describe, expect, it } from 'vitest'
import { findPathBlocker, pathsConflict, type PathReservation } from './scheduler'

const entry = (taskId:string,path:string,order:number,state:PathReservation['state']='active'):PathReservation => ({
  identity:`run-${taskId}`,taskId,title:`task ${taskId}`,path,order,state,
})

describe('workbench path scheduler', () => {
  it('conflicts only equal and ancestor-descendant canonical paths', () => {
    expect(pathsConflict('/work/project','/work/project')).toBe(true)
    expect(pathsConflict('/work/project','/work/project/child')).toBe(true)
    expect(pathsConflict('/work/project/child','/work/project')).toBe(true)
    expect(pathsConflict('/work/project-a','/work/project-b')).toBe(false)
    expect(pathsConflict('/work/project','/work/project-other')).toBe(false)
  })

  it('uses the earliest conflicting reservation and exposes uncertainty', () => {
    const candidate=entry('candidate','/work/project/child',4)
    expect(findPathBlocker(candidate,[entry('later','/work/project',3),entry('earlier','/work/project',1)]))
      .toEqual({taskId:'earlier',title:'task earlier',reason:'nested_path'})
    expect(findPathBlocker(candidate,[entry('uncertain','/work/project',2,'uncertain')]))
      .toEqual({taskId:'uncertain',title:'task uncertain',reason:'writer_not_closed'})
    expect(findPathBlocker(candidate,[entry('normal','/work/project',1),entry('uncertain','/work/project',3,'uncertain')]))
      .toEqual({taskId:'uncertain',title:'task uncertain',reason:'writer_not_closed'})
  })
})

import { expect, it } from 'vitest'
import { DependencyBackground, dependencyBackground, startDependencyBackground } from './worktree-dependency-background'
it('serializes distinct keys, deduplicates a repository key and drops queued work on stop', async () => {
  const lines:string[]=[],worker=new DependencyBackground(line=>lines.push(line)),ran:string[]=[]
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  expect(worker.enqueue('repo-key',async()=>{ran.push('first');await gate})).toBe(true)
  expect(worker.enqueue('repo-key',async()=>{ran.push('duplicate')})).toBe(false)
  expect(worker.enqueue('other-key',async()=>{ran.push('second')})).toBe(true)
  await Promise.resolve();expect(ran).toEqual(['first'])
  const stopped=worker.stop();release();await stopped
  expect(ran).toEqual(['first'])
  expect(worker.enqueue('third',async()=>{})).toBe(false)
  expect(lines.filter(line=>line.startsWith('start '))).toEqual(['start repo-key'])
})
it('attaches the daemon logger to a worker created during early task preparation', async () => {
  const state='test-early-background-logger',early=dependencyBackground(state),lines:string[]=[]
  const worker=startDependencyBackground(state,line=>lines.push(line))
  expect(worker).toBe(early)
  worker.enqueue('key',async()=>{throw Error('offline reason')});await worker.drain();await worker.stop()
  expect(lines).toEqual(['start key','failed key: offline reason'])
})

it('runs distinct repository keys serially and continues after a failed install', async () => {
  const worker=new DependencyBackground(),ran:string[]=[]
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  worker.enqueue('repo-a',async()=>{ran.push('a');await gate;throw Error('offline')})
  worker.enqueue('repo-b',async()=>{ran.push('b')})
  await Promise.resolve();expect(ran).toEqual(['a'])
  release();await worker.drain();expect(ran).toEqual(['a','b']);await worker.stop()
})

import { describe, it, expect, vi } from 'vitest'
import { createPetStateMachine } from './state-machine.js'
import { BEHAVIORS, PRIORITY, ONE_SHOT, PROPS, isBehavior } from './types.js'

describe('types', () => {
  it('13 个行为、优先级表覆盖全部行为 + transition、一次性集合是那 7 个', () => {
    expect(BEHAVIORS).toHaveLength(13)
    for (const b of BEHAVIORS) expect(PRIORITY[b]).toBeTypeOf('number')
    expect(PRIORITY.transition).toBe(80)
    expect([...ONE_SHOT].sort()).toEqual(['blink', 'done', 'drag', 'error', 'look', 'receive', 'wake'])
    expect(PROPS).toHaveLength(8)
    expect(isBehavior('working')).toBe(true); expect(isBehavior('paint')).toBe(false)
  })
})

describe('createPetStateMachine', () => {
  it('初始 unlit / idle / 无转场 / 无道具;setState 持续行为直接生效并成为 resting', () => {
    const m = createPetStateMachine()
    expect(m.snapshot()).toEqual({ form: 'unlit', behavior: 'idle', transition: null, targetForm: null, resting: 'idle', props: [], badge: 0 })
    expect(m.setState('working')).toBe('applied')
    expect(m.snapshot().behavior).toBe('working'); expect(m.snapshot().resting).toBe('working')
  })
  it('一次性行为播完回落到 resting;播放中更低优先级的持续行为只 queued', () => {
    const m = createPetStateMachine()
    m.setState('working')
    expect(m.setState('done')).toBe('applied')          // done 60 > working 50
    expect(m.snapshot().behavior).toBe('done')
    expect(m.setState('thinking')).toBe('queued')       // thinking 50 < done 60
    expect(m.snapshot().behavior).toBe('done'); expect(m.snapshot().resting).toBe('thinking')
    m.notifyAnimationEnded()
    expect(m.snapshot().behavior).toBe('thinking')
  })
  it('更高优先级的持续行为打断一次性行为;permission 打断一切', () => {
    const m = createPetStateMachine()
    m.setState('blink')                                  // 20
    expect(m.setState('working')).toBe('applied')        // 50 ≥ 20 → 打断
    expect(m.snapshot().behavior).toBe('working')
    m.setState('error')                                  // 70
    expect(m.setState('permission')).toBe('applied')     // 100
    expect(m.snapshot().behavior).toBe('permission')
  })
  it('一次性行为之间:正在播更高的 → ignored;更低的被打断', () => {
    const m = createPetStateMachine()
    m.setState('done')                                   // 60
    expect(m.setState('blink')).toBe('ignored')          // 20 < 60
    expect(m.setState('error')).toBe('applied')          // 70 > 60
    expect(m.snapshot().behavior).toBe('error')
    expect(m.setState('nope')).toBe('ignored')
  })
  it('setForm 开始转场;转场中一次性行为 ignored、持续行为 queued;播完 form 切换并回落到 resting', () => {
    const m = createPetStateMachine()
    m.setState('working')
    expect(m.setForm('lit')).toBe(true)
    expect(m.snapshot()).toMatchObject({ form: 'unlit', transition: 'unlit-to-lit', targetForm: 'lit', behavior: 'working' })
    expect(m.setForm('lit')).toBe(false)                 // 已在往 lit 转
    expect(m.setState('blink')).toBe('ignored')
    expect(m.setState('thinking')).toBe('queued')
    m.notifyAnimationEnded()
    expect(m.snapshot()).toMatchObject({ form: 'lit', transition: null, targetForm: null, behavior: 'thinking', resting: 'thinking' })
    expect(m.setForm('lit')).toBe(false)                 // 已是 lit
    expect(m.setForm('unlit')).toBe(true)
    expect(m.snapshot().transition).toBe('lit-to-unlit')
  })
  it('转场中要求回原态 → 直接结束当前转场,不再转;permission 打断转场并把 form 跳到目标', () => {
    const m = createPetStateMachine()
    m.setForm('lit')
    expect(m.setForm('unlit')).toBe(false)
    expect(m.snapshot()).toMatchObject({ form: 'unlit', transition: null })
    m.setForm('lit')
    expect(m.setState('permission')).toBe('applied')
    expect(m.snapshot()).toMatchObject({ form: 'lit', transition: null, behavior: 'permission' })
  })
  it('拖动:beginDrag 进 drag(打断转场并跳到目标 form),期间持续行为只记 resting,endDrag 回落', () => {
    const m = createPetStateMachine()
    m.setForm('lit')
    m.beginDrag()
    expect(m.snapshot()).toMatchObject({ form: 'lit', transition: null, behavior: 'drag' })
    expect(m.setState('working')).toBe('queued')
    expect(m.setState('blink')).toBe('ignored')
    m.endDrag()
    expect(m.snapshot().behavior).toBe('working')
  })
  it('setState("drag") 永远 ignored——drag 只经 beginDrag/endDrag 进出', () => {
    const m = createPetStateMachine()
    expect(m.setState('drag')).toBe('ignored')
    m.beginDrag()
    expect(m.setState('drag')).toBe('ignored')
  })
  it('拖动压过转场:期间 setForm 只记 pendingForm 不开转场,notifyAnimationEnded 是 no-op,endDrag 后才真正开转场', () => {
    const m = createPetStateMachine()
    m.beginDrag()
    expect(m.setForm('lit')).toBe(false)
    expect(m.snapshot()).toMatchObject({ form: 'unlit', transition: null, targetForm: null, behavior: 'drag' })
    m.notifyAnimationEnded()
    expect(m.snapshot().behavior).toBe('drag')
    m.endDrag()
    expect(m.snapshot()).toMatchObject({ behavior: 'idle', transition: 'unlit-to-lit', targetForm: 'lit' })
    m.notifyAnimationEnded()
    expect(m.snapshot().form).toBe('lit')
  })
  it('拖动中 setForm 又改回原态 → pendingForm 清空,endDrag 后不转场', () => {
    const m = createPetStateMachine()
    m.beginDrag()
    m.setForm('lit')
    m.setForm('unlit')
    m.endDrag()
    expect(m.snapshot()).toMatchObject({ form: 'unlit', transition: null, targetForm: null })
  })
  it('setProps 过滤未知、去重、badge 非负整数;只在变化时通知', () => {
    const m = createPetStateMachine()
    const cb = vi.fn()
    m.subscribe(cb)
    m.setProps(['envelope', 'nope', 'envelope', 'mug'], 3.7)
    expect(m.snapshot().props).toEqual(['envelope', 'mug']); expect(m.snapshot().badge).toBe(3)
    expect(cb).toHaveBeenCalledTimes(1)
    m.setProps(['envelope', 'mug'], 3)
    expect(cb).toHaveBeenCalledTimes(1)                  // 没变,不通知
    m.setProps([], -2)
    expect(m.snapshot()).toMatchObject({ props: [], badge: 0 })
    expect(cb).toHaveBeenCalledTimes(2)
  })
  it('订阅者收到的是快照拷贝;退订后不再收', () => {
    const m = createPetStateMachine({ initialForm: 'lit' })
    const seen: unknown[] = []
    const off = m.subscribe(s => seen.push(s))
    m.setState('working')
    ;(seen[0] as { props: string[] }).props.push('x')
    expect(m.snapshot().props).toEqual([])
    off()
    m.setState('idle')
    expect(seen).toHaveLength(1)
    expect(m.snapshot().form).toBe('lit')
  })
})

import { describe, expect, it, vi } from 'vitest'

class FakeClassList {
  values = new Set<string>()
  toggle(name:string,force?:boolean) {
    const add=force===undefined?!this.values.has(name):force
    if(add)this.values.add(name);else this.values.delete(name)
    return add
  }
  contains(name:string) { return this.values.has(name) }
}

class FakeElement {
  classList=new FakeClassList()
  hidden=false
  inert=false
  attrs=new Map<string,string>()
  listeners=new Map<string,Set<(event:any)=>void>>()
  focus=vi.fn()
  focusTarget:FakeElement|null=null
  selectorTargets=new Map<string,FakeElement|null>()
  addEventListener(name:string,listener:(event:any)=>void) { const listeners=this.listeners.get(name)??new Set();listeners.add(listener);this.listeners.set(name,listeners) }
  removeEventListener(name:string,listener:(event:any)=>void) { this.listeners.get(name)?.delete(listener) }
  dispatch(name:string,event:any={}) { for(const listener of this.listeners.get(name)??[])listener(event) }
  setAttribute(name:string,value:string) { this.attrs.set(name,value) }
  removeAttribute(name:string) { this.attrs.delete(name) }
  getAttribute(name:string) { return this.attrs.get(name)??null }
  querySelector(selector:string) { return this.selectorTargets.has(selector)?this.selectorTargets.get(selector)??null:this.focusTarget }
}

describe('workbench global navigation', () => {
  it('moves focus into the workbench once on initial entry without stealing it on repeat syncs', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement()
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})

    navigation.setWorkbenchActive(true)
    expect(toggle.focus).toHaveBeenCalledOnce()
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})

    toggle.focus.mockClear()
    navigation.setWorkbenchActive(true)
    expect(toggle.focus).not.toHaveBeenCalled()
  })

  it('keeps the global rail inert until the compact workbench navigation is opened', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement(),activeLink=new FakeElement()
    rail.focusTarget=activeLink
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})

    navigation.setWorkbenchActive(true)
    expect(shell.classList.contains('is-workbench-focused')).toBe(true)
    expect(rail.inert).toBe(true)
    expect(rail.getAttribute('aria-hidden')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(scrim.hidden).toBe(false)

    toggle.dispatch('click')
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(true)
    expect(rail.inert).toBe(false)
    expect(rail.getAttribute('aria-hidden')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(scrim.hidden).toBe(false)
    expect(activeLink.focus).toHaveBeenCalledWith({preventScroll:true})

    toggle.focus.mockClear()
    documentTarget.dispatch('keydown',{key:'Escape',preventDefault:vi.fn()})
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(false)
    expect(rail.inert).toBe(true)
    expect(rail.getAttribute('aria-hidden')).toBe('true')
    expect(scrim.hidden).toBe(false)
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})
  })

  it('focuses the active navigation item before an earlier enabled fallback', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement(),firstEnabled=new FakeElement(),activeLink=new FakeElement()
    rail.selectorTargets.set('.dash-nav-link.active:not(.disabled), .dash-nav-link:not(.disabled)',firstEnabled)
    rail.selectorTargets.set('.dash-nav-link.active:not(.disabled)',activeLink)
    rail.selectorTargets.set('.dash-nav-link:not(.disabled)',firstEnabled)
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')
    expect(activeLink.focus).toHaveBeenCalledWith({preventScroll:true})
    expect(firstEnabled.focus).not.toHaveBeenCalled()
  })

  it('falls back to the first enabled item when the rail has no active item', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement(),firstEnabled=new FakeElement()
    rail.selectorTargets.set('.dash-nav-link.active:not(.disabled)',null)
    rail.selectorTargets.set('.dash-nav-link:not(.disabled)',firstEnabled)
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')
    expect(firstEnabled.focus).toHaveBeenCalledWith({preventScroll:true})
  })

  it('closes on the outside scrim and restores the persistent rail after leaving workbench', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement()
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')
    toggle.focus.mockClear()
    scrim.dispatch('click')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rail.inert).toBe(true)
    expect(rail.getAttribute('aria-hidden')).toBe('true')
    expect(scrim.hidden).toBe(false)
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})

    navigation.setWorkbenchActive(false)
    expect(shell.classList.contains('is-workbench-focused')).toBe(false)
    expect(rail.inert).toBe(false)
    expect(rail.getAttribute('aria-hidden')).toBeNull()
    expect(scrim.hidden).toBe(true)
  })

  it('keeps rapid toggles synchronous so the CSS transition can reverse', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement(),activeLink=new FakeElement()
    rail.selectorTargets.set('.dash-nav-link.active:not(.disabled)',activeLink)
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click');toggle.dispatch('click');toggle.dispatch('click')
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(rail.inert).toBe(false)
    expect(scrim.hidden).toBe(false)
    toggle.focus.mockClear()
    toggle.dispatch('click')
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rail.inert).toBe(true)
    expect(scrim.hidden).toBe(false)
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})
  })

  it('leaves the navigation open when an inner layer already handled Escape', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement()
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')
    toggle.focus.mockClear()

    const handledPreventDefault=vi.fn()
    documentTarget.dispatch('keydown',{key:'Escape',defaultPrevented:true,preventDefault:handledPreventDefault})
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(rail.inert).toBe(false)
    expect(handledPreventDefault).not.toHaveBeenCalled()
    expect(toggle.focus).not.toHaveBeenCalled()

    const preventDefault=vi.fn()
    documentTarget.dispatch('keydown',{key:'Escape',defaultPrevented:false,preventDefault})
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(false)
    expect(rail.inert).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})
  })

  it('closes and returns focus when workbench is selected again from its open navigation', async () => {
    const { createWorkbenchNavigation, isCurrentWorkbenchPane }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement()
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')
    toggle.focus.mockClear()

    expect(isCurrentWorkbenchPane('workbench',{hidden:false,dataset:{pane:'workbench'}} as any)).toBe(true)
    navigation.setWorkbenchActive(true)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rail.inert).toBe(true)
    expect(scrim.hidden).toBe(false)
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})
  })
})

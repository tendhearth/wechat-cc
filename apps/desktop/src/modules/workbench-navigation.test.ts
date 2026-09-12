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
  addEventListener(name:string,listener:(event:any)=>void) { const listeners=this.listeners.get(name)??new Set();listeners.add(listener);this.listeners.set(name,listeners) }
  removeEventListener(name:string,listener:(event:any)=>void) { this.listeners.get(name)?.delete(listener) }
  dispatch(name:string,event:any={}) { for(const listener of this.listeners.get(name)??[])listener(event) }
  setAttribute(name:string,value:string) { this.attrs.set(name,value) }
  removeAttribute(name:string) { this.attrs.delete(name) }
  getAttribute(name:string) { return this.attrs.get(name)??null }
  querySelector() { return this.focusTarget }
}

describe('workbench global navigation', () => {
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

    toggle.dispatch('click')
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(true)
    expect(rail.inert).toBe(false)
    expect(rail.getAttribute('aria-hidden')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(scrim.hidden).toBe(false)
    expect(activeLink.focus).toHaveBeenCalledWith({preventScroll:true})

    documentTarget.dispatch('keydown',{key:'Escape',preventDefault:vi.fn()})
    expect(shell.classList.contains('is-workbench-nav-open')).toBe(false)
    expect(rail.inert).toBe(true)
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})
  })

  it('closes on the outside scrim and restores the persistent rail after leaving workbench', async () => {
    const { createWorkbenchNavigation }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement()
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')
    scrim.dispatch('click')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})

    navigation.setWorkbenchActive(false)
    expect(shell.classList.contains('is-workbench-focused')).toBe(false)
    expect(rail.inert).toBe(false)
    expect(rail.getAttribute('aria-hidden')).toBeNull()
    expect(scrim.hidden).toBe(true)
  })

  it('closes and returns focus when workbench is selected again from its open navigation', async () => {
    const { createWorkbenchNavigation, isCurrentWorkbenchPane }=await import('./workbench-navigation.js')
    const documentTarget=new FakeElement()
    const shell=new FakeElement(),rail=new FakeElement(),toggle=new FakeElement(),scrim=new FakeElement()
    const navigation=createWorkbenchNavigation({shell:shell as any,rail:rail as any,toggle:toggle as any,scrim:scrim as any,documentTarget:documentTarget as any})
    navigation.setWorkbenchActive(true)
    toggle.dispatch('click')

    expect(isCurrentWorkbenchPane('workbench',{hidden:false,dataset:{pane:'workbench'}} as any)).toBe(true)
    navigation.setWorkbenchActive(true)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.focus).toHaveBeenCalledWith({preventScroll:true})
  })
})

// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { color, componentAppearance as contract, typeScale } from '@wechat-cc/design-tokens'
import { STATUS_KEYS, STATUS_WORDS } from '@wechat-cc/protocol'
import { cleanup, host, mount, resetHost } from './native-motion.test-support'
import { withLang } from '../state/providers.test-support'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { TextField } from './TextField'
import { StatusPill } from './StatusPill'
import {taskDetailLabel,statusOf} from '../view/status'
vi.mock('react-native', async () => {
  const { forwardRef } = await import('react')
  return { ...(await import('./native-motion.test-support')).nativeBoundary(), ActivityIndicator: ({color}: {color:string}) => createElement('i', {'data-busy-color':color}),
    TextInput: forwardRef<any, any>(({ style, testID, onFocus, onBlur, editable, value, onChangeText }: any, ref) => createElement('textarea', { ref, 'data-testid': testID,
      'data-style': JSON.stringify(Object.assign({}, ...style)), disabled: editable === false, value, onInput: (e: any) => onChangeText?.(e.currentTarget.value), onFocus, onBlur })) }
})
vi.mock('expo-router', async () => (await import('./native-motion.test-support')).routerBoundary())
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
const localized = (node: ReactNode, opts?: {lang:'en'|'zh-Hans'}) => withLang(opts?.lang ?? 'en', node)
afterEach(async () => { await cleanup(); resetHost() })
it('renders phone button roles, targets and disabled/pressed states from the common contract', async () => {
  const press = vi.fn(), ui = await mount(localized(createElement(Button, { kind:'primary', label:'Send', testID:'button', onPress:press }), { lang:'en' }))
  expect(ui.style('button')).toMatchObject({ minHeight:48, borderRadius:28, paddingHorizontal:contract.button.paddingX.phone, backgroundColor:color.accent, borderColor:color.accent })
  expect(JSON.parse(ui.byId('button').querySelector('span')!.getAttribute('data-style')!).fontSize).toBe(typeScale[contract.button.role.phone].phone)
  host.pressed=true
  await ui.render(localized(createElement(Button, { kind:'secondary', label:'Back', testID:'button', onPress:press })))
  expect(ui.style('button')).toMatchObject({ opacity:contract.button.pressedOpacity, backgroundColor:'transparent', borderColor:color.hair })
  await ui.render(localized(createElement(Button, { kind:'secondary', label:'Back', testID:'button', disabled:true, onPress:press })))
  expect(ui.style('button').opacity).toBe(contract.button.disabledOpacity)
  await act(() => ui.byId('button').click()); expect(press).not.toHaveBeenCalled()
  await ui.render(localized(createElement(IconButton, { name:'search', label:'Search', testID:'icon', onPress:press })))
  expect(ui.style('icon')).toMatchObject({ minWidth:44, minHeight:44 })
})
it('keeps chat/search/comment variants distinct and preserves focus/change callbacks', async () => {
  const focus=vi.fn(), blur=vi.fn(), change=vi.fn()
  const ui=await mount(localized(createElement(TextField, { variant:'chat', testID:'field', onFocus:focus, onBlur:blur, onChangeText:change })))
  expect(ui.style('field')).toMatchObject({ borderRadius:14, minHeight:48, borderWidth:1, paddingHorizontal:16, paddingVertical:12, borderColor:color.hair })
  await act(() => ui.byId('field').focus())
  expect(focus).toHaveBeenCalledOnce(); expect(ui.style('field').borderColor).toBe(color.accent)
  await act(() => ui.byId('field').blur()); expect(blur).toHaveBeenCalledOnce()
  await act(() => { (ui.byId('field') as HTMLTextAreaElement).value='draft'; ui.byId('field').dispatchEvent(new Event('input',{bubbles:true})) })
  expect(change).toHaveBeenCalledWith('draft')
  await ui.render(localized(createElement(TextField, { variant:'search', testID:'field' })))
  expect(ui.style('field')).toMatchObject({ borderRadius:28, minHeight:44 })
  await ui.render(localized(createElement(TextField, { variant:'comment', testID:'field' })))
  expect(ui.style('field')).toMatchObject({ borderRadius:0, borderWidth:0, borderBottomWidth:1, backgroundColor:'transparent' })
})
it.each(STATUS_KEYS)('detail %s uses the shared glyph and word rather than a second dot table', async status => {
  const ui=await mount(localized(createElement(StatusPill, { status }), { lang:'en' }))
  expect(ui.container.textContent).toBe(STATUS_WORDS.en[status])
  expect(JSON.parse(ui.container.querySelector('span')!.getAttribute('data-style')!).color).toBe(color.inkSoft)
  expect(ui.container.querySelectorAll('img')).toHaveLength(status==='working'?0:1)
})

it.each(['primary','secondary'] as const)('button %s text and busy indicator follow a changed contract text tone',async kind=>{
 const appearance=contract.button[kind] as {text:keyof typeof color}
 const original=appearance.text
 appearance.text=kind==='primary'?'bad':'accent'
 try {
  const ui=await mount(localized(createElement(Button,{kind,label:'Save',onPress:()=>{},busy:true,testID:'button'})))
  const textStyle=JSON.parse(ui.byId('button').querySelector('span')!.getAttribute('data-style')!)
  expect(textStyle.color).toBe(color[appearance.text])
  expect(ui.byId('button').querySelector('i')!.getAttribute('data-busy-color')).toBe(color[appearance.text])
 } finally {appearance.text=original}
})

it.each(['en','zh-Hans'] as const)('detail labels consume shared task observations while retaining canonical glyphs: %s',async lang=>{
 for(const task of [{status:'queued',phase:'queued'},{status:'cancelling',phase:'working'},{status:'running',phase:'working',networkSuspended:{since:1}}]){
  const label=taskDetailLabel(task,0,lang)
  const ui=await mount(localized(createElement(StatusPill,{status:statusOf(task,0),label}),{lang}))
  expect(ui.container.textContent).toBe(label)
  expect(ui.container.querySelectorAll('img')).toHaveLength(0)
  await cleanup()
 }
})

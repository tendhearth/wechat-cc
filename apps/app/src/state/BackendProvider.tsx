import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Backend } from '../backend/types'
import type { Lang } from '../i18n'
import { makeDemoBackend } from '../backend/demo'
import { makeStore, type Store } from './store'

type Ctx = { backend: Backend; store: Store }
const BackendCtx = createContext<Ctx | null>(null)

// v1 只有演示后端;下一份计划在这里切换真后端。
// lang 只给演示后端用(示例任务的标题与说明跟界面同一种语言);换语言会重建演示数据。
export function BackendProvider({ children, backend, lang }: { children: ReactNode; backend?: Backend; lang?: Lang }) {
  const value = useMemo<Ctx>(() => {
    const b = backend ?? makeDemoBackend({ lang })
    return { backend: b, store: makeStore(b) }
  }, [backend, lang])
  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}

export function useBackendCtx(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('BackendProvider missing')
  return c
}

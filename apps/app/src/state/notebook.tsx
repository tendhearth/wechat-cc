import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { Backend } from '../backend/types'
import { clearNotebookStorage } from '../net/notebook-storage'
import { useBackendCtx } from './BackendProvider'
import { makeNotebook } from './notebook-store'

let activeBackend: Backend | undefined
const notebooks = new WeakMap<Backend, ReturnType<typeof makeNotebook>>()

export function NotebookCache() {
  const { backend, inputScope } = useBackendCtx()
  useLayoutEffect(() => {
    activeBackend = backend
    if (backend.mode === 'demo') void clearNotebookStorage(() => activeBackend === backend).catch(() => {})
    if (!notebooks.has(backend)) notebooks.set(backend, makeNotebook(backend, inputScope, () => backend === activeBackend))
    return () => { if (activeBackend === backend) activeBackend = undefined }
  }, [backend, inputScope])
  return null
}

export function useNotebook() {
  const { backend, inputScope } = useBackendCtx()
  const notebook = useMemo(() => {
    const known = notebooks.get(backend)
    if (known) return known
    const created = makeNotebook(backend, inputScope, () => backend === activeBackend)
    notebooks.set(backend, created)
    return created
  }, [backend, inputScope])
  return { notebook, value: useSyncExternalStore(notebook.subscribe, notebook.getSnapshot, notebook.getSnapshot) }
}

// @ts-check
// 浮窗的状态接线:点道具 → 让主窗口露面并切到觅食台(Task 10 的 tauri 命令)。
import { invoke } from './ipc.js'
import { startCompanionPresence } from './companion-presence.js'

startCompanionPresence({
  onOpenJournal: () => { invoke('show_main_window', { page: 'a2a-agents' }).catch(err => console.warn('show_main_window failed', err)) },
})

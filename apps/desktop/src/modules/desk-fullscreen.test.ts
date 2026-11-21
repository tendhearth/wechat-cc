import { expect, it, vi } from 'vitest'
import { watchDeskFullscreen } from './desk-fullscreen.js'

it('无原生窗口时不写状态', () => {
  const reflect = vi.fn()
  watchDeskFullscreen(undefined, reflect)()
  expect(reflect).not.toHaveBeenCalled()
})

it('初次读取，尺寸变化重读，失败回到普通窗口，清理订阅', async () => {
  const reflect = vi.fn(), unlisten = vi.fn()
  const isFullscreen = vi.fn<() => Promise<boolean>>()
    .mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockRejectedValueOnce(Error('unavailable'))
  let resize = () => {}
  const stop = watchDeskFullscreen({ isFullscreen, onResized: async read => { resize = read; return unlisten } }, reflect)
  await vi.waitFor(() => expect(reflect).toHaveBeenLastCalledWith(false))
  resize()
  await vi.waitFor(() => expect(reflect).toHaveBeenLastCalledWith(true))
  resize()
  await vi.waitFor(() => expect(reflect).toHaveBeenLastCalledWith(false))
  expect(isFullscreen).toHaveBeenCalledTimes(3)
  stop()
  expect(unlisten).toHaveBeenCalledOnce()
})

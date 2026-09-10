// @ts-check
/** Trim individual parts, or share one square crop across animation frames.
 * @param {string} source
 * @param {HTMLImageElement[]} targets
 * @param {boolean} aligned
 */
export async function loadAquariumAtlas(source, targets, aligned = false) {
  const atlas = new Image()
  atlas.src = source
  await atlas.decode()
  const cellWidth = Math.floor(atlas.naturalWidth / targets.length)
  const cellHeight = atlas.naturalHeight
  const cells = targets.map((_, index) => {
    const cell = document.createElement('canvas')
    cell.width = cellWidth; cell.height = cellHeight
    const context = cell.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(atlas, index * cellWidth, 0, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight)
    const rgba = context.getImageData(0, 0, cellWidth, cellHeight).data
    let left = cellWidth, top = cellHeight, right = -1, bottom = -1
    // Ignore the 4px atlas gutter; it is not part of any sprite.
    for (let y = 4; y < cellHeight - 4; y++) for (let x = 4; x < cellWidth - 4; x++) {
      if (rgba[(y * cellWidth + x) * 4 + 3] > 8) {
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    if (right < left) throw new Error(`Empty aquarium atlas cell ${index}`)
    return { cell, left, top, right, bottom }
  })
  const union = {
    left: Math.min(...cells.map(c => c.left)), right: Math.max(...cells.map(c => c.right)),
    top: Math.min(...cells.map(c => c.top)), bottom: Math.max(...cells.map(c => c.bottom)),
  }
  await Promise.all(cells.map(async (part, index) => {
    const bounds = aligned ? union : part
    const width = bounds.right - bounds.left + 1, height = bounds.bottom - bounds.top + 1
    const crop = document.createElement('canvas')
    crop.width = aligned ? Math.max(width, height) : width
    crop.height = aligned ? crop.width : height
    crop.getContext('2d')?.drawImage(part.cell, bounds.left, bounds.top, width, height,
      (crop.width - width) / 2, (crop.height - height) / 2, width, height)
    targets[index].src = crop.toDataURL()
    await targets[index].decode()
  }))
}

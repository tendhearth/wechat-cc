/** Rebuild app icons from the small, editable CC vector mark. */
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const art = resolve(desktop, 'art/cc-brand')
const mark = await readFile(resolve(desktop, 'src/assets/brand/cc-mark.svg'), 'utf8')
const path = mark.match(/<path\b[\s\S]*?\/>/)?.[0]
if (!path) throw new Error('CC mark must contain its compound silhouette path')
await mkdir(art, { recursive: true })
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>CC app icon</title>
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0.8" y2="1">
      <stop stop-color="#fffdf7"/>
      <stop offset="1" stop-color="#eee6d7"/>
    </linearGradient>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="104" fill="url(#paper)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="103.5" fill="none" stroke="#ddd5c8"/>
  <g transform="translate(0 -26)" fill="#353731">${path}</g>
</svg>
`
const source = resolve(art, 'app-icon.svg')
await writeFile(source, appIcon)

const result = Bun.spawn(['bun', 'run', 'tauri', 'icon', source, '--ios-color', '#f8f4ea'], {
  cwd: desktop, stdout: 'inherit', stderr: 'inherit',
})
if (await result.exited !== 0) throw new Error('Tauri icon generation failed')
// Mobile launchers apply their own masks. Use a full-bleed background there,
// and a separate Android foreground instead of putting a tile inside a tile.
await writeFile(resolve(art, 'app-icon-mobile.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#f8f4ea"/><g transform="translate(0 -26)" fill="#353731">${path}</g></svg>\n`)
await writeFile(resolve(art, 'app-icon-foreground.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><g transform="translate(0 -26)" fill="#353731">${path}</g></svg>\n`)
await writeFile(resolve(art, 'mobile-icons.json'), JSON.stringify({
  default: 'app-icon-mobile.svg', bg_color: '#f8f4ea',
  android_fg: 'app-icon-foreground.svg', android_fg_scale: 85,
  android_monochrome: 'app-icon-foreground.svg',
}, null, 2) + '\n')
const mobileOutput = await mkdtemp(resolve(tmpdir(), 'cc-mobile-icons-'))
try {
  const mobile = Bun.spawn(['bun', 'run', 'tauri', 'icon', resolve(art, 'mobile-icons.json'), '--output', mobileOutput], {
    cwd: desktop, stdout: 'inherit', stderr: 'inherit',
  })
  if (await mobile.exited !== 0) throw new Error('Mobile icon generation failed')
  for (const platform of ['ios', 'android']) {
    await cp(resolve(mobileOutput, platform), resolve(desktop, 'src-tauri/icons', platform), { recursive: true })
  }
} finally {
  await rm(mobileOutput, { recursive: true, force: true })
}
// Existing runtime and packaging consumers retain their stable paths.
await copyFile(resolve(desktop, 'src-tauri/icons/128x128@2x.png'), resolve(desktop, 'src/wechat-cc-logo.png'))
await copyFile(resolve(desktop, 'src-tauri/icons/icon.png'), resolve(desktop, 'wechat-cc-logo.png'))
console.log('CC app icons and runtime logo rebuilt from cc-mark.svg')

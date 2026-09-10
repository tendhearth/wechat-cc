// Stage the QA-only frontend outside production frontendDist. No sidecar or board files.
import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const qa = join(desktop, 'art/cc-v1/native-qa')
/** @param {string} destination */
export function prepareNativeQA(destination = join(qa, 'dist')) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const name of ['cc-native-qa.html', 'cc-native-qa.css', 'cc-native-qa.js']) cpSync(join(qa, name), join(destination, name))
  cpSync(join(desktop, 'src/companion-window.css'), join(destination, 'companion-window.css'))
  cpSync(join(desktop, 'src/pet'), join(destination, 'pet'), {
    recursive: true, filter: path => statSync(path).isDirectory() || path.endsWith('.js'),
  })
  cpSync(join(desktop, 'src/assets/pet'), join(destination, 'assets/pet'), {
    recursive: true,
    filter: path => !['CC_MASTER_V1.png', 'CC_DESIGN_SHEET_V1.png'].includes(basename(path)),
  })
  mkdirSync(join(destination, 'fonts'), { recursive: true })
  cpSync(join(desktop, 'src/fonts/geist-variable-latin.woff2'), join(destination, 'fonts/geist-variable-latin.woff2'))
  return destination
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(prepareNativeQA())

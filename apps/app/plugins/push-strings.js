// 由 native/push-strings.json 生成原生文案常量(prebuild 时写进 ios/ 与 android/,不进 git)。
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'native', 'push-strings.json')
const loadStrings = () => JSON.parse(fs.readFileSync(FILE, 'utf8'))
const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

function swiftSource(table) {
  const langs = Object.entries(table).map(([lang, t]) =>
    `    "${esc(lang)}": [\n${Object.entries(t).map(([k, v]) => `      "${esc(k)}": "${esc(v)}",`).join('\n')}\n    ],`)
  return `// 生成自 apps/app/native/push-strings.json(plugins/push-strings.js),别手改。\nenum PushStrings {\n  static let table: [String: [String: String]] = [\n${langs.join('\n')}\n  ]\n}\n`
}

function kotlinSource(table) {
  const k = s => esc(s).replace(/\$/g, '\\$')
  const langs = Object.entries(table).map(([lang, t]) =>
    `    "${k(lang)}" to mapOf(\n${Object.entries(t).map(([a, b]) => `      "${k(a)}" to "${k(b)}",`).join('\n')}\n    ),`)
  return `// 生成自 apps/app/native/push-strings.json(plugins/push-strings.js),别手改。\npackage com.tendhearth.app.push\n\nobject PushStrings {\n  val table: Map<String, Map<String, String>> = mapOf(\n${langs.join('\n')}\n  )\n}\n`
}

module.exports = { loadStrings, swiftSource, kotlinSource }

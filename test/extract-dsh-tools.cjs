/**
 * Copy @deepseek-ai/dsh-tools out of the DSH app.asar into a writable folder.
 *
 * Run it through the DSH Electron binary used as Node, because only that binary
 * understands app.asar paths:
 *
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   "D:\SoftWare\DeepSeek\DeepSeek Harness.exe" test\extract-dsh-tools.js <destDir>
 *
 * test\prepare-deps.ps1 does this for you. Override the source with
 * DSH_ASAR_DSH_TOOLS when DSH is installed elsewhere.
 */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_SOURCE = 'D:/SoftWare/DeepSeek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools'
const source = process.env.DSH_ASAR_DSH_TOOLS || DEFAULT_SOURCE
const destination = process.argv[2]

if (!destination) {
  console.error('usage: extract-dsh-tools.js <destinationDir>')
  process.exit(2)
}
if (!fs.existsSync(source)) {
  console.error('source package not found:', source)
  process.exit(3)
}

/** Recursively copy a directory tree (asar paths work through Electron's fs). */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.writeFileSync(dst, fs.readFileSync(src))
  }
}

copyDir(source, destination)
console.log('copied dsh-tools ->', destination)

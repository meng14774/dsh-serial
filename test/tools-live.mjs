/**
 * End-to-end test of the agent tool layer against the real serial port.
 *
 * It builds the tools with the REAL `defineTool` (argument validation and
 * schema compilation included), then calls them exactly like the agent does:
 * `execute(args)` -> validate -> run -> render. Requires pyserial + COM15.
 *
 *   node test/tools-live.mjs [COM15] [1500000]
 */

import { SerialManager } from '../lib/engine.js'
import { serialTools } from '../lib/tools.js'

const port = process.argv[2] || (process.platform === 'win32' ? 'COM15' : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0')
const baud = Number(process.argv[3] || 1500000)

const manager = new SerialManager({
  getConfig: () => ({ defaultPort: port, defaultBaud: baud, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
  log: (message) => console.log('[engine]', message),
})

const tools = serialTools(manager)
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

async function call(name, args = {}) {
  const tool = byName[name]
  const result = await tool.execute(args, {})
  const rendered = tool.output.render(args, result)
  const text = rendered.map((block) => block.text ?? '').join('')
  console.log(`\n===== ${name}(${JSON.stringify(args)}) -> ok=${result.ok} =====`)
  console.log(text.length > 3000 ? text.slice(0, 3000) + `\n鈥${text.length - 3000} chars trimmed]` : text)
  return result
}

try {
  await call('serial_list')
  await call('serial_open', { port, baud })
  await call('serial_transact', { data: '', expect: '[$#] $', timeoutMs: 8000 })
  await call('serial_transact', { data: 'uptime; echo MARK_$((111*111))', expect: 'MARK_12321', timeoutMs: 10000 })
  await call('serial_write', { data: 'echo HELLO_FROM_TOOL' })
  await call('serial_read', { waitMs: 800 })
  await call('serial_read', { cursor: 'start', maxBytes: 1200, tailLines: 12 })
  await call('serial_status')
  await call('serial_close', { all: true })
} catch (error) {
  console.error('FAILED:', error)
  process.exitCode = 1
} finally {
  await manager.dispose()
}

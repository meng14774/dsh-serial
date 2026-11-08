import { serialTools } from '../lib/tools.js'
const manager = { cfg: () => ({ defaultPort: 'COM15', defaultBaud: 1500000, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', bufferBytes: 4194304, pythonPath: 'python', encoding: 'utf8' }), sessions: new Map(), status: () => [] }
try {
  const tools = serialTools(manager)
  console.log('tools built:', tools.length)
  for (const t of tools) console.log(' -', t.name, 'params:', Object.keys(t.parameters.properties || {}).join(','))
} catch (e) {
  console.error('TOOL SCHEMA FAIL:', e && e.message)
  console.error(e && e.stack)
  process.exitCode = 1
}

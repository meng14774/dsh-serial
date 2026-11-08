/**
 * Live hardware smoke test for the serial engine (no DSH, no plugin loader).
 *
 *   node test/live.mjs [COM15] [1500000]
 *
 * Opens the port, checks the ring buffer/cursor contract, waits for a shell
 * prompt, runs one command through transact(), and exercises an auto-responder.
 */

import { SerialManager, stripAnsi } from '../lib/engine.js'

const port = process.argv[2] || (process.platform === 'win32' ? 'COM15' : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0')
const baud = Number(process.argv[3] || 1500000)

const manager = new SerialManager({
  getConfig: () => ({
    defaultPort: port,
    defaultBaud: baud,
    pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    bufferBytes: 4 * 1024 * 1024,
  }),
  log: (message) => console.log('[engine]', message),
})

const line = (title) => console.log(`\n===== ${title} =====`)

try {
  line('ports')
  const ports = await manager.ports(true)
  console.log(ports.map((p) => `${p.device} | ${p.description} | ${p.hwid}`).join('\n'))

  line('open')
  const session = await manager.open({ port, baud })
  console.log(JSON.stringify(session.status(), null, 2))

  line('history reachable from cursor 0 (data that arrived before any tool call)')
  const history = await session.read({ from: 'start', maxBytes: 20000 })
  console.log(`bytes=${history.text.length} cursor=${history.cursor} gap=${history.gap}`)
  console.log(JSON.stringify(stripAnsi(history.text).slice(-300)))

  line('transact: bare Enter -> shell prompt')
  const prompt = await session.transact({ data: '', patterns: ['[$#] $'], timeoutMs: 8000 })
  console.log('matched =', prompt.matched, 'elapsed =', prompt.elapsedMs, 'ms')
  console.log(JSON.stringify(prompt.text.slice(-120)))

  line('transact: uptime')
  const uptime = await session.transact({ data: 'uptime', patterns: ['[$#] $'], timeoutMs: 10000 })
  console.log('matched =', uptime.matched, 'elapsed =', uptime.elapsedMs, 'ms')
  console.log(JSON.stringify(uptime.text))

  line('incremental read from the tail cursor')
  const tailRead = await session.read({ maxBytes: 4096, waitMs: 300 })
  console.log(`newBytes=${tailRead.text.length} cursor=${tailRead.cursor}`)

  line('read with waitMs while nothing is sent')
  const silent = await session.read({ maxBytes: 4096, waitMs: 700 })
  console.log(`bytes=${silent.text.length} timedOut=${silent.timedOut}`)

  line('auto-responder rule (echo a marker back when the board prints READYPROBE)')
  session.addRule({ name: 'probe', pattern: 'READYPROBE', send: 'echo GOT_$((111*111))\r', cooldownMs: 0 })
  await session.writeText('echo READYPROBE\r')
  const ruleHit = await session.expect({ patterns: ['GOT_12321'], timeoutMs: 8000 })
  console.log('rule fired =', ruleHit.matched, 'ops =', JSON.stringify(session.recentOps(5)))

  line('status')
  console.log(JSON.stringify(session.status(), null, 2))

  await session.close()
  line('closed')
  console.log('state =', session.state)
} catch (error) {
  console.error('FAILED:', error)
  process.exitCode = 1
} finally {
  await manager.dispose()
}
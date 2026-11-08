/**
 * Live transfer + probe test for the serial engine.
 *
 *   node test/transfer.mjs [COM15] [1500000]
 */

import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SerialManager, stripAnsi } from '../lib/engine.js'

const port = process.argv[2] || (process.platform === 'win32' ? 'COM15' : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0')
const baud = Number(process.argv[3] || 1500000)

const manager = new SerialManager({
  getConfig: () => ({ defaultPort: port, defaultBaud: baud, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
  log: (message) => console.log('[engine]', message),
})

const dir = mkdtempSync(join(tmpdir(), 'dsh-serial-test-'))
const localPath = join(dir, 'push-test.bin')
const payload = Buffer.from('dsh-serial push test\n' + 'abc0123456789\r\n'.repeat(120), 'utf8')
writeFileSync(localPath, payload)

try {
  const session = await manager.open({ port, baud })
  await session.transact({ data: '', patterns: ['[$#] $'], timeoutMs: 8000 })

  console.log('\n===== probe (read-only baud scan; reuses the open session) =====')
  const probe = await manager.probe({ port, bauds: [baud, 115200], perBaudMs: 800 })
  console.log(JSON.stringify(probe, null, 2))
  await session.setBaud(baud)

  console.log('\n===== push =====')
  const push = await manager.push({ localPath, remotePath: '/tmp/dsh-serial-push.bin' })
  console.log(JSON.stringify(push, null, 2))

  console.log('\n===== verify on the board =====')
  const verify = await session.transact({
    data: 'wc -c < /tmp/dsh-serial-push.bin; sha256sum /tmp/dsh-serial-push.bin | cut -d" " -f1',
    patterns: ['[$#] $'],
    timeoutMs: 10000,
  })
  console.log(stripAnsi(verify.text))

  console.log('\n===== pull =====')
  const pulled = join(dir, 'pulled.bin')
  const pull = await manager.pull({ remotePath: '/tmp/dsh-serial-push.bin', localPath: pulled })
  console.log(JSON.stringify(pull, null, 2))
  if (pull.ok) {
    const back = readFileSync(pulled)
    console.log('round-trip identical =', Buffer.compare(back, payload) === 0, `(${back.length} bytes)`)
  }

  await session.close()
} catch (error) {
  console.error('FAILED:', error)
  process.exitCode = 1
} finally {
  await manager.dispose()
}
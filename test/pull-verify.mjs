/**
 * Stress the pull path: a 40 KB file, pulled repeatedly, must always match the
 * remote sha256 (long console bursts occasionally drop a byte or two; the pull
 * verification retries once). Run against the source engine, not the installed
 * plugin.
 *
 *   node test/pull-verify.mjs [COM15] [1500000] [rounds]
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SerialManager } from '../lib/engine.js'

const port = process.argv[2] || (process.platform === 'win32' ? 'COM15' : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0')
const baud = Number(process.argv[3] || 1500000)
const rounds = Number(process.argv[4] || 4)

const manager = new SerialManager({
  getConfig: () => ({ defaultPort: port, defaultBaud: baud, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
  log: (message) => console.log('[engine]', message),
})

const dir = mkdtempSync(join(tmpdir(), 'dsh-pull-'))
const local = join(dir, 'src.bin')
const payload = Buffer.alloc(41025)
for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) & 0xff
const localSha = createHash('sha256').update(payload).digest('hex')
writeFileSync(local, payload)

let failures = 0
try {
  const session = await manager.open({ port, baud })
  await session.transact({ data: '', patterns: ['[$#] $'], timeoutMs: 8000 })

  const pushed = await manager.push({ localPath: local, remotePath: '/tmp/dsh-pull-src.bin' })
  console.log('push:', pushed.ok ? 'ok' : 'FAILED', pushed.remoteSha === localSha ? '(sha match)' : `(sha ${pushed.remoteSha})`)
  if (!pushed.ok) failures += 1

  for (let round = 1; round <= rounds; round += 1) {
    const out = join(dir, `pull-${round}.bin`)
    const result = await manager.pull({ remotePath: '/tmp/dsh-pull-src.bin', localPath: out })
    const okSha = result.ok && result.remoteSha === result.localSha && readFileSync(out).equals(payload)
    console.log(`pull #${round}: ${result.ok ? 'ok' : 'FAILED'} attempts=${result.attempts} bytes=${result.bytes} sha=${result.remoteSha?.slice(0, 12)} ${okSha ? 'VERIFIED' : 'BAD'}${result.error ? ' — ' + result.error : ''}`)
    if (!okSha) failures += 1
  }

  await session.transact({ data: 'rm -f /tmp/dsh-pull-src.bin', patterns: ['[$#] $'], timeoutMs: 8000 })
  await session.close()
  console.log(failures === 0 ? '\nALL PULLS VERIFIED' : `\n${failures} FAILURE(S)`)
  if (failures > 0) process.exitCode = 1
} catch (error) {
  console.error('FAILED:', error)
  process.exitCode = 1
} finally {
  await manager.dispose()
}

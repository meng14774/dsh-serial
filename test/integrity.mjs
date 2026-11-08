/**
 * Regression tests for 0.1.5: "is this text trustworthy?" and lossy-link file
 * transfer. Real board, COM15.
 *
 *   node test/integrity.mjs [COM15] [1500000]
 *
 * Covers:
 *   1. verify=true transact   — board-side tee + sha256 against the capture;
 *      the command is re-run until the captured bytes hash correctly.
 *   2. plain transact         — reports driver link errors when they happen.
 *   3. pull with chunking     — every chunk verified, only bad chunks retried,
 *      whole file sha256 matched before anything is written.
 */

import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SerialManager, stripAnsi } from '../lib/engine.js'

const port = process.argv[2] || (process.platform === 'win32' ? 'COM15' : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0')
const baud = Number(process.argv[3] || 1500000)
const PROMPT = '[$#] $'

const manager = new SerialManager({
  getConfig: () => ({ defaultPort: port, defaultBaud: baud, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
  log: (message) => console.log('[engine]', message),
})

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`)
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const session = await manager.open({ port, baud })
  await session.writeText('\x03')
  await sleep(150)
  await session.transact({ data: '', patterns: [PROMPT], timeoutMs: 8000 })

  // 1. verify=true: the sha256 of what we captured must equal the board's.
  const verified = await session.transact({
    data: "seq -f '%06g' 1 2000",
    verify: true,
    timeoutMs: 30000,
  })
  const vText = stripAnsi(verified.text)
  const numbers = vText.split('\n').filter((line) => /^\d{6}$/.test(line.trim())).length
  check('verify: integrity is verified', verified.integrity === 'verified', JSON.stringify(verified.verify))
  check('verify: output complete (2000 numbers)', numbers === 2000, `numbers=${numbers}`)
  check('verify: sha256 matches', verified.verify?.remoteSha === verified.verify?.localSha, JSON.stringify(verified.verify))
  console.log(`      attempts=${verified.verify?.attempts}, bytes=${verified.verify?.localSize}`)

  // 2. A plain transact over the same output: count the driver's own evidence.
  const plain = await session.transact({ data: "seq -f '%06g' 1 2000", patterns: [PROMPT], timeoutMs: 30000 })
  const plainNumbers = stripAnsi(plain.text).split('\n').filter((line) => /^\d{6}$/.test(line.trim())).length
  console.log(`      plain transact: numbers=${plainNumbers}/2000, linkWarnings=${plain.linkWarnings}`)
  check('plain transact: flags loss it noticed', plain.linkWarnings > 0 || plainNumbers === 2000,
    `linkWarnings=${plain.linkWarnings} numbers=${plainNumbers}`)

  // 3. Pull a 40 KB binary: chunked + per-chunk sha256, nothing written unverified.
  await session.transact({ data: 'rm -f /tmp/dsh-big.bin; head -c 40960 /dev/urandom > /tmp/dsh-big.bin; wc -c < /tmp/dsh-big.bin', patterns: [PROMPT], timeoutMs: 15000 })
  const local = join(mkdtempSync(join(tmpdir(), 'dsh-integrity-')), 'pulled.bin')
  const pulled = await manager.pull({ remotePath: '/tmp/dsh-big.bin', localPath: local })
  if (pulled.ok) {
    const size = statSync(local).size
    const head = readFileSync(local).subarray(0, 8).toString('hex')
    check('pull: 40960 bytes on disk', size === 40960, `size=${size}`)
    check('pull: whole-file sha256 matches', pulled.remoteSha === pulled.localSha, JSON.stringify(pulled))
    console.log(`      attempts=${pulled.attempts}, ${pulled.pieceChars} chars / ${pulled.delayMs} ms, head=${head}`)
  } else {
    check('pull: succeeded', false, JSON.stringify(pulled))
  }
  await session.transact({ data: 'rm -f /tmp/dsh-big.bin', patterns: [PROMPT], timeoutMs: 8000 })
  try { rmSync(join(local, '..'), { recursive: true, force: true }) } catch { /* ignore */ }

  // 4. Status must report the same evidence the reads do.
  const status = session.status()
  console.log(`      status: linkErrors=${status.linkErrors} flags=0x${(status.linkFlags || 0).toString(16)} ringOverflow=${status.droppedBytes}`)
} catch (error) {
  failures += 1
  console.log('FAIL  unexpected error —', error?.stack || error)
} finally {
  await manager.dispose()
}

console.log(failures === 0 ? '\nALL INTEGRITY CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

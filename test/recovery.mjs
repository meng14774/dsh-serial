/**
 * Regression tests for 0.1.6: "the session died and the tool opened another
 * port / threw the evidence away".
 *
 *   node test/recovery.mjs [COM15] [1500000]
 *
 * Part A (no hardware) checks the port-safety rule with throw-away managers:
 * a tool call must never fall back to config.defaultPort when some other port
 * is remembered, and the error must name the port it actually tried.
 *
 * Part B (real port) kills the sidecar process while output is unread, then
 * calls the real `serial_read` tool and checks that:
 *   - the next result starts with a notice naming the port and the time,
 *   - the same port is reopened (config.defaultPort points at a dead COM99),
 *   - the unread bytes are still there (retained ring, same cursors),
 *   - the preference ("last port that worked") survived into a new manager.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SerialManager, stripAnsi } from '../lib/engine.js'
import { serialTools } from '../lib/tools.js'

const port = process.argv[2] || (process.platform === 'win32' ? 'COM15' : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0')
const baud = Number(process.argv[3] || 1500000)
const prompt = '[$#] $'

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`)
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Error text of an async call that is expected to fail. */
async function failureOf(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A manager whose config points at a port that does not exist. */
function offlineManager(defaultPort = 'COM99') {
  return new SerialManager({
    getConfig: () => ({ defaultPort, defaultBaud: 9600, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
    stateFile: null,
    log: () => {},
  })
}

try {
  // ---------------------------------------------------------------- part A
  console.log('\n--- A. no hardware: which port would a tool call open?')
  {
    const m = offlineManager('COM99')
    const message = await failureOf(() => m.ensureSession())
    check('A1 nothing known: tries config.defaultPort (COM99)', /COM99/.test(message ?? ''), message)
    await m.dispose()
  }
  {
    const m = offlineManager('COM99')
    m.state.lastPort = 'COM77'
    const message = await failureOf(() => m.ensureSession())
    check('A2 remembered COM77 wins over COM99', /COM77/.test(message ?? '') && !/COM99/.test(message ?? ''), message)
    await m.dispose()
  }
  {
    const m = offlineManager('COM99')
    m.setDefault({ port: 'COM78', baud: 115200 })
    const message = await failureOf(() => m.ensureSession())
    check('A3 serial_set_default(COM78) is used', /COM78/.test(message ?? ''), message)
    check('A3b setDefault exposes the preference', m.state.lastPort === 'COM78' && m.state.lastBaud === 115200, JSON.stringify(m.state))
    await m.dispose()
  }
  {
    const m = offlineManager('COM99')
    const message = await failureOf(() => m.ensureSession({ session: 'COM76' }))
    check('A4 unknown session is an error, not a default open', /COM76/.test(message ?? '') && /serial_open/.test(message ?? ''), message)
    await m.dispose()
  }

  // ---------------------------------------------------------------- part B
  if (process.env.DSH_SERIAL_OFFLINE === '1') {
    console.log('\n--- B. skipped: DSH_SERIAL_OFFLINE=1 (no hardware)')
  } else {
  console.log('\n--- B. real port: kill the reader, then call a tool')
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-recovery-'))
  const stateFile = join(stateDir, 'serial-state.json')
  const manager = new SerialManager({
    // Deliberately stale config: a tool must NOT open this port.
    getConfig: () => ({ defaultPort: 'COM99', defaultBaud: baud, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
    stateFile,
    log: (message) => console.log('[engine]', message),
  })
  const tools = Object.fromEntries(serialTools(manager).map((tool) => [tool.name, tool]))
  const call = async (name, args = {}) => {
    const tool = tools[name]
    const result = await tool.execute(args, {})
    return { ...result, text: String(result.text ?? '') }
  }

  const session = await manager.open({ port, baud })
  await session.writeText('\x03')
  await sleep(150)
  await session.transact({ data: '', patterns: [prompt], timeoutMs: 8000 })
  const marker = await session.transact({ data: 'echo LIVE_$((6*7))', patterns: ['LIVE_42'], timeoutMs: 8000 })
  check('B1 baseline command works', marker.matched, JSON.stringify(marker.text?.slice(-120)))

  const pinged = await call('serial_ping', { timeoutMs: 2000 })
  check('B2 serial_ping sees the open console', /ALIVE/.test(pinged.text), pinged.text.split('\n')[0])

  // Leave output unread, then kill the sidecar underneath the session.
  await session.writeText('echo LEAVE_ME_$((40+2))\r')
  await sleep(400)
  const before = { size: session.ring.size, end: session.ring.end, tail: session.tailCursor }
  check('B3 there is unread output before the kill', before.end - before.tail > 0, JSON.stringify(before))
  await call('serial_read', {}) // drains what is there *and* moves the tail — we want unread for the real check
  await session.writeText('echo SECOND_LEAVE_$((40+3))\r')
  await sleep(400)
  const unread = { end: session.ring.end, tail: session.tailCursor }
  check('B4 unread bytes exist again', unread.end - unread.tail > 0, JSON.stringify(unread))

  try {
    process.kill(session.pid)
  } catch (error) {
    console.log('      (could not kill the sidecar directly:', error.message, ')')
  }
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && manager.sessions.size > 0) await sleep(100)
  check('B5 session left the live table after the reader died', manager.sessions.size === 0, `sessions=${manager.sessions.size}`)
  check('B6 retained buffer exists for the port', manager.retainedBuffers().some((entry) => entry.port === port), JSON.stringify(manager.retainedBuffers()))

  // The next tool call is what used to open COM15 unconditionally.
  const read = await call('serial_read', {})
  const firstLine = read.text.split('\n')[0]
  check('B7 next result opens with the death notice', /^! session /.test(firstLine) && new RegExp(port).test(firstLine), firstLine)
  console.log(`      notice: ${firstLine}`)
  check('B8 it reopened the same port', manager.sessions.has(port), JSON.stringify([...manager.sessions.keys()]))
  check('B9 config.defaultPort (COM99) was never opened', !manager.sessions.has('COM99') && manager.state.lastPort === port,
    `lastPort=${manager.state.lastPort}`)
  check('B10 unread bytes survived the death', /SECOND_LEAVE_43/.test(stripAnsi(read.text)), read.text.split('\n').slice(0, 8).join(' | '))
  check('B11 buffer is contiguous (same absolute end)', manager.sessions.get(port).ring.end >= unread.end,
    `ring.end=${manager.sessions.get(port).ring.end} was=${unread.end}`)

  const afterPing = await call('serial_ping', { timeoutMs: 2000 })
  check('B12 the reopened session talks to the board', /ALIVE/.test(afterPing.text), afterPing.text.split('\n')[0])

  // Reading at the end must explain the silence instead of just saying "no bytes".
  const empty = await call('serial_read', { cursor: 'end' })
  check('B13 an empty read explains the silence', /Nothing has arrived since this cursor/.test(empty.text), empty.text)

  // A console that echoes but then goes quiet must be told apart from a dead one.
  const quiet = await call('serial_transact', { data: 'sleep 2', expect: 'NEVER_MATCH_XYZ', timeoutMs: 700 })
  check('B14 echoed-then-quiet gets a conclusion', /echoed, then the console went quiet/.test(quiet.text),
    quiet.text.split('\n').slice(0, 3).join(' | '))
  await sleep(2500)

  // Preference persistence: a fresh manager reads the same state file.
  const manager2 = new SerialManager({
    getConfig: () => ({ defaultPort: 'COM99', defaultBaud: baud, pythonPath: process.env.DSH_SERIAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }),
    stateFile,
    log: () => {},
  })
  check('B15 "last port" survived into a new manager', manager2.state.lastPort === port && manager2.state.lastBaud === baud, JSON.stringify(manager2.state))
  await manager2.dispose()

  const closed = await call('serial_close', { session: port, dropBuffer: true })
  check('B16 close dropBuffer=true releases the buffer', !manager.retainedBuffers().some((entry) => entry.port === port), closed.text)

  await manager.dispose()
  try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
} catch (error) {
  failures += 1
  console.log('FAIL  unexpected error —', error?.stack || error)
}

console.log(failures === 0 ? '\nALL RECOVERY CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
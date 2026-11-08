/**
 * Offline checks for the cross-platform wording (0.1.7):
 *   - the example port name matches the host (COM15 / /dev/cu.* / /dev/ttyUSB0),
 *   - serial_status does not claim "no loss" on an OS that cannot observe loss,
 *   - serial_open without a port explains how to name one on this host.
 *
 *   node test/platform.mjs
 */

import { portExample } from '../lib/engine.js'
import { serialTools } from '../lib/tools.js'

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`)
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const expected = process.platform === 'win32'
  ? 'COM15'
  : process.platform === 'darwin' ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0'
check(`portExample() is host-appropriate (${expected})`, portExample() === expected, portExample())

/** Minimal status object that renderSession() consumes. */
function status(overrides = {}) {
  return {
    id: 'X', port: '/dev/cu.X', baud: 1500000, dataBits: 8, parity: 'none', stopBits: 1,
    state: 'open', pid: 1, openedAt: Date.now(), bufferedBytes: 0, bufferCapacity: 4 * 1024 * 1024,
    receivedBytes: 0, droppedBytes: 0, txBytes: 0, linkErrors: 0, linkFlags: 0, linkLastAt: null,
    cursorStart: 0, cursorEnd: 0, tailCursor: 0, unreadBytes: 0, rules: 0, lastByteAgeMs: null,
    lastError: undefined, closedAt: null, ...overrides,
  }
}

function makeManager({ status: statusOverrides, ...overrides } = {}) {
  const list = [status(statusOverrides)]
  return {
    sessions: new Map(),
    state: { lastPort: undefined, lastBaud: undefined },
    status: () => list,
    retainedBuffers: () => [],
    cfg: () => ({
      defaultPort: '', defaultBaud: 1500000, dataBits: 8, parity: 'none', stopBits: 1,
      flowControl: 'none', bufferBytes: 4 * 1024 * 1024, pythonPath: 'python3', encoding: 'utf8',
    }),
    ...overrides,
  }
}

const manager = makeManager({ status: { linkWatch: false } })
const tools = Object.fromEntries(serialTools(manager).map((tool) => [tool.name, tool]))
const call = (name, args = {}) => tools[name].execute(args, {})

const statusText = (await call('serial_status')).text
check('status says loss is NOT observable when linkWatch is false',
  /NOT OBSERVABLE/.test(statusText), statusText.split('\n').slice(0, 3).join(' | '))

const managerWatch = makeManager({ status: { linkWatch: true } })
const toolsWatch = Object.fromEntries(serialTools(managerWatch).map((tool) => [tool.name, tool]))
const watchText = (await toolsWatch.serial_status.execute({}, {})).text
check('status keeps "no driver-reported loss" when linkWatch is true',
  /no driver-reported loss/.test(watchText), watchText.split('\n')[2])

const openText = (await call('serial_open', {})).text
check('serial_open without a port names the host example', openText.includes(portExample()), openText)

console.log(failures === 0 ? '\nALL PLATFORM CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
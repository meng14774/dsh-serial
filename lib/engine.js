/**
 * Serial engine for the dsh-serial plugin.
 *
 * One `SerialSession` owns one serial port through a small Python sidecar
 * (`sidecar.py`, pyserial). The session keeps every received byte in an
 * in-memory ring buffer and never writes a log file: agents read the ring by
 * absolute byte cursor, wait for new data, or wait for a regex.
 *
 * Why a Python sidecar instead of a native Node module:
 *   - no node-gyp / Electron ABI build step, works on any host where pyserial
 *     works (the same environment SerialKit already uses on this machine);
 *   - the port stays open in one long-lived process, so boot logs that happen
 *     while no agent is calling a tool are still buffered;
 *   - the Node side stays pure JS and is trivial to hot-reload.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { RingBuffer } from './ring.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, 'sidecar.py')

/**
 * Host-platform facts (see PORTING-macOS.md).
 *
 * Python: Windows installs expose `python`; macOS/Linux expose `python3`.
 * Ports: Windows COM15, macOS /dev/cu.usbserial-* (callout), Linux /dev/ttyUSB0.
 * `linkWatch` is the one real capability difference: ClearCommError() is a
 * Win32 API, so only Windows can tell us "bytes were lost in transit"; on
 * macOS/Linux the same loss exists but is unobservable, and serial_status must
 * say so instead of claiming "no loss".
 */
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const DEFAULT_PYTHON = IS_WIN ? 'python' : 'python3'

/** Example port name for the current host, used in error messages. */
export function portExample() {
  return IS_WIN ? 'COM15' : IS_MAC ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0'
}

/** ANSI/VT control sequences that make console output unreadable for a model. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Strip ANSI escape sequences and NUL padding from console text. */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, '').replace(/\x00/g, '')
}

/** Escape one literal string for use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Clamp a number into [min, max]. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Local wall-clock HH:MM:SS for user-facing messages ("reader died at 02:07:31"). */
export function clock(ts) {
  if (!Number.isFinite(ts)) return 'unknown time'
  return new Date(ts).toTimeString().slice(0, 8)
}

/**
 * Where the "last port that worked" preference lives.
 *
 * The profile's own config is owned by the DSH loader, so the plugin keeps its
 * small runtime preference beside it instead of rewriting a file it does not
 * own: after a USB adapter moves from COM15 to COM7 the config is stale, but
 * "the port that worked last" is usually exactly right.
 */
function statePath() {
  if (process.env.DSH_SERIAL_STATE === 'off') return null
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'serial-state.json')
}

/** Decode bytes for the model: UTF-8 by default, replacement chars are fine. */
function decode(buf, encoding) {
  try {
    return buf.toString(encoding || 'utf8')
  } catch {
    return buf.toString('utf8')
  }
}

/** Keep only the last `max` characters, with a prefix marker when cut. */
export function tail(text, max) {
  if (text.length <= max) return text
  return `…[${text.length - max} chars trimmed]…\n` + text.slice(text.length - max)
}

/**
 * One open serial port.
 * @fires SerialSession#rx
 * @fires SerialSession#tx
 * @fires SerialSession#closed
 */
export class SerialSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id - stable tool-facing id (defaults to the port name).
   * @param {string} opts.port
   * @param {number} opts.baud
   * @param {number} [opts.dataBits]
   * @param {string} [opts.parity]
   * @param {number} [opts.stopBits]
   * @param {string} [opts.flowControl]
   * @param {boolean|undefined} [opts.dtr]
   * @param {boolean|undefined} [opts.rts]
   * @param {number} [opts.bufferBytes]
   * @param {RingBuffer} [opts.ring] - retained buffer to re-attach (same port)
   * @param {number} [opts.tailCursor] - read position to resume from
   * @param {string} [opts.pythonPath]
   * @param {string} [opts.encoding]
   * @param {string} [opts.description]
   */
  constructor(opts) {
    super()
    /** Back-reference so verified operations can reuse the chunked pull path. */
    this.manager = opts.manager
    this.id = opts.id || opts.port
    this.port = opts.port
    this.baud = opts.baud
    this.dataBits = opts.dataBits ?? 8
    this.parity = opts.parity ?? 'none'
    this.stopBits = opts.stopBits ?? 1
    this.flowControl = opts.flowControl ?? 'none'
    this.dtr = opts.dtr
    this.rts = opts.rts
    this.pythonPath = opts.pythonPath || process.env.DSH_SERIAL_PYTHON || DEFAULT_PYTHON
    this.encoding = opts.encoding || 'utf8'
    this.description = opts.description
    // The ring may outlive the session: a port that was already used resumes
    // with the same buffer (and the same absolute cursor space), so bytes that
    // arrived just before the reader died are still readable afterwards.
    this.ring = opts.ring ?? new RingBuffer(opts.bufferBytes ?? 4 * 1024 * 1024)
    /** Session-level "what the next read sees by default". */
    this.tailCursor = clamp(opts.tailCursor ?? this.ring.end, this.ring.start, this.ring.end)
    /** Set once the sidecar confirmed the port is open. */
    this.everOpen = false
    /** Set by the manager when this session is retired into the buffer registry. */
    this.retired = false
    this.state = 'starting'
    this.openedAt = Date.now()
    this.closedAt = undefined
    this.failReason = undefined
    this.exitCode = undefined
    this.pid = undefined
    this.lastError = undefined
    this.rxEvents = 0
    this.txBytes = 0
    /** Driver-reported byte loss in transit: [{ at, flags, new }]. */
    this.linkEvents = []
    this.linkErrorCount = 0
    this.linkFlags = 0
    /**
     * Whether this OS can report driver-level loss at all (undefined until the
     * sidecar says). Windows: true (ClearCommError). macOS/Linux: false — loss
     * is real but invisible, so status must not read as "the link is clean".
     * @type {boolean|undefined}
     */
    this.linkWatch = undefined
    /** @type {Array<{ts:number, op:string, detail:string}>} */
    this.ops = []
    this.#rules = []
    this.#pending = new Map()
    this.#nextCommandId = 1
    this.stderrTail = ''
    this.#startDeferred = undefined
    this.setMaxListeners(0)
  }

  #child
  #rl
  #ready
  #closedPromise
  #pending
  #nextCommandId
  #closeResolve
  #startDeferred
  #rules

  /** Launch the sidecar and resolve once it reports the port is open. */
  async start() {
    this.#ready = new Promise((resolve, reject) => {
      this.#startDeferred = { resolve, reject }
    })
    const args = [
      SIDECAR,
      '--port', this.port,
      '--baud', String(this.baud),
      '--bytesize', String(this.dataBits),
      '--parity', parityCode(this.parity),
      '--stopbits', String(this.stopBits),
      '--dtr', this.dtr === true ? '1' : this.dtr === false ? '0' : 'keep',
      '--rts', this.rts === true ? '1' : this.rts === false ? '0' : 'keep',
      '--label', this.id,
    ]
    if (this.flowControl === 'xonxoff') args.push('--xonxoff')
    if (this.flowControl === 'rtscts') args.push('--rtscts')
    if (this.flowControl === 'dsrdtr') args.push('--dsrdtr')

    this.#child = spawn(this.pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#closedPromise = new Promise((resolve) => { this.#closeResolve = resolve })

    this.#child.on('error', (error) => {
      this.state = 'failed'
      this.lastError = `failed to launch ${this.pythonPath}: ${error.message}`
      this.#startDeferred?.reject(new Error(this.lastError))
      this.#closeResolve?.()
    })
    this.#child.on('exit', (code, signal) => {
      this.#onExit(code, signal)
    })
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    this.#rl = createInterface({ input: this.#child.stdout })
    this.#rl.on('line', (line) => this.#onLine(line))

    const timer = setTimeout(() => {
      this.#startDeferred?.reject(new Error(`serial port ${this.port} did not open within 12s`))
      this.#fail('open timeout')
    }, 12000)
    try {
      await this.#ready
    } finally {
      clearTimeout(timer)
    }
    this.state = 'open'
    return this
  }

  /** Reject the start promise once and tear the process down. */
  #fail(message) {
    this.lastError = message
    try {
      this.#child?.kill()
    } catch { /* ignore */ }
  }

  #onExit(code, signal) {
    const wasLive = this.state === 'open' || this.state === 'starting'
    const failed = this.state === 'failed'
    // A reader that died keeps reporting `failed`: overwriting it with `closed`
    // would erase the reason the next tool call has to show.
    if (!failed) this.state = 'closed'
    if (!this.closedAt) this.closedAt = Date.now()
    this.exitCode = code
    this.#startDeferred?.reject(new Error(this.lastError || `sidecar exited (code=${code}, signal=${signal})`))
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`sidecar exited: ${this.lastError || code}`))
    }
    this.#pending.clear()
    this.#closeResolve?.()
    if (wasLive || failed) {
      this.emit('closed', {
        code,
        signal,
        reason: this.failReason || this.lastError || `sidecar exited (code=${code}, signal=${signal})`,
      })
    }
  }

  /** Dispatch one NDJSON line from the sidecar. */
  #onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    switch (msg.t) {
      case 'ready':
        this.port = msg.port ?? this.port
        this.baud = msg.baud ?? this.baud
        this.pid = msg.pid
        this.linkWatch = msg.linkWatch === undefined ? undefined : Boolean(msg.linkWatch)
        this.state = 'open'
        this.everOpen = true
        this.#startDeferred?.resolve(this)
        break
      case 'd': {
        const chunk = Buffer.from(msg.b64, 'base64')
        this.ring.append(chunk, Date.now())
        this.rxEvents += 1
        this.tailCursor = Math.max(this.tailCursor, this.ring.start)
        this.emit('rx', chunk)
        this.#evalRules(chunk)
        break
      }
      case 'tx':
        this.txBytes += Buffer.from(msg.b64, 'base64').length
        this.emit('tx', Buffer.from(msg.b64, 'base64'))
        break
      case 'link': {
        // The driver dropped bytes in transit: the ring now holds a stream that
        // is *shorter than what the board sent*, with no other trace. Remember
        // where it happened so reads can say "this window is not trustworthy".
        const at = Number.isFinite(msg.rx) ? msg.rx : this.ring.end
        this.linkEvents.push({ at, flags: msg.flags | 0, ts: Date.now() })
        if (this.linkEvents.length > 256) this.linkEvents.shift()
        this.linkErrorCount += 1
        this.linkFlags |= msg.flags | 0
        this.emit('link', this.linkEvents[this.linkEvents.length - 1])
        break
      }
      case 'ack': {
        const pending = this.#pending.get(msg.id)
        if (pending) {
          this.#pending.delete(msg.id)
          clearTimeout(pending.timer)
          pending.resolve(msg)
        }
        break
      }
      case 'error': {
        this.lastError = msg.message
        this.#recordOp('error', `${msg.op ?? '?'}: ${msg.message}`)
        if (msg.id !== undefined) {
          const pending = this.#pending.get(msg.id)
          if (pending) {
            this.#pending.delete(msg.id)
            clearTimeout(pending.timer)
            pending.reject(new Error(msg.message))
          }
        }
        break
      }
      case 'closed':
        break
      case 'fatal': {
        // The sidecar's reader died (unplugged adapter, another program taking
        // the port). The sidecar exits right after this line; keep the session
        // marked failed with its port name so nothing silently switches to a
        // different port, and let the manager reopen *this* port on demand.
        this.lastError = msg.message ?? 'serial reader stopped'
        this.failReason = this.lastError
        this.closedAt = this.closedAt ?? Date.now()
        this.state = 'failed'
        this.#recordOp('fatal', this.lastError)
        this.#startDeferred?.reject(new Error(this.lastError))
        this.#startDeferred = undefined
        this.emit('fatal', this.lastError)
        try { this.#child?.kill() } catch { /* ignore */ }
        break
      }
      default:
        break
    }
  }

  /** Send one command object to the sidecar and await its ack. */
  #send(command, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.state === 'closed' || !this.#child) {
        reject(new Error(`session ${this.id} is closed`))
        return
      }
      const id = this.#nextCommandId++
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`serial command '${command.op}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#child.stdin.write(JSON.stringify({ id, ...command }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  /** Write raw bytes. Returns how many bytes the OS accepted. */
  async write(buffer) {
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8')
    const ack = await this.#send({ op: 'write', b64: payload.toString('base64') })
    this.#recordOp('write', describeBytes(payload))
    return { bytes: ack.bytes ?? payload.length, cursor: this.ring.end }
  }

  /** Write UTF-8 text (appends no newline; use tools for that). */
  writeText(text) {
    return this.write(Buffer.from(text, 'utf8'))
  }

  /** Change the baud rate on the open port. */
  async setBaud(baud) {
    const ack = await this.#send({ op: 'baud', baud })
    this.baud = ack.baud ?? baud
    this.#recordOp('baud', String(this.baud))
    return this.baud
  }

  /** Drive DTR/RTS statically. */
  async setLine(line, value) {
    const ack = await this.#send({ op: line === 'rts' ? 'rts' : 'dtr', value: Boolean(value) })
    if (line === 'rts') this.rts = ack.value; else this.dtr = ack.value
    this.#recordOp(line, String(ack.value))
    return ack.value
  }

  /** Pulse DTR/RTS (use `active=false` to emit a low pulse). */
  async pulse(line, ms = 150, active = true) {
    await this.#send({ op: 'pulse', line, ms, active }, Math.max(8000, ms + 4000))
    this.#recordOp('pulse', `${line} ${ms}ms active=${active}`)
  }

  /** Send a serial BREAK. */
  async sendBreak(ms = 250) {
    await this.#send({ op: 'break', ms }, Math.max(8000, ms + 4000))
    this.#recordOp('break', `${ms}ms`)
  }

  /** Drop anything currently in the OS input buffer. */
  async flushInput() {
    await this.#send({ op: 'flush' })
    this.#recordOp('flush', 'input buffer')
  }

  /**
   * "Is anything alive on this port?" — send a CR (or listen only) and report
   * whether *any* byte came back within the timeout.
   *
   * This is the cheap check that separates "the command did not match" from
   * "the board/port/baud is wrong": a console that echoes its input answers a
   * bare CR with at least the echo and usually a prompt, so zero bytes is a
   * wiring/port/power answer rather than a regex problem.
   * @param {{data?:string, poke?:boolean, timeoutMs?:number}} opts
   */
  async ping({ data = '\r', poke = true, timeoutMs = 2000 } = {}) {
    const from = this.ring.end
    const wait = clamp(Number(timeoutMs) || 2000, 50, 60000)
    const startedAt = Date.now()
    if (poke) await this.writeText(String(data ?? '\r'))
    const deadline = startedAt + wait
    let firstByteAt = 0
    while (this.ring.end <= from && this.state === 'open' && Date.now() < deadline) {
      await this.#waitForData(deadline)
      if (this.ring.end > from && !firstByteAt) firstByteAt = Date.now()
    }
    if (this.ring.end > from && !firstByteAt) firstByteAt = Date.now()
    const window = this.ring.read(from, 65536)
    const text = decode(window.data, this.encoding)
    const result = {
      alive: window.data.length > 0,
      port: this.port,
      baud: this.baud,
      state: this.state,
      poked: Boolean(poke),
      bytes: window.data.length,
      firstByteMs: firstByteAt ? firstByteAt - startedAt : null,
      elapsedMs: Date.now() - startedAt,
      from,
      to: window.from + window.data.length,
      text,
      promptSeen: text.trim() !== '' && looksLikePrompt(text),
      echoSeen: Boolean(poke) && text.replace(/\r/g, '').trim().startsWith(String(data ?? '\r').replace(/\r/g, '').trim()),
    }
    this.#recordOp('ping', poke ? `poke, ${result.bytes} bytes back` : `listen, ${result.bytes} bytes`)
    return result
  }

  /**
   * Read buffered bytes from an absolute cursor.
   * @param {{from?:number|'start'|'tail', maxBytes?:number, waitMs?:number}} opts
   */
  async read({ from, maxBytes = 256 * 1024, waitMs = 0 } = {}) {
    const start = this.resolveCursor(from)
    const deadline = Date.now() + Math.max(0, waitMs)
    let result = this.ring.read(start, maxBytes)
    while (result.data.length === 0 && Date.now() < deadline && this.state === 'open') {
      await this.#waitForData(deadline)
      result = this.ring.read(start, maxBytes)
    }
    const cursor = result.from + result.data.length
    if (from === undefined) this.tailCursor = cursor
    const link = this.linkWarnings(result.from, cursor)
    return {
      data: result.data,
      text: decode(result.data, this.encoding),
      from: result.from,
      to: result.from + result.data.length,
      cursor,
      gap: result.gap,
      available: result.available,
      timedOut: result.data.length === 0 && waitMs > 0,
      linkWarnings: link.count,
      linkFlags: link.flags,
      untrusted: link.count > 0,
    }
  }

  /**
   * Driver-reported loss events that fall inside a byte window.
   *
   * There is no way to *detect* a missing byte on a bare UART stream by looking
   * at the bytes that did arrive, so this is the only honest signal available:
   * the OS said "I dropped bytes while receiving this range". When it fires, the
   * text in the window may be short somewhere and must not be trusted verbatim.
   */
  linkWarnings(from, to) {
    const lo = Math.min(from, to) - 64
    const hi = Math.max(from, to) + 64
    const events = this.linkEvents.filter((ev) => ev.at >= lo && ev.at <= hi)
    return {
      count: events.length,
      flags: events.reduce((acc, ev) => acc | ev.flags, 0),
      events: events.slice(-8),
    }
  }

  /**
   * Wait until one of `patterns` matches bytes at/after `from`.
   *
   * `idleMs > 0` turns silence into a frame boundary: when no new byte has
   * arrived for that long, the call returns whatever was received so far with
   * `idle: true` instead of waiting out the whole timeout. That is what makes
   * output without a trailing newline (curl | head -c 400, progress bars)
   * retrievable without inventing a marker command.
   * @param {{from?:number|'start'|'tail', patterns:string[]|RegExp[], timeoutMs?:number, maxBytes?:number, idleMs?:number}} opts
   */
  async expect({ from, patterns, timeoutMs = 5000, maxBytes = 1024 * 1024, idleMs = 0 } = {}) {
    const list = (Array.isArray(patterns) ? patterns : [patterns]).filter((p) => p !== undefined && p !== null && p !== '')
    if (list.length === 0) throw new Error('expect needs at least one pattern')
    const compiled = list.map((p) => (p instanceof RegExp ? p : new RegExp(String(p), 'm')))
    const requested = this.resolveCursor(from)
    const startedAt = Date.now()
    const deadline = startedAt + Math.max(0, timeoutMs)
    let scannedTo = requested
    let lastText = ''
    for (;;) {
      const fromClamped = Math.max(requested, this.ring.start)
      const to = Math.min(this.ring.end, fromClamped + maxBytes)
      if (to > fromClamped) {
        const text = decode(this.ring.slice(fromClamped, to), this.encoding)
        lastText = text
        for (let index = 0; index < compiled.length; index += 1) {
          const re = compiled[index]
          re.lastIndex = 0
          const match = re.exec(text)
          if (match) {
            const bytesBefore = Buffer.byteLength(text.slice(0, match.index + match[0].length), 'utf8')
            if (from === undefined) this.tailCursor = Math.max(this.tailCursor, fromClamped + bytesBefore)
            return {
              matched: true,
              idle: false,
              index,
              pattern: String(list[index]),
              match: match[0],
              groups: match.slice(1),
              cursor: fromClamped + bytesBefore,
              from: requested,
              text,
              elapsedMs: Date.now() - startedAt,
            }
          }
        }
        scannedTo = to
      }
      if (idleMs > 0 && scannedTo > requested && this.ring.lastWriteAt > 0 &&
        Date.now() - this.ring.lastWriteAt >= idleMs) {
        return {
          matched: false,
          idle: true,
          index: -1,
          pattern: null,
          match: null,
          groups: [],
          cursor: from,
          from: requested,
          text: lastText,
          scannedTo,
          elapsedMs: Date.now() - startedAt,
        }
      }
      if (Date.now() >= deadline || this.state !== 'open') {
        return {
          matched: false,
          idle: false,
          index: -1,
          pattern: null,
          match: null,
          groups: [],
          cursor: from,
          from: requested,
          text: lastText,
          scannedTo,
          elapsedMs: Date.now() - startedAt,
        }
      }
      // Wake up at the idle boundary as well as at the hard deadline, otherwise
      // a silent console would make idleMs behave like a full timeout.
      const idleAt = idleMs > 0 ? this.ring.lastWriteAt + idleMs + 10 : Infinity
      await this.#waitForData(Math.min(deadline, idleAt))
    }
  }

  /**
   * Find where the console echo of `sentText` ends, so expect() can search
   * only the output that follows it. Returns `baseline` when no echo shows up
   * (console echo disabled, or a TUI that redraws instead of echoing).
   * @param {number} baseline - ring offset before the write.
   * @param {string} sentText - the logical command (no line terminator).
   * @param {number} waitMs - how long to wait for the echo to appear.
   */
  async #afterEcho(baseline, sentText, waitMs) {
    const needle = String(sentText).trim()
    if (!needle) return baseline
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const windowEnd = Math.min(this.ring.end, baseline + 8192)
      if (windowEnd > baseline) {
        const text = this.ring.text(baseline, windowEnd, this.encoding)
        const at = text.indexOf(needle)
        if (at >= 0) {
          const after = at + needle.length
          const nl = text.indexOf('\n', after)
          if (nl >= 0) {
            return baseline + Buffer.byteLength(text.slice(0, nl + 1), 'utf8')
          }
          // Some consoles echo CR only; treat CR+next byte as the line end.
          const cr = text.indexOf('\r', after)
          if (cr >= 0 && cr + 1 < text.length) {
            return baseline + Buffer.byteLength(text.slice(0, cr + 1), 'utf8')
          }
        }
      }
      if (Date.now() >= deadline || this.state !== 'open') return baseline
      await sleep(20)
    }
  }

  /**
   * Send a line and wait for output; the workhorse for shell/U-Boot consoles.
   *
   * Echo handling: the search window starts *after* the echoed command line, so
   * an expect pattern may legitimately contain words from the command (login:,
   * grep, php, ...) without matching its own echo. If no echo is detected the
   * old post-hoc strip stays as a fallback.
   *
   * `captureExitCode` appends a runtime-built printf marker (a nonce, so it can
   * never appear in the echoed command) and returns the shell's exit status.
   *
   * `verify` runs the command through `tee` and asks the board for the sha256 of
   * the bytes it produced, so a corrupted capture is *detected* instead of being
   * silently shortened by a link that drops bytes. It re-executes the command on
   * mismatch, so only use it for idempotent commands.
   * @param {{data:string, patterns?:string[], timeoutMs?:number, newline?:string, stripEcho?:boolean, captureExitCode?:boolean, idleMs?:number, verify?:boolean, verifyAttempts?:number}} opts
   */
  async transact({ data, patterns, timeoutMs = 8000, newline = 'cr', stripEcho = true, captureExitCode = false, idleMs = 0, verify = false, verifyAttempts = 2 } = {}) {
    if (verify) {
      return this.#verifiedTransact({ data, timeoutMs, newline, stripEcho, idleMs, verifyAttempts })
    }
    const sent = String(data ?? '')
    const rcNonce = captureExitCode ? randomBytes(4).toString('hex') : undefined
    const rcSource = rcNonce ? `__DSH_RC_${rcNonce}=(\\d+)__` : undefined
    const line = captureExitCode ? `${sent}; printf '\\n__DSH_RC_${rcNonce}=%d__\\n' $?` : sent
    const payload = /\r|\n$/.test(line) ? line : line + newlineOf(newline)
    const baseline = this.ring.end
    await this.writeText(Buffer.from(payload, 'utf8'))

    const searchFrom = stripEcho ? await this.#afterEcho(baseline, sent, 500) : baseline
    const echoSkipped = searchFrom > baseline
    const waitPatterns = captureExitCode ? [rcSource] : (Array.isArray(patterns) && patterns.length > 0 ? patterns : undefined)

    if (waitPatterns) {
      const result = await this.expect({ from: searchFrom, patterns: waitPatterns, timeoutMs, idleMs })
      const end = result.matched ? result.cursor : result.scannedTo
      this.tailCursor = Math.max(this.tailCursor, end)
      let text = this.ring.text(searchFrom, end, this.encoding)
      let exitCode = null
      if (captureExitCode) {
        const found = new RegExp(rcSource).exec(text)
        if (found) {
          exitCode = Number(found[1])
          text = text.slice(0, found.index)
        }
      }
      if (!echoSkipped && stripEcho) text = stripEchoText(text, sent)
      const timedOut = !result.matched && !result.idle
      // A console that printed the prompt is done, even if the pattern we
      // waited for never appeared (a command that exits quietly, a prompt with
      // a different shape). Reporting that as "timed out" makes callers re-run
      // commands whose output they already have.
      const promptSeen = timedOut && looksLikePrompt(text)
      const link = this.linkWarnings(searchFrom, end)
      return {
        matched: result.matched,
        idle: result.idle === true,
        match: result.match,
        groups: result.groups,
        text,
        exitCode,
        marker: rcNonce ? `__DSH_RC_${rcNonce}__` : undefined,
        cursor: result.cursor,
        from: baseline,
        searchFrom,
        to: end,
        /** Everything the console sent after the command (echo included). */
        bytesReceived: Math.max(0, end - baseline),
        /** Output after the echoed command line. */
        tailBytes: Math.max(0, end - searchFrom),
        echoSeen: echoSkipped,
        timedOut: timedOut && !promptSeen,
        promptSeen,
        status: result.matched ? 'ok' : (promptSeen ? 'timeout-but-prompt-seen' : (result.idle ? 'idle' : 'timeout')),
        linkWarnings: link.count,
        untrusted: link.count > 0,
        elapsedMs: result.elapsedMs,
      }
    }

    await sleep(Math.min(timeoutMs, 300))
    let raw = this.ring.text(searchFrom, this.ring.end, this.encoding)
    if (!echoSkipped && stripEcho) raw = stripEchoText(raw, sent)
    this.tailCursor = Math.max(this.tailCursor, this.ring.end)
    return {
      matched: false,
      idle: false,
      match: null,
      groups: [],
      text: raw,
      exitCode: null,
      cursor: this.ring.end,
      from: baseline,
      searchFrom,
      to: this.ring.end,
      bytesReceived: Math.max(0, this.ring.end - baseline),
      tailBytes: Math.max(0, this.ring.end - searchFrom),
      echoSeen: echoSkipped,
      timedOut: false,
      promptSeen: false,
      status: 'ok',
      linkWarnings: 0,
      untrusted: false,
      elapsedMs: 0,
    }
  }

  /**
   * Run a command with end-to-end integrity checking.
   *
   * The command's stdout+stderr is teed to a temp file on the board; the board
   * then prints that file's sha256 and size. If the bytes we captured hash to
   * the same value, the live capture was clean. If not — the normal case for
   * large outputs on a link without flow control — the tee'd file is fetched
   * back over the chunked verified reader, so the caller still gets the exact
   * bytes instead of a silently shortened copy.
   */
  async #verifiedTransact({ data, timeoutMs, newline, stripEcho, idleMs, verifyAttempts }) {
    const sent = String(data ?? '')
    const attempts = Math.max(1, Math.min(5, Number(verifyAttempts) || 2))
    let last = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const nonce = randomBytes(4).toString('hex')
      const tmp = `/tmp/.dshv_${nonce}.out`
      const startMarker = `__DSH_S_${nonce}`
      const endPrefix = `__DSH_V_${nonce}`
      const source = `${endPrefix} ([0-9a-f]{64}) (\\d+) (\\d*)`
      // The markers are assembled at runtime ("__DSH""_S_x"), so the echoed
      // command line never contains them contiguously. That matters because the
      // echo itself can arrive mangled on a lossy link: if expect() matched the
      // echo, the hash window would start inside the command line and every
      // verify would report a bogus mismatch.
      // The bytes hashed are exactly what tee wrote: no prompt, no
      // bracketed-paste escape, no newline from the reporting printf.
      // PIPESTATUS keeps the command's own status even though it now runs in a
      // pipeline; tee's status would hide a failed command.
      const line = `S="__DSH""_S_${nonce}"; V="__DSH""_V_${nonce}"; printf '%s\\n' "$S"; { ${sent} ; } 2>&1 | tee ${tmp}; ` +
        `__rc=\${PIPESTATUS[0]}; __h=$(sha256sum < ${tmp} | cut -c1-64); __s=$(wc -c < ${tmp}); ` +
        `printf '%s %s %s %s\\n' "$V" "$__h" "$__s" "$__rc"`
      const payload = /\r|\n$/.test(line) ? line : line + newlineOf(newline)
      const baseline = this.ring.end
      await this.writeText(Buffer.from(payload, 'utf8'))
      const searchFrom = stripEcho ? await this.#afterEcho(baseline, sent, 500) : baseline
      const startHit = await this.expect({ from: searchFrom, patterns: [startMarker], timeoutMs, idleMs: 0 })
      const end = startHit.matched
        ? (await this.expect({ from: startHit.cursor, patterns: [source], timeoutMs, idleMs: 0 }))
        : startHit
      const to = end.matched ? end.cursor : (end.scannedTo ?? startHit.cursor ?? searchFrom)
      // Skip the newline that belong to the start-marker line itself: it is not
      // part of what tee wrote, and counting it would offset the whole hash.
      let contentStart = startHit.cursor
      if (startHit.matched) {
        const peek = this.ring.text(contentStart, Math.min(contentStart + 2, this.ring.end), this.encoding)
        if (peek.startsWith('\r\n')) contentStart += 2
        else if (peek.startsWith('\n') || peek.startsWith('\r')) contentStart += 1
      }
      this.tailCursor = Math.max(this.tailCursor, to)
      const window = startHit.matched ? this.ring.text(contentStart, to, this.encoding) : this.ring.text(searchFrom, to, this.encoding)
      const found = end.matched ? new RegExp(source).exec(window) : null
      if (!startHit.matched || !found) {
        last = {
          matched: false,
          idle: end.idle === true,
          match: null,
          groups: [],
          text: window,
          exitCode: null,
          from: baseline,
          searchFrom,
          to,
          cursor: to,
          timedOut: !end.idle,
          promptSeen: false,
          status: 'verify-unavailable',
          bytesReceived: Math.max(0, to - baseline),
          echoSeen: searchFrom > baseline,
          verify: { attempted: true, ok: false, attempts: attempt, reason: 'no integrity marker' },
          integrity: 'unknown',
          linkWarnings: 0,
          untrusted: false,
          elapsedMs: end.elapsedMs,
        }
        if (end.idle) break
        continue
      }
      const content = window.slice(0, found.index)
      // The tty maps every '\n' the command wrote into '\r\n'; undo that so the
      // hash covers the same bytes the board hashed.
      const localBuf = Buffer.from(content.replace(/\r\n/g, '\n'), 'utf8')
      const localSha = createHash('sha256').update(localBuf).digest('hex')
      const remoteSha = found[1]
      const remoteSize = Number(found[2])
      const rc = found[3] === '' ? null : Number(found[3])
      const ok = localSha === remoteSha && localBuf.length === remoteSize
      const link = this.linkWarnings(searchFrom, to)
      last = {
        matched: true,
        idle: false,
        match: found[0],
        groups: found.slice(1),
        text: content,
        exitCode: rc,
        from: baseline,
        searchFrom,
        to,
        cursor: to,
        timedOut: false,
        promptSeen: true,
        status: ok ? 'ok' : 'verify-mismatch',
        bytesReceived: Math.max(0, to - baseline),
        echoSeen: searchFrom > baseline,
        verify: {
          ok,
          captureOk: ok,
          attempts: attempt,
          remoteSha,
          localSha,
          remoteSize,
          localSize: localBuf.length,
        },
        integrity: ok ? 'verified' : 'mismatch',
        linkWarnings: link.count,
        untrusted: !ok || link.count > 0,
        elapsedMs: end.elapsedMs,
      }
      if (ok) {
        await this.writeText(`rm -f ${tmp}\r`)
        return last
      }
      // The live capture lost bytes (high-baud links drop them in bursts, so a
      // 14 KB output is almost never clean). Fetch the tee'd file through the
      // chunked verified reader instead: every chunk carries its own sha256 and
      // only bad chunks are re-sent, so this converges even on a bad link.
      const localTmp = join(tmpdir(), `dsh-verify-${nonce}.out`)
      let pulled = null
      try {
        pulled = await this.manager.pull({ remotePath: tmp, localPath: localTmp, attempts })
      } catch (error) {
        this.#recordOp('verify', `verified fetch failed: ${error.message}`)
      }
      await this.writeText(`rm -f ${tmp}\r`)
      if (pulled?.ok) {
        const buf = readFileSync(localTmp)
        try { unlinkSync(localTmp) } catch { /* ignore */ }
        last.text = buf.toString(this.encoding)
        last.verify = {
          ...last.verify,
          ok: true,
          captureOk: false,
          fetched: 'chunked',
          remoteSha,
          localSha: pulled.localSha,
          remoteSize,
          localSize: buf.length,
        }
        last.integrity = 'verified'
        last.status = 'ok'
        last.untrusted = link.count > 0
        this.#recordOp('verify', `live capture was corrupt; fetched ${buf.length} bytes over the verified chunked path`)
        return last
      }
      this.#recordOp('verify', `attempt ${attempt}/${attempts}: sha256 mismatch, ${localBuf.length}/${remoteSize} bytes`)
    }
    return last
  }

  /** Convert a tool cursor argument into an absolute byte offset. */
  resolveCursor(from) {
    if (from === 'start') return this.ring.start
    if (from === 'tail' || from === undefined) return Math.max(this.tailCursor, this.ring.start)
    if (from === 'end') return this.ring.end
    const value = Number(from)
    if (!Number.isFinite(value)) return Math.max(this.tailCursor, this.ring.start)
    return Math.max(0, Math.floor(value))
  }

  /** Wait for RX data or until the deadline; safe to call concurrently. */
  #waitForData(deadline) {
    return new Promise((resolve) => {
      const remaining = Math.max(0, deadline - Date.now())
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.off('rx', finish)
        this.off('closed', finish)
        resolve()
      }
      const timer = setTimeout(finish, remaining)
      this.once('rx', finish)
      this.once('closed', finish)
    })
  }

  // --------------------------------------------------------------- rules
  /** Auto-responder rules; each fires when a *newly arrived* byte completes its match. */

  /** Add an auto-responder rule (fires on RX that completes the match). */
  addRule({ name, pattern, send, once = false, cooldownMs = 1200 }) {
    if (!pattern) throw new Error('rule needs a pattern')
    if (!send) throw new Error('rule needs a send string')
    const rule = {
      name: name || `rule-${this.#rules.length + 1}`,
      pattern: String(pattern),
      source: String(pattern),
      re: new RegExp(String(pattern), 'm'),
      send: String(send),
      once: Boolean(once),
      cooldownMs: Number(cooldownMs) || 0,
      lastFiredAt: 0,
      fired: false,
      fireCount: 0,
    }
    this.#rules.push(rule)
    this.#recordOp('rule:add', `${rule.name} /${rule.pattern}/ -> ${JSON.stringify(rule.send)}`)
    return rule
  }

  /** Remove one rule by name (or all when name is omitted). */
  removeRule(name) {
    const before = this.#rules.length
    this.#rules = name ? this.#rules.filter((rule) => rule.name !== name) : []
    this.#recordOp('rule:remove', name ?? 'all')
    return before - this.#rules.length
  }

  /** Rule list for status output. */
  listRules() {
    return this.#rules.map(({ name, pattern, send, once, cooldownMs, fireCount, fired }) => ({
      name, pattern, send, once, cooldownMs, fireCount, fired,
    }))
  }

  /** Evaluate auto-responders against the newest bytes. */
  #evalRules(chunk) {
    if (this.#rules.length === 0) return
    const windowBytes = Math.min(this.ring.size, chunk.length + 256)
    const windowStart = this.ring.end - windowBytes
    const text = this.ring.text(windowStart, this.ring.end, this.encoding)
    const freshBytes = chunk.length
    for (const rule of this.#rules) {
      if (this.state !== 'open') return
      try {
        rule.re.lastIndex = 0
        const match = rule.re.exec(text)
        if (!match) continue
        const matchByteEnd = windowStart + Buffer.byteLength(text.slice(0, match.index + match[0].length), 'utf8')
        // Only fire when the match is completed by bytes that just arrived.
        if (matchByteEnd <= this.ring.end - freshBytes) continue
        if (rule.once && rule.fired) continue
        const now = Date.now()
        if (now - rule.lastFiredAt < rule.cooldownMs) continue
        rule.lastFiredAt = now
        rule.fired = true
        rule.fireCount += 1
        this.#recordOp('rule:fire', `${rule.name} matched ${JSON.stringify(match[0])}`)
        this.writeText(rule.send).catch((error) => {
          this.#recordOp('rule:error', `${rule.name}: ${error.message}`)
        })
      } catch (error) {
        this.#recordOp('rule:error', `${rule.name}: ${error.message}`)
      }
    }
  }

  /** Recent operations (in memory, not a log file). */
  #recordOp(op, detail) {
    this.ops.push({ ts: Date.now(), op, detail })
    if (this.ops.length > 200) this.ops.shift()
  }

  /** @param {number} [limit] */
  recentOps(limit = 20) {
    return this.ops.slice(-limit)
  }

  /** Machine-readable status. */
  status() {
    return {
      id: this.id,
      port: this.port,
      baud: this.baud,
      dataBits: this.dataBits,
      parity: this.parity,
      stopBits: this.stopBits,
      flowControl: this.flowControl,
      state: this.state,
      pid: this.pid,
      openedAt: this.openedAt,
      uptimeMs: Date.now() - this.openedAt,
      bufferedBytes: this.ring.size,
      bufferCapacity: this.ring.capacity,
      receivedBytes: this.ring.receivedBytes,
      droppedBytes: this.ring.droppedBytes,
      firstByteAt: this.ring.firstWriteAt,
      lastByteAt: this.ring.lastWriteAt,
      lastByteAgeMs: this.ring.lastWriteAt ? Date.now() - this.ring.lastWriteAt : null,
      cursorStart: this.ring.start,
      cursorEnd: this.ring.end,
      tailCursor: this.tailCursor,
      unreadBytes: this.ring.end - this.tailCursor,
      txBytes: this.txBytes,
      rxEvents: this.rxEvents,
      /** Bytes the OS admitted to dropping in transit (not ring overflow). */
      linkErrors: this.linkErrorCount,
      linkFlags: this.linkFlags,
      linkLastAt: this.linkEvents.length > 0 ? this.linkEvents[this.linkEvents.length - 1].ts : null,
      /** false = this OS has no driver loss counters; 0 linkErrors is not proof. */
      linkWatch: this.linkWatch,
      dtr: this.dtr,
      rts: this.rts,
      rules: this.#rules.length,
      lastError: this.lastError,
      stderrTail: this.stderrTail.slice(-800),
    }
  }

  /** Close the port: ack, then kill the sidecar if it lingers. */
  async close() {
    if (this.state === 'closed') return
    const dead = this.state === 'failed' || this.state === 'closing'
    this.state = 'closing'
    if (dead) {
      // The reader already died; there is nobody to ack. Kill and move on so a
      // reopen does not have to wait out a send timeout.
      try { this.#child?.kill() } catch { /* ignore */ }
    } else {
      try {
        await this.#send({ op: 'close' }, 2000)
      } catch { /* ignore */ }
    }
    await Promise.race([this.#closedPromise ?? Promise.resolve(), sleep(1200)])
    if (this.state !== 'closed') {
      try {
        this.#child?.kill()
      } catch { /* ignore */ }
      await Promise.race([this.#closedPromise ?? Promise.resolve(), sleep(800)])
    }
    this.state = 'closed'
    if (!this.closedAt) this.closedAt = Date.now()
  }
}

/** Map a parity name to the single-letter pyserial code. */
function parityCode(parity) {
  const p = String(parity || 'none').toLowerCase()
  if (p === 'even') return 'E'
  if (p === 'odd') return 'O'
  if (p === 'mark') return 'M'
  if (p === 'space') return 'S'
  return 'N'
}

/** Newline string for a tool's `newline` argument. */
export function newlineOf(mode) {
  switch (String(mode || 'cr').toLowerCase()) {
    case 'none': return ''
    case 'lf': return '\n'
    case 'crlf': return '\r\n'
    case 'cr':
    default: return '\r'
  }
}

/** Quote a remote path for a POSIX shell (double quotes + escaped metachars). */
function shellQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

/** Human description of sent bytes for the ops list. */
function describeBytes(buf) {
  const text = buf.toString('utf8')
  const printable = /^[\x20-\x7e\r\n\t]*$/.test(text)
  if (printable) return JSON.stringify(tail(text, 120))
  return `${buf.length} bytes ${buf.subarray(0, 24).toString('hex')}…`
}

/** Remove the console's echo of the command we just sent. */
export function stripEchoText(text, sent) {
  const needle = String(sent).trim()
  if (!needle) return text
  const idx = text.indexOf(needle)
  if (idx < 0 || idx > 64) return text
  const lineEnd = text.indexOf('\n', idx)
  if (lineEnd < 0) return ''
  return text.slice(lineEnd + 1)
}

/**
 * True when the last non-empty line looks like a shell/U-Boot prompt.
 *
 * Used to turn "the pattern I waited for never matched, but the console is back
 * at a prompt" into a success: the output is complete, only the expected regex
 * was wrong.
 */
export function looksLikePrompt(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return false
  const last = lines[lines.length - 1].trim()
  return /[$#>\]]$/.test(last) || /[$#>]$/.test(last)
}

/**
 * Multi-port manager: sessions, defaults, probes and file transfers.
 */
export class SerialManager {
  /**
   * @param {{getConfig:() => Record<string, any>, log?: (msg:string)=>void, stateFile?: string|null}} opts
   */
  constructor({ getConfig, log, stateFile }) {
    this.getConfig = getConfig
    this.log = log ?? (() => {})
    /** Live sessions, keyed by session id (the port name). @type {Map<string, SerialSession>} */
    this.sessions = new Map()
    /**
     * One ring per port, keyed by lower-case port name.
     *
     * The ring deliberately outlives the session that filled it. When a reader
     * dies at 02:07, the bytes that arrived just before are the evidence an
     * operator wants most; dropping them on the next open would throw it away.
     * A new session on the same port re-attaches the ring and continues its
     * absolute cursor space, so unread output stays readable.
     * @type {Map<string, {port:string, ring:RingBuffer, tailCursor:number, lastUsedAt:number, retired?:Record<string,any>}>}
     */
    this.buffers = new Map()
    /** How many ports keep their history in memory (each up to bufferBytes). */
    this.maxRetainedPorts = 8
    /** Session id tools default to; it may point at a retained (closed) port. */
    this.defaultId = undefined
    /** Events the next tool result has to surface (a dead reader is one). */
    this.notices = []
    /** Remembers the last port that actually opened, across restarts. */
    this.stateFile = stateFile === null ? null : (stateFile || statePath())
    this.state = { lastPort: undefined, lastBaud: undefined, updatedAt: 0 }
    this.#loadState()
    this.#portsCache = undefined
    this.#portsCacheAt = 0
  }

  #portsCache
  #portsCacheAt

  /** Current config, resolved once per call. */
  cfg() {
    const raw = this.getConfig() || {}
    return {
      defaultPort: raw.defaultPort || '',
      defaultBaud: Number(raw.defaultBaud) || 1500000,
      dataBits: Number(raw.dataBits) || 8,
      parity: raw.parity || 'none',
      stopBits: Number(raw.stopBits) || 1,
      flowControl: raw.flowControl || 'none',
      dtr: typeof raw.dtr === 'boolean' ? raw.dtr : undefined,
      rts: typeof raw.rts === 'boolean' ? raw.rts : undefined,
      bufferBytes: Number(raw.bufferBytes) || 4 * 1024 * 1024,
      pythonPath: raw.pythonPath || DEFAULT_PYTHON,
      encoding: raw.encoding || 'utf8',
    }
  }

  /** Look up a live session by session id or port name (case-insensitive). */
  #live(ref) {
    const wanted = String(ref).toLowerCase()
    for (const session of this.sessions.values()) {
      if (session.id.toLowerCase() === wanted || session.port.toLowerCase() === wanted) return session
    }
    return undefined
  }

  /** One-line explanation for a port whose session is gone but whose bytes are not. */
  #goneMessage(entry) {
    const when = entry.retired ? clock(entry.retired.closedAt) : 'earlier'
    const why = entry.retired?.reason ? ` (${entry.retired.reason})` : ''
    const unread = Math.max(0, entry.ring.end - entry.tailCursor)
    return `serial session ${entry.port} ended at ${when}${why}. ` +
      `${entry.ring.size} B of its buffer are retained (${unread} B unread, tail cursor ${entry.tailCursor}). ` +
      `Run serial_open port=${entry.port} to resume on the same port, or serial_close session=${entry.port} dropBuffer=true to discard the buffer.`
  }

  /** The session a tool call should use (explicit id, else the default). */
  get(args = {}) {
    if (args.session) {
      const direct = this.#live(args.session)
      if (direct) return direct
      const entry = this.buffers.get(String(args.session).toLowerCase())
      if (entry) throw new Error(this.#goneMessage(entry))
      const open = [...this.sessions.values()].map((session) => session.port)
      throw new Error(`no open serial session '${args.session}'${open.length ? ` (open: ${open.join(', ')})` : ''} (use serial_list / serial_open)`)
    }
    if (this.defaultId) {
      const session = this.sessions.get(this.defaultId)
      if (session && session.state === 'open') return session
    }
    return [...this.sessions.values()].find((session) => session.state === 'open')
  }

  /**
   * Get or open a session.
   *
   * Port-safety rule: once a port is known — open, or closed with a retained
   * buffer — a tool call never silently falls back to `config.defaultPort`. A
   * dead session is reopened on *its own* port; if that fails, the error names
   * that port and the reason instead of quietly opening a different device.
   * Only when nothing is known at all is the remembered (last successfully
   * used) port opened, and even that is announced as a notice.
   * @param {{session?:string, port?:string, baud?:number}} [args]
   */
  async ensureSession(args = {}) {
    if (args.port) {
      const live = this.#live(String(args.port))
      if (live && live.state === 'open') return live
      return this.open({ port: String(args.port), baud: args.baud })
    }
    if (args.session) {
      const live = this.#live(String(args.session))
      if (live && live.state === 'open') return live
      if (live) {
        this.#retire(live, live.failReason || live.lastError || 'session ended')
        return this.#reopen(this.buffers.get(live.port.toLowerCase()), live.port)
      }
      const known = [...this.sessions.values()].map((session) => session.port)
      throw new Error(`no serial session '${args.session}'${known.length ? ` (open: ${known.join(', ')})` : ''}; call serial_open port=${args.session} if that is the device you mean`)
    }
    if (this.defaultId) {
      const session = this.sessions.get(this.defaultId)
      if (session && session.state === 'open') return session
      const entry = this.buffers.get(this.defaultId.toLowerCase())
      if (entry) {
        if (session) this.#retire(session, session.failReason || session.lastError || 'session ended')
        return this.#reopen(entry, entry.port)
      }
    }
    const liveAny = [...this.sessions.values()].find((session) => session.state === 'open')
    if (liveAny) return liveAny

    // Nothing is open and nothing is retained. The remembered port beats the
    // config default: after an adapter moves to another COM number the config
    // is stale, while "the port that worked last" is usually right.
    const cfg = this.cfg()
    const remembered = this.state.lastPort
    if (remembered) {
      const live = this.#live(remembered)
      if (live && live.state === 'open') return live
      const entry = this.buffers.get(remembered.toLowerCase())
      if (entry) return this.#reopen(entry, remembered)
      this.#note(`no session was open; auto-opened the last successfully used port ${remembered}` +
        (cfg.defaultPort && cfg.defaultPort.toLowerCase() !== remembered.toLowerCase()
          ? ` (config.defaultPort is ${cfg.defaultPort}, which was NOT used)`
          : ''))
      return this.open({ port: remembered, baud: args.baud ?? this.state.lastBaud ?? cfg.defaultBaud })
    }
    if (!cfg.defaultPort) {
      throw new Error(`no session is open, no port has been used yet and config.defaultPort is empty; run serial_list, then serial_open port=${portExample()}`)
    }
    this.#note(`no session was open and no port has been used yet; auto-opened the configured default port ${cfg.defaultPort} — pass port/session explicitly if this is the wrong device`)
    return this.open({ port: cfg.defaultPort, baud: args.baud ?? cfg.defaultBaud })
  }

  /**
   * Reopen a port that still has a retained buffer. Never touches another port.
   *
   * One retry after a short pause: when a reader dies, the OS can take a moment
   * to release the handle, and the useful answer is the retained buffer, not a
   * spurious "access denied".
   * @param {any} entry
   * @param {string} port
   */
  async #reopen(entry, port) {
    if (!entry) throw new Error(`no retained buffer for ${port}`)
    const closed = entry.retired
    const attempt = () => this.open({
      port,
      baud: closed?.baud,
      dataBits: closed?.dataBits,
      parity: closed?.parity,
      stopBits: closed?.stopBits,
      flowControl: closed?.flowControl,
      dtr: closed?.dtr,
      rts: closed?.rts,
      bufferBytes: entry.ring.capacity,
    })
    let lastError
    for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
      if (tryIndex > 0) await sleep(300)
      try {
        return await attempt()
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(
      `serial session ${port} ended at ${clock(closed?.closedAt)}${closed?.reason ? ` (${closed.reason})` : ''} and reopening ${port} failed: ${lastError?.message ?? 'unknown error'}. ` +
      `No other port was opened. ${entry.ring.size} B of its buffer are still retained — serial_list shows the adapters, serial_close session=${port} dropBuffer=true discards the buffer.`,
    )
  }

  /**
   * Open one port (or hand back the live session on it).
   *
   * A retained ring is re-attached, so `serial_read` after a reader crash still
   * returns the bytes that were arriving when it died, and absolute cursors
   * stay meaningful across sessions.
   * @param {{port:string, baud?:number, dataBits?:number, parity?:string, stopBits?:number, flowControl?:string, dtr?:boolean, rts?:boolean, bufferBytes?:number, description?:string}} args
   */
  async open(args) {
    if (!args.port) throw new Error(`serial_open needs a port (e.g. ${portExample()})`)
    const cfg = this.cfg()
    const port = String(args.port)
    const key = port.toLowerCase()
    // macOS exposes both the dial-in (/dev/tty.*) and the callout (/dev/cu.*)
    // device for one adapter. tty.* waits for carrier and can block a tool call
    // for seconds; cu.* is the one pyserial lists and the one a console wants.
    if (IS_MAC && port.startsWith('/dev/tty.')) {
      this.#note(`opening ${port}: on macOS use the callout device /dev/cu.${port.slice('/dev/tty.'.length)} — /dev/tty.* waits for carrier (DCD) and can hang the open; serial_list reports /dev/cu.*`)
    }
    const live = this.#live(port)
    if (live && live.state === 'open') {
      // Already open: the carry-over report belongs to the open that attached it.
      live.carry = null
      return live
    }
    if (live) this.#retire(live, live.failReason || live.lastError || 'session ended')

    const previous = this.buffers.get(key)
    const ring = previous?.ring ?? new RingBuffer(Number(args.bufferBytes) || cfg.bufferBytes)
    const tailCursor = previous ? clamp(previous.tailCursor, ring.start, ring.end) : ring.end
    const session = new SerialSession({
      manager: this,
      id: port,
      port,
      ring,
      tailCursor,
      baud: Number(args.baud) || previous?.retired?.baud || cfg.defaultBaud,
      dataBits: args.dataBits ?? previous?.retired?.dataBits ?? cfg.dataBits,
      parity: args.parity ?? previous?.retired?.parity ?? cfg.parity,
      stopBits: args.stopBits ?? previous?.retired?.stopBits ?? cfg.stopBits,
      flowControl: args.flowControl ?? previous?.retired?.flowControl ?? cfg.flowControl,
      dtr: args.dtr ?? previous?.retired?.dtr ?? cfg.dtr,
      rts: args.rts ?? previous?.retired?.rts ?? cfg.rts,
      pythonPath: cfg.pythonPath,
      encoding: cfg.encoding,
      description: args.description,
    })
    session.carry = previous
      ? {
          retained: ring.size,
          unread: Math.max(0, ring.end - tailCursor),
          cursorStart: ring.start,
          cursorEnd: ring.end,
          tailCursor,
          closedAt: previous.retired?.closedAt ?? null,
          reason: previous.retired?.reason ?? null,
        }
      : null
    this.sessions.set(session.id, session)
    this.#attach(session)
    this.log(`opening ${port} @ ${session.baud}${previous && ring.size > 0 ? ` (reattaching ${ring.size} buffered bytes)` : ''}`)
    try {
      await session.start()
    } catch (error) {
      this.sessions.delete(session.id)
      session.retired = true
      if (ring.size > 0) {
        this.buffers.set(key, previous ?? { port, ring, tailCursor, lastUsedAt: Date.now() })
      }
      throw new Error(`cannot open ${port}: ${error.message}${session.lastError ? ` (${session.lastError})` : ''}`)
    }
    session.everOpen = true
    const entry = previous ?? { port, ring, tailCursor, lastUsedAt: Date.now() }
    entry.port = port
    entry.ring = ring
    entry.tailCursor = session.tailCursor
    entry.lastUsedAt = Date.now()
    entry.retired = undefined
    this.buffers.set(key, entry)
    session.bufferEntry = entry
    if (!this.defaultId || !this.sessions.has(this.defaultId)) this.defaultId = session.id
    this.#remember(port, session.baud)
    this.#trimBuffers(key)
    if (session.carry && session.carry.retained > 0) {
      this.#note(`re-attached ${port}: ${session.carry.retained} B retained from the previous session` +
        (session.carry.unread > 0 ? `, ${session.carry.unread} B unread — serial_read with no cursor returns them first` : '') +
        (session.carry.reason ? `; that session ended at ${clock(session.carry.closedAt)} (${session.carry.reason})` : ''))
    }
    return session
  }

  /** Watch a session so its death becomes a notice and its buffer a tombstone. */
  #attach(session) {
    session.once('fatal', (reason) => this.#retire(session, reason))
    session.once('closed', (info) => this.#retire(session, info?.reason))
  }

  /**
   * Take a session out of the live table and keep its ring for the next open.
   * @param {SerialSession} session
   * @param {string} [reason]
   */
  #retire(session, reason) {
    if (session.retired) return
    session.retired = true
    const key = session.port.toLowerCase()
    if (!session.everOpen && session.ring.size === 0) {
      this.sessions.delete(session.id)
      return
    }
    const unread = Math.max(0, session.ring.end - session.tailCursor)
    const entry = this.buffers.get(key) ?? { port: session.port, ring: session.ring, tailCursor: 0, lastUsedAt: 0 }
    entry.port = session.port
    entry.ring = session.ring
    entry.tailCursor = session.tailCursor
    entry.lastUsedAt = Date.now()
    entry.retired = {
      id: session.id,
      port: session.port,
      baud: session.baud,
      dataBits: session.dataBits,
      parity: session.parity,
      stopBits: session.stopBits,
      flowControl: session.flowControl,
      dtr: session.dtr,
      rts: session.rts,
      closedAt: session.closedAt ?? Date.now(),
      reason: reason || session.failReason || session.lastError || 'session closed',
      unread,
      linkErrors: session.linkErrorCount,
      linkWatch: session.linkWatch,
    }
    this.buffers.set(key, entry)
    this.sessions.delete(session.id)
    this.#trimBuffers(key)
    this.#note(`session ${session.port} ended at ${clock(entry.retired.closedAt)} (${entry.retired.reason})` +
      (session.ring.size > 0
        ? `; ${session.ring.size} B retained, ${unread} B unread — serial_open port=${session.port} resumes on the same port`
        : '; no bytes were buffered'))
  }

  /** Drop the least recently used retained ports above `maxRetainedPorts`. */
  #trimBuffers(keepKey) {
    const candidates = [...this.buffers.entries()]
      .filter(([key, entry]) => key !== keepKey && !this.#live(entry.port))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    while (this.buffers.size > this.maxRetainedPorts && candidates.length > 0) {
      const [key, entry] = candidates.shift()
      this.buffers.delete(key)
      this.#note(`dropped the retained buffer of ${entry.port} (${entry.ring.size} B) to keep history for at most ${this.maxRetainedPorts} ports`)
    }
  }

  /**
   * Close one session (or all). The ring is *kept* by default so the last
   * output before closing stays readable; pass dropBuffer=true to release it.
   */
  async close(args = {}) {
    const dropBuffer = args.dropBuffer === true
    const closed = []
    const retained = []
    const dropped = []
    const finish = async (session) => {
      await session.close()
      this.#retire(session, 'closed by request')
      const key = session.port.toLowerCase()
      const entry = this.buffers.get(key)
      if (entry) {
        if (dropBuffer) {
          this.buffers.delete(key)
          dropped.push({ port: session.port, bytes: entry.ring.size })
        } else {
          retained.push({ port: session.port, bytes: entry.ring.size, unread: Math.max(0, entry.ring.end - entry.tailCursor) })
        }
      }
      closed.push(session.id)
      if (this.defaultId === session.id) this.defaultId = undefined
    }
    if (args.all) {
      for (const session of [...this.sessions.values()]) await finish(session)
      this.defaultId = undefined
      return { closed, retained, dropped }
    }
    if (args.session) {
      const live = this.#live(args.session)
      if (live) {
        await finish(live)
        return { closed, retained, dropped }
      }
      const key = String(args.session).toLowerCase()
      const entry = this.buffers.get(key)
      if (!entry) throw new Error(`no serial session or retained buffer '${args.session}' (serial_list)`)
      if (dropBuffer) {
        this.buffers.delete(key)
        dropped.push({ port: entry.port, bytes: entry.ring.size })
        return { closed, retained, dropped }
      }
      throw new Error(this.#goneMessage(entry))
    }
    const session = this.get()
    if (!session) throw new Error('no serial session is open (serial_list shows live sessions and retained buffers)')
    await finish(session)
    return { closed, retained, dropped }
  }

  /** Status of every session (or one, including a retained closed port). */
  status(args = {}) {
    if (args.session) {
      const live = this.#live(args.session)
      if (live) return [live.status()]
      const entry = this.buffers.get(String(args.session).toLowerCase())
      if (entry) return [this.retiredStatus(entry)]
      throw new Error(`no serial session or retained buffer '${args.session}' (serial_list)`)
    }
    return [...this.sessions.values()].map((session) => session.status())
  }

  /** Session-shaped status for a port whose reader is gone but whose bytes remain. */
  retiredStatus(entry) {
    const retired = entry.retired ?? {}
    return {
      id: retired.id ?? entry.port,
      port: entry.port,
      baud: retired.baud,
      dataBits: retired.dataBits ?? 8,
      parity: retired.parity ?? 'none',
      stopBits: retired.stopBits ?? 1,
      flowControl: retired.flowControl ?? 'none',
      state: 'closed',
      pid: undefined,
      openedAt: undefined,
      uptimeMs: undefined,
      bufferedBytes: entry.ring.size,
      bufferCapacity: entry.ring.capacity,
      receivedBytes: entry.ring.receivedBytes,
      droppedBytes: entry.ring.droppedBytes,
      firstByteAt: entry.ring.firstWriteAt,
      lastByteAt: entry.ring.lastWriteAt,
      lastByteAgeMs: entry.ring.lastWriteAt ? Date.now() - entry.ring.lastWriteAt : null,
      cursorStart: entry.ring.start,
      cursorEnd: entry.ring.end,
      tailCursor: entry.tailCursor,
      unreadBytes: Math.max(0, entry.ring.end - entry.tailCursor),
      txBytes: undefined,
      rxEvents: undefined,
      linkErrors: retired.linkErrors ?? 0,
      linkFlags: 0,
      linkLastAt: null,
      linkWatch: retired.linkWatch,
      dtr: retired.dtr,
      rts: retired.rts,
      rules: 0,
      lastError: retired.reason,
      closedAt: retired.closedAt ?? null,
      stderrTail: '',
    }
  }

  /** Ports whose session ended but whose bytes are still in memory. */
  retainedBuffers() {
    return [...this.buffers.values()]
      .filter((entry) => !this.#live(entry.port))
      .map((entry) => ({
        port: entry.port,
        bytes: entry.ring.size,
        unread: Math.max(0, entry.ring.end - entry.tailCursor),
        tailCursor: entry.tailCursor,
        lastByteAt: entry.ring.lastWriteAt || null,
        closedAt: entry.retired?.closedAt ?? null,
        reason: entry.retired?.reason ?? null,
      }))
      .sort((a, b) => (b.lastByteAt || 0) - (a.lastByteAt || 0))
  }

  /** Take the pending notifications; each tool result surfaces them once. */
  drainNotices() {
    const list = this.notices
    this.notices = []
    return list
  }

  /** Queue one line for the next tool result. */
  #note(text) {
    if (!text) return
    this.notices.push(String(text))
    if (this.notices.length > 24) this.notices.shift()
  }

  /** Persist the runtime preference ("last port that worked"). */
  setDefault({ port, baud } = {}) {
    const target = port ? String(port) : undefined
    if (target) {
      this.#remember(target, baud ?? this.state.lastBaud)
      const live = this.#live(target)
      this.defaultId = live ? live.id : target
    } else if (baud) {
      this.state.lastBaud = Number(baud)
      this.state.updatedAt = Date.now()
      this.#saveState()
    }
    return { port: this.state.lastPort, baud: this.state.lastBaud, stateFile: this.stateFile, updatedAt: this.state.updatedAt }
  }

  #remember(port, baud) {
    this.state.lastPort = port
    const value = Number(baud)
    if (Number.isFinite(value) && value > 0) this.state.lastBaud = value
    this.state.updatedAt = Date.now()
    this.#saveState()
  }

  #loadState() {
    if (!this.stateFile) return
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      if (typeof raw.lastPort === 'string' && raw.lastPort) this.state.lastPort = raw.lastPort
      const baud = Number(raw.lastBaud)
      if (Number.isFinite(baud) && baud > 0) this.state.lastBaud = baud
      this.state.updatedAt = Number(raw.updatedAt) || 0
    } catch { /* first run, unparsable file: fall back to the config default */ }
  }

  #saveState() {
    if (!this.stateFile) return
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({
        lastPort: this.state.lastPort,
        lastBaud: this.state.lastBaud,
        updatedAt: this.state.updatedAt,
      }, null, 2), 'utf8')
      renameSync(tmp, this.stateFile)
    } catch (error) {
      this.log(`could not save ${this.stateFile}: ${error.message}`)
    }
  }

  /** System port list (cached for 5 s) annotated with our sessions. */
  async ports(force = false) {
    const now = Date.now()
    if (!force && this.#portsCache && now - this.#portsCacheAt < 5000) {
      return this.#portsCache.map((port) => ({ ...port }))
    }
    const cfg = this.cfg()
    const raw = await runOneShot(cfg.pythonPath, [SIDECAR, '--list'], 12000)
    const message = raw.lines.find((line) => line.startsWith('{'))
    if (!message) throw new Error('could not list serial ports' + (raw.stderr ? `: ${raw.stderr.slice(-400)}` : ''))
    const parsed = JSON.parse(message)
    const ports = (parsed.ports || []).map((port) => ({
      ...port,
      session: [...this.sessions.values()].find((s) => s.port.toLowerCase() === String(port.device).toLowerCase())?.id,
      retainedBytes: this.buffers.get(String(port.device).toLowerCase())?.ring.size ?? 0,
    }))
    this.#portsCache = ports
    this.#portsCacheAt = now
    return ports
  }

  /**
   * Try a set of baud rates against one port and report which one produces
   * readable console text (no data is sent, DTR/RTS are left untouched).
   */
  async probe({ port, bauds, perBaudMs = 1200, poke = true } = {}) {
    const cfg = this.cfg()
    const targetPort = port || this.defaultId || this.state.lastPort || cfg.defaultPort
    if (!targetPort) throw new Error('serial_probe needs a port')
    const candidates = Array.isArray(bauds) && bauds.length > 0
      ? bauds.map(Number)
      : [cfg.defaultBaud, 115200, 921600, 460800, 230400, 57600, 38400, 19200, 9600].filter((v, i, a) => a.indexOf(v) === i)
    const open = [...this.sessions.values()].find((s) => s.port.toLowerCase() === String(targetPort).toLowerCase())
    const results = []
    for (const baud of candidates) {
      if (open && open.state === 'open') {
        if (open.baud !== baud) await open.setBaud(baud)
        const before = open.ring.end
        await sleep(120)
        if (poke) await open.writeText('\r')
        await sleep(perBaudMs)
        const window = open.ring.slice(before, open.ring.end)
        results.push(scoreSample(baud, window, true))
        continue
      }
      let session
      try {
        session = new SerialSession({
          manager: this,
          id: `probe:${targetPort}`,
          port: targetPort,
          baud,
          dataBits: cfg.dataBits,
          parity: cfg.parity,
          stopBits: cfg.stopBits,
          flowControl: cfg.flowControl,
          dtr: cfg.dtr,
          rts: cfg.rts,
          bufferBytes: 64 * 1024,
          pythonPath: cfg.pythonPath,
          encoding: cfg.encoding,
        })
        await session.start()
        await sleep(120)
        if (poke) await session.writeText('\r')
        await sleep(perBaudMs)
        results.push(scoreSample(baud, session.ring.slice(0, session.ring.end), false))
      } catch (error) {
        results.push({ baud, ok: false, bytes: 0, printableRatio: 0, sample: '', error: error.message })
      } finally {
        await session?.close()
      }
    }
    return { port: targetPort, results }
  }

  /**
   * Push one local file to a Linux shell over the serial console (base64 +
   * heredoc). Verified by byte count *and* sha256, with one automatic retry on
   * mismatch. Aborts early when the console stops echoing payload lines, which
   * is the first sign that bytes are being lost.
   */
  async push({ localPath, remotePath, session: sessionId, sudo = false, chmod, chunkChars = 76, timeoutMs = 60000, attempts = 3 } = {}) {
    if (!localPath || !remotePath) throw new Error('serial_push needs localPath and remotePath')
    const data = readFileSync(localPath)
    const localSha = createHash('sha256').update(data).digest('hex')
    const session = await this.ensureSession({ session: sessionId })
    const tries = Math.max(1, Math.min(5, Math.floor(Number(attempts) || 3)))
    let last
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      last = await this.#pushOnce(session, { data, localSha, localPath, remotePath, sudo, chmod, chunkChars, timeoutMs, attempt })
      if (last.ok || last.retryable === false) return last
      if (attempt < tries) this.log(`push checksum mismatch, retrying (${last.error})`)
    }
    return last
  }

  /** One transfer attempt for {@link push}. */
  async #pushOnce(session, { data, localSha, localPath, remotePath, sudo, chmod, chunkChars, timeoutMs, attempt }) {
    const tag = `DSHPUSH_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
    const tmp = `/tmp/.${tag}.b64`
    const b64 = data.toString('base64')
    const lines = b64.match(new RegExp(`.{1,${Math.max(16, chunkChars)}}`, 'g')) || []
    const sudoPrefix = sudo ? 'sudo ' : ''
    const marker = `DSH_MARK_${randomBytes(4).toString('hex')}`
    // Build the marker at runtime: the echoed command line must not contain the
    // literal marker, otherwise expect() would match its own echo.
    const markerSetup = `M="DSH""_MARK_${marker.slice(9)}"`

    // 1. Open a quoted heredoc; the tag line below is the only terminator.
    await session.writeText(`cat > ${tmp} <<'${tag}'\r`)
    await sleep(150)

    // 2. Stream payload lines. The console echoes each line; waiting for that
    //    echo is the only reliable flow control on a raw tty, but some consoles
    //    have echo off —then fall back to fixed pacing. A sustained echo
    //    failure means the link is dropping bytes: abort before wasting minutes.
    let echoed = 0
    let echoTried = 0
    let paced = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const before = session.ring.end
      await session.writeText(line + '\r')
      if (!paced && echoed < 40) {
        echoTried += 1
        const seen = await session.expect({ from: before, patterns: [escapeRegExp(line)], timeoutMs: 500 })
        if (seen.matched) echoed += 1
        else paced = true
        if (echoTried >= 25 && echoed / echoTried < 0.3) {
          await session.writeText(`${tag}\r`)
          await session.writeText(`rm -f ${tmp}\r`)
          return {
            ok: false,
            retryable: false,
            attempt,
            localPath,
            bytes: data.length,
            remoteSize: null,
            transfer: { lines: lines.length, echoConfirmed: echoed, echoTried, paced },
            error: `console stopped echoing payload lines (${echoed}/${echoTried}); aborted to avoid a corrupt file —check the link/flow control and try serial_push again`,
          }
        }
      } else {
        paced = true
        await sleep(4)
      }
    }

    // 3. Terminate the heredoc, decode, verify size and sha256. Baseline is
    //    taken before the writes so bytes that land during them are not missed.
    const doneFrom = session.ring.end
    await session.writeText(`${tag}\r`)
    await session.writeText(`${markerSetup}; ${sudoPrefix}base64 -d ${tmp} > ${remotePath}${chmod ? ` && ${sudoPrefix}chmod ${chmod} ${remotePath}` : ''} && wc -c < ${remotePath} && sha256sum < ${remotePath} | cut -d' ' -f1 && echo $M\r`)

    const done = await session.expect({ from: doneFrom, patterns: [marker], timeoutMs })
    const window = done.matched ? done.text : ''
    const sizeMatch = /(?:^|[\r\n])(\d+)[\r\n]/.exec(window)
    const shaMatch = /(?:^|[\r\n])([0-9a-f]{64})[\r\n]/.exec(window)
    const remoteSize = sizeMatch ? Number(sizeMatch[1]) : null
    const remoteSha = shaMatch ? shaMatch[1] : null
    const sizeOk = remoteSize === null || remoteSize === data.length
    const shaOk = remoteSha === null || remoteSha === localSha
    const ok = done.matched && sizeOk && shaOk
    // 4. Clean the staging file up.
    await session.writeText(`rm -f ${tmp}\r`)
    return {
      ok,
      retryable: done.matched && (!sizeOk || !shaOk),
      attempt,
      localPath,
      remotePath,
      bytes: data.length,
      remoteSize,
      remoteSha,
      localSha,
      transfer: { lines: lines.length, echoConfirmed: echoed, echoTried, paced },
      error: ok ? undefined : (!done.matched
        ? 'transfer did not confirm (marker not seen); is the console at a Linux shell?'
        : `verification mismatch: size ${remoteSize}/${data.length}, sha256 ${remoteSha ?? 'n/a'}/${localSha}`),
    }
  }

  /**
   * Run a script on the board through the serial console.
   *
   * The script text is base64-encoded, materialised as a temp file on the
   * target, then executed by the chosen interpreter. Pipes, quotes, `$`,
   * heredocs and multi-line constructs therefore never travel through a single
   * command line —no shell-quoting accidents.
   *
   * Small scripts go in one `printf | base64 -d` line; larger ones reuse the
   * echo-confirmed streaming from push() to avoid tty input overruns.
   */
  async script({ script, interpreter = 'bash', sudo = false, session: sessionId, timeoutMs = 120000, cleanup = true } = {}) {
    if (!script || String(script).trim() === '') throw new Error('serial_script needs script text')
    const session = await this.ensureSession({ session: sessionId })
    const nonce = randomBytes(4).toString('hex')
    const tmp = `/tmp/.dsh_script_${nonce}.sh`
    const rcSource = `__DSH_RC_${nonce}=(\\d+)__`
    const sudoPrefix = sudo ? 'sudo ' : ''
    const interp = String(interpreter || 'bash').replace(/[^A-Za-z0-9_./-]/g, '') || 'bash'
    const b64 = Buffer.from(String(script), 'utf8').toString('base64')
    const steps = []

    // 1. Materialise the script file (no sudo needed: /tmp is user-writable).
    if (b64.length <= 1200) {
      const write = `printf %s '${b64}' | base64 -d > ${tmp}; printf '\\n__DSH_W_${nonce}=%d__\\n' $?`
      const written = await session.transact({ data: write, patterns: [`__DSH_W_${nonce}=(\\d+)__`], timeoutMs: 15000 })
      const code = new RegExp(`__DSH_W_${nonce}=(\\d+)__`).exec(written.text)
      steps.push({ step: 'write', mode: 'inline', bytes: b64.length, exitCode: code ? Number(code[1]) : null })
      if (!code) {
        return { ok: false, exitCode: null, output: 'could not confirm the script file was written —is the console at a Linux shell prompt?', steps }
      }
      if (Number(code[1]) !== 0) {
        return { ok: false, exitCode: null, output: `failed to write ${tmp} (exit ${code[1]})`, steps }
      }
    } else {
      const local = join(tmpdir(), `dsh-script-${nonce}.sh`)
      writeFileSync(local, String(script), 'utf8')
      try {
        const pushed = await this.push({ localPath: local, remotePath: tmp })
        steps.push({ step: 'write', mode: 'stream', bytes: b64.length, exitCode: pushed.ok ? 0 : null })
        if (!pushed.ok) return { ok: false, exitCode: null, output: `failed to upload script: ${pushed.error}`, steps }
      } finally {
        try { unlinkSync(local) } catch { /* ignore */ }
      }
    }

    // 2. Execute it and report the shell status. The marker is built inline so
    //    the echoed command cannot match it (the echo shows `%d`, not digits).
    const run = `${sudoPrefix}${interp} ${tmp}; printf '\\n__DSH_RC_${nonce}=%d__\\n' $?`
    const executed = await session.transact({ data: run, patterns: [rcSource], timeoutMs, idleMs: 0 })
    const found = new RegExp(rcSource).exec(executed.text)
    let output = executed.text
    let exitCode = null
    if (found) {
      exitCode = Number(found[1])
      output = output.slice(0, found.index)
    }
    if (cleanup) {
      await session.writeText(`rm -f ${tmp}\r`)
    }
    steps.push({ step: 'run', interpreter: interp, sudo, exitCode, matched: executed.matched })
    return {
      ok: executed.matched && exitCode === 0,
      exitCode,
      output,
      scriptBytes: Buffer.byteLength(String(script), 'utf8'),
      steps,
      error: executed.matched ? undefined : 'script did not finish before the timeout (marker not seen)',
    }
  }

  /**
   * Pull one remote file to this machine over the console.
   *
   * A bare UART at a high baud rate cannot sustain a long burst: the receiver
   * drops whole runs of bytes when the board prints as fast as the line allows,
   * and nothing in the surviving text shows it. So the base64 is streamed in
   * small slices with a pause after each one (`${b:$i:$slice}` + sleep), which
   * arrives intact, and the whole file is hashed before a single byte reaches
   * disk. A mismatch retries with smaller slices and longer pauses.
   *
   * @param {{remotePath:string, localPath:string, session?:string, maxBytes?:number,
   *   timeoutMs?:number, pieceChars?:number, delayMs?:number, attempts?:number}} opts
   */
  async pull({ remotePath, localPath, session: sessionId, maxBytes = 8 * 1024 * 1024, timeoutMs = 60000, pieceChars = 64, delayMs = 8, attempts = 3 } = {}) {
    if (!remotePath || !localPath) throw new Error('serial_pull needs remotePath and localPath')
    const session = await this.ensureSession({ session: sessionId })
    const piece = Math.max(32, Math.min(1024, Math.floor(Number(pieceChars) || 64)))
    const delay = Math.max(1, Math.min(200, Math.floor(Number(delayMs) || 8)))
    const tries = Math.max(1, Math.min(5, Math.floor(Number(attempts) || 3)))
    const token = randomBytes(4).toString('hex')
    const file = shellQuote(String(remotePath))
    const begin = `__DSH_B_${token}`
    const end = `__DSH_E_${token}`

    // 1. Size and sha256 of the whole file: the reference for everything below.
    const metaRe = `__DSH_SZ_${token}__ (\\d+) ([0-9a-f]{64})`
    const meta = await session.transact({
      data: `__n=$(wc -c < ${file}); printf '\\n__DSH_SZ_${token}__ %s %s\\n' "$__n" "$(sha256sum < ${file} | cut -c1-64)"`,
      patterns: [metaRe],
      timeoutMs: Math.min(30000, timeoutMs),
    })
    const metaHit = new RegExp(metaRe).exec(meta.text)
    if (!metaHit) {
      return {
        ok: false,
        retryable: false,
        bytes: 0,
        error: 'cannot read the remote file (is the console at a Linux shell? does the path exist?)',
      }
    }
    const size = Number(metaHit[1])
    const remoteSha = metaHit[2]
    if (size > maxBytes) {
      return { ok: false, retryable: false, bytes: size, error: `remote file is ${size} bytes, above maxBytes=${maxBytes}` }
    }
    if (size === 0) {
      writeFileSync(localPath, Buffer.alloc(0))
      return { ok: true, bytes: 0, remotePath, localPath, remoteSha, localSha: remoteSha, attempts: 0, pieceChars: 0, delayMs: 0 }
    }

    // 2. Stream the base64 in slices. Markers are assembled at runtime
    //    ("__DSH""_B_x"), so the echoed command line can never contain them.
    let lastError = null
    let lastTry = null
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      const slice = Math.max(32, piece >> (attempt - 1))
      const pauseMs = delay * attempt
      const b64len = Math.ceil(size / 3) * 4
      const budget = Math.ceil((b64len / slice) * pauseMs) + 20000 + Math.ceil(size / 200)
      const cmd = `S="__DSH""_B_${token}"; E="__DSH""_E_${token}"; printf '%s\\n' "$S"; ` +
        `b=$(base64 -w0 < ${file}); n=\${#b}; i=0; ` +
        `while [ $i -lt $n ]; do printf '%s' "\${b:$i:${slice}}"; i=$((i+${slice})); sleep ${(pauseMs / 1000).toFixed(3)}; done; ` +
        'echo; printf \'%s\\n\' "$E"'
      lastTry = { attempt, pieceChars: slice, delayMs: pauseMs }
      const hit = await session.transact({ data: cmd, patterns: [end], timeoutMs: Math.max(timeoutMs, budget) })
      if (!hit.matched) {
        lastError = 'transfer did not finish (end marker not seen)'
        continue
      }
      const startIdx = hit.text.indexOf(begin)
      const endIdx = hit.text.lastIndexOf(end)
      const body = startIdx >= 0 && endIdx > startIdx ? hit.text.slice(startIdx + begin.length, endIdx) : ''
      const b64 = body.replace(/[^A-Za-z0-9+/=]/g, '')
      if (b64.length % 4 !== 0) {
        lastError = `base64 length ${b64.length} is not a multiple of 4 (bytes were lost in transit)`
        this.log(`pull: ${lastError}; retrying slower`)
        continue
      }
      const buf = Buffer.from(b64, 'base64')
      const localSha = createHash('sha256').update(buf).digest('hex')
      if (buf.length !== size || localSha !== remoteSha) {
        lastError = `sha256 mismatch (${buf.length}/${size} bytes)`
        this.log(`pull: ${lastError}; retrying slower`)
        continue
      }
      writeFileSync(localPath, buf)
      return {
        ok: true,
        bytes: buf.length,
        remotePath,
        localPath,
        remoteSha,
        localSha,
        attempts: attempt,
        pieceChars: slice,
        delayMs: pauseMs,
      }
    }
    return { ok: false, retryable: true, bytes: 0, attempts: tries, lastTry, error: lastError }
  }

/** Close every port (plugin unload). */
  async dispose() {
    for (const session of [...this.sessions.values()]) {
      try {
        await session.close()
      } catch { /* ignore */ }
      this.#retire(session, 'plugin shutdown')
    }
    this.sessions.clear()
    this.buffers.clear()
    this.notices = []
    this.defaultId = undefined
  }
}

/** Score a captured window as "readable console output". */
function scoreSample(baud, buf, reused) {
  const text = buf.toString('utf8')
  const clean = stripAnsi(text)
  const printable = clean.replace(/\s/g, '')
  const printableCount = [...printable].filter((ch) => ch >= ' ' && ch <= '~').length
  const ratio = printable.length === 0 ? 0 : printableCount / printable.length
  const hasPrompt = /(?:^|\n)[^\n]{0,40}(?:[$#>]|login:)\s*$|login:|Password:|U-Boot|uboot|console|POST|Booting/i.test(clean)
  const hasLines = clean.includes('\n')
  const score = Math.round(ratio * 100) + (hasPrompt ? 40 : 0) + (hasLines ? 10 : 0)
  return {
    baud,
    ok: clean.length > 0 && ratio > 0.85,
    bytes: buf.length,
    printableRatio: Number(ratio.toFixed(3)),
    hasPrompt,
    reusedSession: reused,
    sample: tail(clean.replace(/\r/g, ''), 240),
  }
}

/** Run a short-lived helper process and collect stdout lines. */
function runOneShot(pythonPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = []
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`helper timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line) lines.push(line)
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, lines, stderr })
    })
  })
}

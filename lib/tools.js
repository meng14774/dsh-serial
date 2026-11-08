/**
 * Agent tools for the serial console.
 *
 * Design notes that matter for embedded work:
 *   - Every tool operates on a long-lived session, so the port stays open and
 *     boot logs / panic messages that arrive while no tool is running are kept
 *     in the in-memory ring. `serial_read` from cursor `start` recovers them.
 *   - Reads are cursor-based (absolute byte offsets), so repeated calls return
 *     only new bytes. No log file is written at any point.
 *   - `serial_transact` is the workhorse: one call sends a line and waits for
 *     a regex, returning clean output with the console echo stripped.
 *   - A marker used in expect() must never appear in the command we send, or
 *     the console echo matches first. Helpers here follow that rule; tools that
 *     take a user pattern only document it.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { stripAnsi, tail, newlineOf, clock } from './engine.js'

/** Host platform, used only for wording (hermetic on Windows, /dev/cu.* on macOS). */
const IS_MAC = process.platform === 'darwin'
const PORT_EXAMPLE = process.platform === 'win32' ? 'COM15' : IS_MAC ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0'

/**
 * Manager whose pending events (a dead reader, a re-attached buffer, an
 * auto-opened port) the next tool result has to surface. One serial manager
 * exists per host and serialTools() is re-run for each mount.
 */
let noticesManager

/** One text content block. */
function text(value) {
  return [{ type: 'text', text: String(value) }]
}

/** Windows comm-error bits -> short names (winerror.h CE_*). */
const LINK_FLAGS = [
  [0x0001, 'RXOVER'],
  [0x0002, 'OVERRUN'],
  [0x0004, 'PARITY'],
  [0x0008, 'FRAME'],
]

/** Render a link-error bitmask, e.g. "OVERRUN,FRAME". */
function describeLinkFlags(bits) {
  if (!bits) return ''
  return LINK_FLAGS.filter(([bit]) => bits & bit).map(([, name]) => name).join(',')
}

/** Uniform tool: `run` returns a string (or {ok, text}). */
function serialTool({ name, description, parameters, run }) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value?.text ?? ''),
    },
    async execute(args) {
      let result
      try {
        const value = await run(args ?? {})
        if (typeof value === 'string') result = { ok: true, text: value }
        else result = { ok: value.ok !== false, text: String(value.text ?? '') }
      } catch (error) {
        result = { ok: false, text: `error: ${error instanceof Error ? error.message : String(error)}` }
      }
      // Events since the last call (a reader that died, a buffer that was
      // re-attached, a port that was auto-opened) belong at the *top* of the
      // next result: a session dying must not be discoverable only by status.
      const notices = noticesManager?.drainNotices?.() ?? []
      if (notices.length > 0) result.text = notices.map((line) => `! ${line}`).join('\n') + '\n\n' + result.text
      return result
    },
  })
}

/** Hex dump: offset, 16 bytes, ASCII. */
function hexDump(buf) {
  const lines = []
  for (let offset = 0; offset < buf.length; offset += 16) {
    const slice = buf.subarray(offset, offset + 16)
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...slice].map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`${offset.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return lines.join('\n')
}

/** Keep the last N lines of a text block. */
function lastLines(value, count) {
  const lines = value.split('\n')
  if (lines.length <= count) return value
  return `…[${lines.length - count} lines trimmed]…\n` + lines.slice(lines.length - count).join('\n')
}

/** Render session status compactly. */
function renderSession(status) {
  const age = status.lastByteAgeMs === null ? 'n/a' : `${status.lastByteAgeMs} ms ago`
  const link = status.linkErrors > 0
    ? `${status.linkErrors} loss event(s)${describeLinkFlags(status.linkFlags) ? ` (${describeLinkFlags(status.linkFlags)})` : ''} — the driver dropped bytes in transit; text may be short`
    : status.linkWatch === false
      ? 'NOT OBSERVABLE on this OS (driver loss counters are Win32-only) — "0" is not proof of a clean link; trust serial_transact { verify: true } or a paced serial_pull'
      : 'no driver-reported loss'
  const ended = status.closedAt ? `, ended ${clock(status.closedAt)}` : ''
  const stateNote = status.state === 'closed' ? ' (session gone, buffer retained)' : ''
  return [
    `session ${status.id}: ${status.state}${stateNote} ${status.port} @ ${status.baud ?? '?'} ${status.dataBits}${status.parity[0].toUpperCase()}${status.stopBits}${ended}`,
    `  buffered ${status.bufferedBytes}/${status.bufferCapacity} bytes, rx ${status.receivedBytes}, ring-overflow ${status.droppedBytes}${status.txBytes === undefined ? '' : `, tx ${status.txBytes}`}`,
    `  link: ${link}`,
    `  cursor start=${status.cursorStart} end=${status.cursorEnd} tail=${status.tailCursor} unread=${status.unreadBytes}`,
    `  last byte ${age}, rules ${status.rules}, pid ${status.pid ?? '?'}${status.lastError ? `, lastError: ${status.lastError}` : ''}`,
  ].join('\n')
}

/** The tool list. */
export function serialTools(manager) {
  noticesManager = manager
  return [
    serialTool({
      name: 'serial_list',
      description: "List serial ports on this machine (COM/USB adapters with VID:PID), the plugin's open serial sessions, buffers retained for closed ports, and the ports a tool call would auto-open. Use this before serial_open. Triggers: serial port, COM port, USB-TTL, which port, 串口.",
      parameters: {
        force: { type: 'boolean', description: 'Bypass the 5 s port-list cache.' },
      },
      async run(args) {
        const ports = await manager.ports(Boolean(args.force))
        const sessions = manager.status()
        const retained = manager.retainedBuffers()
        const cfg = manager.cfg()
        const lines = []
        lines.push(`ports (${ports.length}):`)
        if (ports.length === 0) {
          lines.push(IS_MAC
            ? '  (none) — on macOS check that the adapter driver is loaded/approved (CH34x or FTDI), then: ls /dev/cu.* ; systemextensionsctl list'
            : '  (none)')
        }
        for (const port of ports) {
          const ids = [
            port.vid !== null && port.vid !== undefined ? `VID:PID=${port.vid.toString(16).padStart(4, '0')}:${port.pid?.toString(16).padStart(4, '0')}` : '',
            port.session ? `session=${port.session}` : '',
            port.retainedBytes ? `retained=${port.retainedBytes}B` : '',
          ].filter(Boolean).join(' ')
          lines.push(`  ${port.device}  ${port.description ?? ''}  ${ids}`)
        }
        lines.push('')
        lines.push(`sessions (${sessions.length}):`)
        if (sessions.length === 0) lines.push('  (none open)')
        for (const status of sessions) lines.push('  ' + renderSession(status).replace(/\n/g, '\n  '))
        if (retained.length > 0) {
          lines.push('')
          lines.push(`retained buffers (${retained.length}) — a session ended, its bytes are still readable:`)
          for (const entry of retained) {
            lines.push(`  ${entry.port}  ${entry.bytes} B (${entry.unread} unread, tail ${entry.tailCursor})` +
              `${entry.closedAt ? ` ended ${clock(entry.closedAt)}` : ''}${entry.reason ? ` — ${entry.reason}` : ''}`)
          }
        }
        lines.push('')
        lines.push(`defaults: port=${cfg.defaultPort || '(unset)'} baud=${cfg.defaultBaud} ${cfg.dataBits}${cfg.parity[0].toUpperCase()}${cfg.stopBits} flow=${cfg.flowControl}`)
        lines.push(`last used: ${manager.state.lastPort ?? '(none yet)'}${manager.state.lastBaud ? ` @ ${manager.state.lastBaud}` : ''}` +
          (manager.state.lastPort && cfg.defaultPort && manager.state.lastPort.toLowerCase() !== cfg.defaultPort.toLowerCase()
            ? ' — tool calls without a session reopen this port, NOT config.defaultPort'
            : ''))
        return lines.join('\n')
      },
    }),

    serialTool({
      name: 'serial_open',
      description: 'Open a serial port and keep it open (one long-lived session per port). While open, every received byte is buffered in memory so later reads can recover history — no log file involved. Never toggles DTR/RTS unless asked (opening does not reset the board). Reopening a port whose session ended re-attaches its retained buffer, so nothing that was received is lost. Triggers: open serial, connect UART, 打开串口.',
      parameters: {
        port: { type: 'string', description: `Port name like ${PORT_EXAMPLE} (macOS: /dev/cu.* is the callout device; avoid /dev/tty.*). Defaults to the last successfully used port, else the configured defaultPort.` },
        baud: { type: 'integer', description: 'Baud rate. Defaults to the configured/last-used rate (1500000 on this machine).' },
        dataBits: { type: 'integer', description: 'Data bits, default 8.' },
        parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'], description: 'Parity, default none.' },
        stopBits: { type: 'integer', enum: [1, 2], description: 'Stop bits, default 1.' },
        flowControl: { type: 'string', enum: ['none', 'xonxoff', 'rtscts', 'dsrdtr'], description: 'Flow control, default none.' },
        dtr: { type: 'boolean', description: 'Set DTR level on open (omit = leave untouched).' },
        rts: { type: 'boolean', description: 'Set RTS level on open (omit = leave untouched).' },
        bufferBytes: { type: 'integer', description: 'Ring buffer capacity in bytes (default 4 MiB).' },
      },
      async run(args) {
        const cfg = manager.cfg()
        const port = args.port || manager.state.lastPort || cfg.defaultPort
        if (!port) throw new Error(`no port given, none used before and config.defaultPort is empty; run serial_list first, then serial_open port=${PORT_EXAMPLE}`)
        const session = await manager.open({
          port,
          baud: args.baud,
          dataBits: args.dataBits,
          parity: args.parity,
          stopBits: args.stopBits,
          flowControl: args.flowControl,
          dtr: args.dtr,
          rts: args.rts,
          bufferBytes: args.bufferBytes,
        })
        const lines = ['opened.', renderSession(session.status())]
        if (session.carry && session.carry.retained > 0) {
          lines.push('')
          lines.push(`re-attached ${session.carry.retained} B retained from the previous ${session.port} session` +
            `${session.carry.unread > 0 ? ` (${session.carry.unread} B unread; serial_read with no cursor returns them first)` : ''}` +
            `${session.carry.reason ? `\nprevious session ended ${clock(session.carry.closedAt)}: ${session.carry.reason}` : ''}`)
        } else {
          lines.push('')
          lines.push('fresh buffer (this port had no retained history).')
        }
        lines.push('')
        lines.push('Next: serial_read (cursor "start" for history), serial_ping (is anything alive), or serial_transact to run a command.')
        return lines.join('\n')
      },
    }),

    serialTool({
      name: 'serial_close',
      description: 'Close one serial session, or all of them. The in-memory buffer is KEPT by default so the last output before closing stays readable (serial_open on the same port re-attaches it); pass dropBuffer=true to discard it. Triggers: close serial, release port, 关闭串口.',
      parameters: {
        session: { type: 'string', description: 'Session id / port name. Omit to close the default session.' },
        all: { type: 'boolean', description: 'Close every open session.' },
        dropBuffer: { type: 'boolean', description: 'Also discard the retained history for those ports (default false: keep it).' },
      },
      async run(args) {
        const result = await manager.close({ session: args.session, all: args.all === true, dropBuffer: args.dropBuffer === true })
        const lines = [`closed: ${result.closed.join(', ') || '(none)'}`]
        for (const entry of result.retained) {
          lines.push(`retained ${entry.bytes} B for ${entry.port} (${entry.unread} B unread) — serial_open port=${entry.port} re-attaches it, serial_close session=${entry.port} dropBuffer=true discards it`)
        }
        for (const entry of result.dropped) lines.push(`dropped the retained buffer of ${entry.port} (${entry.bytes} B)`)
        return lines.join('\n')
      },
    }),

    serialTool({
      name: 'serial_status',
      description: 'Show serial sessions: state, line settings, buffered/unread byte counts, cursors, last-byte age, auto-responder rules and recent in-memory operations — plus buffers retained for ports whose session ended. Use it to decide where to read from. Triggers: serial status, 串口状态.',
      parameters: {
        session: { type: 'string', description: 'Limit output to one session or port (works for a closed port with a retained buffer).' },
      },
      async run(args) {
        const statuses = manager.status(args)
        const retained = args.session ? [] : manager.retainedBuffers()
        if (statuses.length === 0 && retained.length === 0) return 'no serial sessions and no retained buffers. Use serial_list / serial_open.'
        const blocks = []
        for (const status of statuses) {
          const session = manager.sessions.get(status.id)
          const rules = session?.listRules() ?? []
          const ops = session?.recentOps(6) ?? []
          blocks.push(renderSession(status))
          if (rules.length > 0) {
            blocks.push('  rules:')
            for (const rule of rules) blocks.push(`    ${rule.name}: /${rule.pattern}/ -> ${JSON.stringify(rule.send)} fired=${rule.fireCount}`)
          }
          if (ops.length > 0) {
            blocks.push('  recent ops (in memory):')
            for (const op of ops) blocks.push(`    ${new Date(op.ts).toISOString().slice(11, 23)} ${op.op} ${op.detail}`)
          }
        }
        for (const entry of retained) {
          blocks.push(renderSession(manager.retiredStatus(manager.buffers.get(entry.port.toLowerCase()))))
          blocks.push(`  serial_open port=${entry.port} resumes on the same port; serial_close session=${entry.port} dropBuffer=true discards the ${entry.bytes} B`)
        }
        return blocks.join('\n')
      },
    }),

    serialTool({
      name: 'serial_write',
      description: 'Send raw bytes or a line to the open serial session. Text is UTF-8; set newline to control the terminator (default CR, which is what Linux/U-Boot consoles expect). Use hex for binary protocols. Triggers: send serial, write UART, type command, 发送串口数据.',
      parameters: {
        data: { type: 'string', description: 'Text to send. A trailing CR/LF in the string is respected (no extra newline added).' },
        hex: { type: 'string', description: 'Hex bytes to send instead of text, e.g. "1b 5b 41" or "0358".' },
        newline: { type: 'string', enum: ['none', 'cr', 'lf', 'crlf'], description: 'Terminator appended to text (default cr). Ignored when the text already ends with CR/LF.' },
        repeat: { type: 'integer', description: 'Send the payload N times (useful to spam a key during autoboot).' },
        intervalMs: { type: 'integer', description: 'Delay between repeats, default 50 ms.' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        let payload
        if (args.hex) {
          const clean = String(args.hex).replace(/[^0-9a-fA-F]/g, '')
          if (clean.length % 2 !== 0) throw new Error('hex payload needs an even number of hex digits')
          payload = Buffer.from(clean, 'hex')
        } else {
          const value = String(args.data ?? '')
          payload = Buffer.from(/\r|\n$/.test(value) ? value : value + newlineOf(args.newline), 'utf8')
        }
        const times = Math.max(1, Math.min(1000, Number(args.repeat) || 1))
        const interval = args.intervalMs === undefined ? 50 : Math.max(0, Number(args.intervalMs) || 0)
        let bytes = 0
        for (let i = 0; i < times; i += 1) {
          const result = await session.write(payload)
          bytes += result.bytes
          if (i < times - 1 && interval > 0) await new Promise((resolve) => setTimeout(resolve, interval))
        }
        await new Promise((resolve) => setTimeout(resolve, 60))
        const recent = await session.read({ from: 'tail', maxBytes: 512, waitMs: 0 })
        const snippet = stripAnsi(recent.text)
        return `sent ${bytes} byte${bytes === 1 ? '' : 's'}${times > 1 ? ` (${times}x)` : ''}, cursor -> ${session.ring.end}` +
          (snippet ? `\nrx right after:\n${tail(snippet, 600)}` : '\n(no immediate reply; use serial_read with waitMs or serial_expect)')
      },
    }),

    serialTool({
      name: 'serial_read',
      description: 'Read device output from the in-memory ring buffer. Default returns only bytes after the last read (cursor "tail"); pass cursor "start" for all retained history, or a numeric cursor returned by a previous call. waitMs blocks until new data arrives, so polling is cheap. No log file is written. Triggers: read serial, serial log, 串口输出, 串口日志.',
      parameters: {
        cursor: { type: 'string', description: 'Start position: "tail" (default, new data only), "start" (full retained history), "end" (skip everything), or a numeric cursor from a previous result.' },
        maxBytes: { type: 'integer', description: 'Max bytes to return, default 65536 (cap 1048576).' },
        waitMs: { type: 'integer', description: 'Wait up to N ms for new bytes before returning (default 0, cap 60000).' },
        tailLines: { type: 'integer', description: 'Return only the last N lines of the chunk.' },
        hex: { type: 'boolean', description: 'Render as a hex dump instead of text (binary protocols).' },
        stripAnsi: { type: 'boolean', description: 'Strip ANSI escape sequences (default true).' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        const maxBytes = Math.min(1024 * 1024, Math.max(1, Number(args.maxBytes) || 65536))
        const waitMs = Math.min(60000, Math.max(0, Number(args.waitMs) || 0))
        const result = await session.read({ from: args.cursor, maxBytes, waitMs })
        let body = args.hex ? hexDump(result.data) : result.text
        if (!args.hex && args.stripAnsi !== false) body = stripAnsi(body)
        if (args.tailLines) body = lastLines(body, Math.max(1, Number(args.tailLines)))
        const header = [
          `cursor ${result.from} -> ${result.cursor} (${result.data.length} bytes; ${result.available} buffered at read time)`,
          result.gap > 0 ? `WARNING: ${result.gap} bytes were dropped before this cursor (ring overflow)` : '',
          result.linkWarnings > 0
            ? `WARNING: the serial driver reported lost bytes ${result.linkWarnings}x while receiving this range${describeLinkFlags(result.linkFlags) ? ` (${describeLinkFlags(result.linkFlags)})` : ''} — the text may be missing characters; re-run the command with serial_transact { verify: true } if it matters`
            : '',
          result.timedOut ? 'no new data within waitMs' : '',
        ].filter(Boolean).join('\n')
        if (!body) {
          return `${header}\n(no bytes)` +
            (result.available === 0
              ? '\nNothing has arrived since this cursor. If the board should be printing, the silence itself is the clue: check the port, the baud rate and the board power (serial_ping).'
              : '')
        }
        return `${header}\n---\n${body}`
      },
    }),

    serialTool({
      name: 'serial_expect',
      description: 'Wait until received data matches a JavaScript regex (or one of several), without sending anything. Returns the matched text plus a small context window and the cursor just after the match. idleMs turns silence into a frame boundary: use it for output that may not end with a newline. Triggers: wait for serial output, wait for prompt, 等待串口输出, 期望匹配.',
      parameters: {
        pattern: { type: 'string', description: 'JavaScript regex, e.g. "login:" or "[$#] $" (a shell prompt).' },
        patterns: { type: 'array', items: { type: 'string' }, description: 'Any-of regexes; the first one that matches wins (the result reports which).' },
        cursor: { type: 'string', description: 'Search start: "tail" (default), "start", or a numeric cursor.' },
        idleMs: { type: 'integer', description: 'Return partial output after this much silence instead of waiting out the timeout (0 = off).' },
        timeoutMs: { type: 'integer', description: 'How long to wait, default 5000 (cap 120000).' },
        maxBytes: { type: 'integer', description: 'Max window to scan, default 1048576.' },
        contextBytes: { type: 'integer', description: 'How much text before the match to include, default 400.' },
        stripAnsi: { type: 'boolean', description: 'Strip ANSI escapes in the rendered output (default true).' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        const patterns = args.patterns?.length ? args.patterns : [args.pattern]
        if (!patterns[0]) throw new Error('pass pattern or patterns')
        const timeoutMs = Math.min(120000, Math.max(0, Number(args.timeoutMs) || 5000))
        const maxBytes = Math.min(4 * 1024 * 1024, Math.max(1, Number(args.maxBytes) || 1024 * 1024))
        const idleMs = Math.min(60000, Math.max(0, Number(args.idleMs) || 0))
        const result = await session.expect({ from: args.cursor, patterns, timeoutMs, maxBytes, idleMs })
        const contextBytes = Math.max(0, Number(args.contextBytes) ?? 400)
        let context = result.matched
          ? result.text.slice(Math.max(0, result.text.length - contextBytes - (result.match?.length ?? 0)))
          : result.text
        if (args.stripAnsi !== false) context = stripAnsi(context)
        if (!result.matched) {
          const scanned = Math.max(0, result.scannedTo - result.from)
          const hint = scanned === 0
            ? '\nNo bytes arrived during the wait. That is not a pattern problem: check port/baud/power with serial_ping.'
            : ''
          return `${result.idle ? `idle for ${idleMs} ms` : `no match in ${result.elapsedMs} ms`} (scanned ${scanned} bytes, cursor ${result.from} -> ${result.scannedTo})${hint}\n--- tail of scanned window ---\n${tail(context, 2000)}`
        }
        return `matched pattern #${result.index} ${JSON.stringify(result.pattern)} in ${result.elapsedMs} ms\nmatch: ${JSON.stringify(result.match)}${result.groups.length ? `\ngroups: ${JSON.stringify(result.groups)}` : ''}\ncursor -> ${result.cursor} (pass it to the next call to continue after the match)\n--- context ---\n${tail(context, 2000)}`
      },
    }),

    serialTool({
      name: 'serial_transact',
      description: 'Send one line and wait for a regex in the reply, returning clean output. The search window starts AFTER the echoed command line, so the pattern may contain words from the command (login:, php, grep, ...) without matching its own echo. captureExitCode adds a runtime-built shell exit-code probe and returns exitCode. idleMs returns early with partial output when the output goes quiet (no trailing newline). verify=true tees the output and compares sha256 with the board, so corrupted captures are detected instead of silently shortened (re-runs the command on mismatch). Triggers: run command over serial, serial exec, 串口执行命令.',
      parameters: {
        data: { type: 'string', required: true, description: 'Line to send (a terminator is added unless it already ends with CR/LF).' },
        expect: { type: 'string', description: 'Regex to wait for, e.g. "[$#] $" (a prompt). With captureExitCode this is ignored: the exit marker is the terminator.' },
        patterns: { type: 'array', items: { type: 'string' }, description: 'Any-of regexes instead of a single expect.' },
        captureExitCode: { type: 'boolean', description: 'Append a shell exit-code probe and return exitCode (POSIX shell only; not for U-Boot/AT consoles). Default false.' },
        verify: { type: 'boolean', description: 'Prove the output is intact: tee it on the board, compare sha256 with the live capture, and if the capture lost bytes re-fetch the tee\'d file over the verified chunked path. The command itself runs once, so it is safe for read-only and for commands you do not want repeated.' },
        verifyAttempts: { type: 'integer', description: 'How many times a verify=true command may run before giving up, default 2 (cap 5).' },
        idleMs: { type: 'integer', description: 'Return with partial output after this much silence (0 = wait for the pattern/timeout).' },
        timeoutMs: { type: 'integer', description: 'Default 8000 (cap 120000).' },
        newline: { type: 'string', enum: ['none', 'cr', 'lf', 'crlf'], description: 'Terminator, default cr.' },
        stripEcho: { type: 'boolean', description: 'Search only after the echoed command line (default true).' },
        stripAnsi: { type: 'boolean', description: 'Strip ANSI escapes in the rendered output (default true).' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        const patterns = args.patterns?.length ? args.patterns : args.expect ? [args.expect] : undefined
        const timeoutMs = Math.min(120000, Math.max(0, Number(args.timeoutMs) || 8000))
        const idleMs = Math.min(60000, Math.max(0, Number(args.idleMs) || 0))
        const result = await session.transact({
          data: String(args.data ?? ''),
          patterns,
          timeoutMs,
          newline: args.newline,
          stripEcho: args.stripEcho !== false,
          captureExitCode: args.captureExitCode === true,
          idleMs,
          verify: args.verify === true,
          verifyAttempts: Math.min(5, Math.max(1, Number(args.verifyAttempts) || 2)),
        })
        let body = result.text
        if (args.stripAnsi !== false) body = stripAnsi(body)
        const lines = []
        if (result.exitCode !== null && result.exitCode !== undefined) {
          lines.push(`command finished in ${result.elapsedMs} ms, exit code ${result.exitCode}`)
        } else if (result.matched) {
          lines.push(`matched ${JSON.stringify(result.match)} in ${result.elapsedMs} ms`)
        } else if (result.promptSeen) {
          lines.push(`pattern did not match, but the console is back at a prompt after ${result.elapsedMs} ms (output below is complete)`)
        } else if (result.idle) {
          lines.push(`idle for ${idleMs} ms, partial output`)
        } else if (result.bytesReceived === 0) {
          // The decisive signal: not one byte came back, not even the echo.
          lines.push(`NO MATCH after ${result.elapsedMs} ms and 0 bytes came back — not even the echo of the command.`)
          lines.push('This is not a pattern problem. Suspect, in order: wrong port, wrong baud rate, board not powered / not at a console, or another program holding the port. Next: serial_ping (sends one CR and reports whether anything answers), serial_list, serial_probe.')
        } else if (result.echoSeen && stripAnsi(String(result.text ?? '')).replace(/[\s\r]/g, '') === '') {
          // Only readline control residue came back: the command was accepted,
          // then the console went silent (long command, hung boot, quiet kernel).
          lines.push(`NO MATCH after ${result.elapsedMs} ms: the command was echoed, then the console went quiet (no output and no prompt).`)
          lines.push('The board accepted the line but printed nothing — it may be running a long command, hung mid-boot/mid-panic, or this console has no shell prompt. Next: wait with serial_read waitMs, or serial_ping to see whether anything else is coming.')
        } else {
          lines.push(`NO MATCH after ${result.elapsedMs} ms, but ${result.bytesReceived} bytes arrived — including no prompt at the end (output below is everything received).`)
          lines.push('The console is talking, so the port and baud are probably right; the board may be hung mid-output or the prompt pattern is different. Re-read the same bytes with serial_read or adjust expect.')
        }
        if (result.verify && result.verify.ok) {
          lines.push(`integrity: verified (sha256 ${result.verify.remoteSha.slice(0, 12)}…, attempt ${result.verify.attempts}/${args.verifyAttempts ?? 2})`)
        } else if (result.integrity === 'mismatch') {
          lines.push(`integrity: MISMATCH after ${result.verify.attempts} attempt(s) — local ${result.verify.localSha.slice(0, 12)}… (${result.verify.localSize} B) vs remote ${result.verify.remoteSha.slice(0, 12)}… (${result.verify.remoteSize} B). DO NOT TRUST THIS OUTPUT.`)
        } else if (result.integrity === 'unknown') {
          lines.push('integrity: could not verify (no marker — does the board have tee/sha256sum/wc?)')
        }
        if (result.linkWarnings > 0) {
          const bits = describeLinkFlags(result.linkFlags)
          lines.push(`WARNING: the serial driver reported lost bytes ${result.linkWarnings}x in this window${bits ? ` (${bits})` : ''} — characters may be missing from the text below`)
        }
        lines.push(`cursor ${result.from} -> ${result.to}`)
        return `${lines.join('\n')}\n---\n${tail(body, 8000) || '(no output)'}`
      },
    }),

    serialTool({
      name: 'serial_ping',
      description: 'Check whether anything is alive on the serial port: send one CR (or listen only with poke=false) and report whether any byte comes back within the timeout, with first-byte latency and a prompt guess. This separates "my command did not match" from "wrong port / wrong baud / board off" — zero bytes is a wiring answer, not a regex answer. DTR/RTS are untouched, but the CR can interrupt U-Boot autoboot (pass poke=false for a passive check). Triggers: is the board alive, ping serial, serial alive, 板子是不是挂了, 串口有没有反应.',
      parameters: {
        timeoutMs: { type: 'integer', description: 'How long to wait for any byte, default 2000 (cap 60000).' },
        data: { type: 'string', description: 'Bytes to send, default a single CR (\\r, \\n, \\t and \\xNN are interpreted).' },
        poke: { type: 'boolean', description: 'Send the CR first (default true). false = passive listen, safe during autoboot.' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        const poke = args.poke !== false
        const data = typeof args.data === 'string' && args.data !== '' ? decodeEscapes(args.data) : '\r'
        const timeoutMs = Math.min(60000, Math.max(50, Number(args.timeoutMs) || 2000))
        const result = await session.ping({ data, poke, timeoutMs })
        const head = result.alive
          ? `ping ${result.port} @ ${result.baud}: ALIVE — ${result.bytes} B in ${result.firstByteMs} ms${result.promptSeen ? ', ending looks like a prompt' : ''}${result.echoSeen ? ', echo seen' : ''}`
          : `ping ${result.port} @ ${result.baud}: SILENT — 0 bytes within ${timeoutMs} ms${poke ? ' after sending CR' : ' while only listening'}`
        const lines = [head]
        if (!result.alive) {
          lines.push('Nothing answered; that is a link/port/power answer, not a pattern answer. Next:')
          lines.push('  serial_list   — is the port still present (unplugged adapter / COM number changed)?')
          lines.push('  serial_probe  — scan baud rates (the current rate may be wrong)')
          lines.push('  board power and UART wiring (TX/RX/GND); confirm this UART actually has a console')
          lines.push('  a booting board can also be legitimately silent (quiet kernel, no shell yet)')
        } else if (!result.promptSeen) {
          lines.push('Bytes arrived but no prompt-like line: the console is alive but may be mid-boot, mid-panic, or not a shell.')
        }
        lines.push(`cursor ${result.from} -> ${result.to}`)
        return `${lines.join('\n')}\n---\n${tail(stripAnsi(result.text), 1200) || '(no bytes)'}`
      },
    }),

    serialTool({
      name: 'serial_set_default',
      description: 'Remember which port (and baud) tool calls should use when no session is open, instead of relying on the configured defaultPort. Persisted next to the DSH profile, so it survives a restart and a USB adapter moving to another COM number. Triggers: set default serial port, remember serial port, 默认串口.',
      parameters: {
        port: { type: 'string', description: `Port to prefer, e.g. ${PORT_EXAMPLE}.` },
        baud: { type: 'integer', description: 'Preferred baud rate.' },
      },
      async run(args) {
        if (!args.port && !args.baud) throw new Error('serial_set_default needs port and/or baud')
        const state = manager.setDefault({ port: args.port, baud: args.baud })
        const live = manager.get()
        return [
          `default port -> ${state.port ?? '(unset)'}${state.baud ? ` @ ${state.baud}` : ''}`,
          `persisted: ${state.stateFile ?? 'disabled (DSH_SERIAL_STATE=off)'}`,
          `currently open: ${live ? live.id : '(none)'}`,
          'Tool calls without an explicit session/port use this. A session that dies is always reopened on its own port — this setting never overrides that.',
        ].join('\n')
      },
    }),

    serialTool({
      name: 'serial_script',
      description: 'Run a whole script on the board instead of a single command line: the text is base64-encoded, written to a temp file and executed by the interpreter, so pipes, quotes, $, heredocs and multi-line constructs never go through argv. Returns output and exitCode. Requires a Linux shell prompt. Triggers: run script over serial, multi-line command, 串口跑脚本, 复杂命令.',
      parameters: {
        script: { type: 'string', required: true, description: 'Script text (multi-line allowed). Executed as a file on the board.' },
        interpreter: { type: 'string', description: 'Interpreter to run the file with: bash (default), sh, python3, node ...' },
        sudo: { type: 'boolean', description: 'Run the interpreter through sudo (board must allow passwordless sudo).' },
        timeoutMs: { type: 'integer', description: 'Execution timeout, default 120000 (cap 600000).' },
        stripAnsi: { type: 'boolean', description: 'Strip ANSI escapes in the rendered output (default true).' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const result = await manager.script({
          script: String(args.script ?? ''),
          interpreter: args.interpreter || 'bash',
          sudo: args.sudo === true,
          timeoutMs: Math.min(600000, Math.max(1000, Number(args.timeoutMs) || 120000)),
          session: args.session,
        })
        const code = result.exitCode === null ? 'null' : String(result.exitCode)
        const body = args.stripAnsi === false ? result.output : stripAnsi(result.output)
        const head = result.ok
          ? `script finished: exit ${code} (${result.scriptBytes} bytes)`
          : result.exitCode === null
            ? `script did NOT finish: ${result.error}`
            : `script finished with exit ${code}${result.error ? ` (${result.error})` : ''}`
        return `${head}\n---\n${tail(body, 12000) || '(no output)'}`
      },
    }),

    serialTool({
      name: 'serial_configure',
      description: 'Change line settings on the open port: baud rate, DTR/RTS levels, a DTR/RTS pulse (reset/bootloader entry), a BREAK, or flush the input buffer. Triggers: change baud, toggle DTR, reset board via serial, send break, 改波特率, 复位.',
      parameters: {
        baud: { type: 'integer', description: 'New baud rate.' },
        dtr: { type: 'boolean', description: 'Set DTR level.' },
        rts: { type: 'boolean', description: 'Set RTS level.' },
        pulse: { type: 'string', enum: ['dtr', 'rts'], description: 'Pulse this line instead of setting levels.' },
        pulseMs: { type: 'integer', description: 'Pulse width, default 150 ms.' },
        pulseActive: { type: 'boolean', description: 'Pulse to active level (default true); false emits a low pulse.' },
        breakMs: { type: 'integer', description: 'Send a BREAK of this duration.' },
        flush: { type: 'boolean', description: 'Drop buffered input collected so far.' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        const done = []
        if (args.pulse) {
          await session.pulse(args.pulse, Number(args.pulseMs) || 150, args.pulseActive !== false)
          done.push(`pulsed ${args.pulse} ${Number(args.pulseMs) || 150} ms (active=${args.pulseActive !== false})`)
        }
        if (args.baud) {
          const baud = await session.setBaud(Number(args.baud))
          done.push(`baud -> ${baud}`)
        }
        if (typeof args.dtr === 'boolean') {
          done.push(`dtr -> ${await session.setLine('dtr', args.dtr)}`)
        }
        if (typeof args.rts === 'boolean') {
          done.push(`rts -> ${await session.setLine('rts', args.rts)}`)
        }
        if (args.breakMs) {
          await session.sendBreak(Number(args.breakMs))
          done.push(`break ${args.breakMs} ms`)
        }
        if (args.flush) {
          await session.flushInput()
          done.push('input buffer flushed')
        }
        if (done.length === 0) return `nothing to change.\n${renderSession(session.status())}`
        return `${done.join('\n')}\n\n${renderSession(session.status())}`
      },
    }),

    serialTool({
      name: 'serial_rule',
      description: 'Manage in-memory auto-responder rules: when newly received bytes complete a regex, the plugin immediately sends a reply. Perfect for login prompts, "Press any key to stop autoboot", or a board that asks for confirmation. Rules live in memory only. Triggers: auto login, auto respond serial, 自动登录, 自动应答.',
      parameters: {
        action: { type: 'string', required: true, enum: ['add', 'list', 'remove', 'clear'], description: 'What to do.' },
        name: { type: 'string', description: 'Rule name (for add/remove).' },
        pattern: { type: 'string', description: 'Regex that triggers the rule (for add).' },
        send: { type: 'string', description: 'Bytes to send when it fires (\\r, \\n, \\t and \\xNN escapes are interpreted), e.g. "orangepi\\r".' },
        once: { type: 'boolean', description: 'Fire at most once (default false).' },
        cooldownMs: { type: 'integer', description: 'Minimum gap between firings, default 1200 ms.' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const session = await manager.ensureSession({ session: args.session })
        if (args.action === 'list') {
          const rules = session.listRules()
          if (rules.length === 0) return 'no rules'
          return rules.map((rule) => `${rule.name}: /${rule.pattern}/ -> ${JSON.stringify(rule.send)} once=${rule.once} cooldown=${rule.cooldownMs} fired=${rule.fireCount}`).join('\n')
        }
        if (args.action === 'clear') {
          const removed = session.removeRule()
          return `cleared ${removed} rule(s)`
        }
        if (args.action === 'remove') {
          if (!args.name) throw new Error('remove needs name')
          const removed = session.removeRule(args.name)
          return removed ? `removed ${args.name}` : `no rule named ${args.name}`
        }
        const send = decodeEscapes(String(args.send ?? ''))
        const rule = session.addRule({
          name: args.name,
          pattern: args.pattern,
          send,
          once: args.once === true,
          cooldownMs: Number(args.cooldownMs) ?? 1200,
        })
        return `added rule ${rule.name}: /${rule.pattern}/ -> ${JSON.stringify(rule.send)}`
      },
    }),

    serialTool({
      name: 'serial_probe',
      description: 'Scan baud rates on a port and report which one yields readable console text (sends a single CR per baud to elicit a prompt — this can interrupt U-Boot autoboot, so pass poke=false for read-only probing). Use it when the baud rate is unknown. Triggers: find baud, baud scan, 波特率探测.',
      parameters: {
        port: { type: 'string', description: 'Port to scan; defaults to the active/default port.' },
        bauds: { type: 'array', items: { type: 'integer' }, description: 'Candidate rates. Default: configured rate plus common ones.' },
        perBaudMs: { type: 'integer', description: 'Listen time per rate, default 1200 ms.' },
        poke: { type: 'boolean', description: 'Send CR at each rate (default true).' },
      },
      async run(args) {
        const result = await manager.probe({
          port: args.port,
          bauds: args.bauds,
          perBaudMs: Math.min(5000, Math.max(200, Number(args.perBaudMs) || 1200)),
          poke: args.poke !== false,
        })
        const sorted = [...result.results].sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || b.printableRatio - a.printableRatio)
        const lines = [`probe of ${result.port}:`]
        for (const entry of sorted) {
          lines.push(`  ${String(entry.baud).padEnd(8)} ok=${entry.ok ? 'YES' : 'no '} bytes=${String(entry.bytes).padEnd(6)} printable=${entry.printableRatio}${entry.hasPrompt ? ' prompt-like' : ''}`)
          if (entry.sample) lines.push(`           sample: ${JSON.stringify(entry.sample.slice(-160))}`)
          if (entry.error) lines.push(`           error: ${entry.error}`)
        }
        const best = sorted.find((entry) => entry.ok)
        lines.push(best ? `\nbest guess: ${best.baud}` : '\nnothing readable — check wiring/power, or probe with poke=true')
        return lines.join('\n')
      },
    }),

    serialTool({
      name: 'serial_push',
      description: 'Copy a local file to the board through the serial console (base64 + shell heredoc, verified by byte count AND sha256, with automatic retries). Aborts early if the console stops echoing payload lines. This is the way to transfer files when there is no network and SSH is unavailable. Requires a working Linux shell prompt. Triggers: send file over serial, deploy to board via serial, 串口传文件, 无网络传文件.',
      parameters: {
        localPath: { type: 'string', required: true, description: 'Local file path on this machine (the dsh host).' },
        remotePath: { type: 'string', required: true, description: 'Destination path on the board.' },
        chmod: { type: 'string', description: 'Optional chmod mode, e.g. "755".' },
        sudo: { type: 'boolean', description: 'Prefix the decode step with sudo (board must allow passwordless sudo).' },
        attempts: { type: 'integer', description: 'How many times a failed transfer is retried, default 3 (cap 5).' },
        timeoutMs: { type: 'integer', description: 'Transfer timeout, default 60000 (cap 600000).' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const result = await manager.push({
          localPath: args.localPath,
          remotePath: args.remotePath,
          chmod: args.chmod,
          sudo: args.sudo === true,
          attempts: Math.min(5, Math.max(1, Number(args.attempts) || 3)),
          timeoutMs: Math.min(600000, Math.max(5000, Number(args.timeoutMs) || 60000)),
          session: args.session,
        })
        const transfer = result.transfer ?? {}
        const verify = `size ${result.remoteSize ?? 'n/a'}/${result.bytes}, sha256 ${result.remoteSha ? result.remoteSha.slice(0, 12) : 'n/a'}${result.remoteSha && result.localSha ? (result.remoteSha === result.localSha ? ' (match)' : ' (MISMATCH)') : ''}`
        if (!result.ok) return { ok: false, text: `push FAILED (attempt ${result.attempt}): ${result.error}\n${verify}\nechoConfirmed=${transfer.echoConfirmed}/${transfer.lines} paced=${transfer.paced}` }
        return `pushed ${result.bytes} bytes -> ${result.remotePath} on attempt ${result.attempt}\n${verify}\nlines=${transfer.lines} echoConfirmed=${transfer.echoConfirmed}/${transfer.lines} paced=${transfer.paced}`
      },
    }),

    serialTool({
      name: 'serial_pull',
      description: 'Copy a file from the board to this machine through the serial console (base64, no network needed). The payload is streamed in paced slices so a high-baud UART cannot drop runs of bytes, and the whole file is checked against the remote sha256 before it is written. Requires a working Linux shell prompt. Triggers: fetch file over serial, download from board via serial, 串口取文件, 无网络取文件.',
      parameters: {
        remotePath: { type: 'string', required: true, description: 'File path on the board.' },
        localPath: { type: 'string', required: true, description: 'Destination path on this machine.' },
        maxBytes: { type: 'integer', description: 'Max accepted size, default 8 MiB.' },
        pieceChars: { type: 'integer', description: 'Base64 characters printed per slice, default 64 (32..1024). Smaller is safer on a noisy link.' },
        delayMs: { type: 'integer', description: 'Pause after each slice in ms, default 8. Retries automatically halve the slice and double the pause.' },
        attempts: { type: 'integer', description: 'Verification attempts before giving up, default 3 (cap 5).' },
        timeoutMs: { type: 'integer', description: 'Minimum per-transfer timeout, default 60000.' },
        session: { type: 'string', description: 'Session id / port. Defaults to the active session.' },
      },
      async run(args) {
        const result = await manager.pull({
          remotePath: args.remotePath,
          localPath: args.localPath,
          maxBytes: Number(args.maxBytes) || 8 * 1024 * 1024,
          pieceChars: Number(args.pieceChars) || 64,
          delayMs: args.delayMs === undefined ? 8 : Number(args.delayMs),
          attempts: Math.min(5, Math.max(1, Number(args.attempts) || 3)),
          timeoutMs: Math.min(600000, Math.max(5000, Number(args.timeoutMs) || 60000)),
          session: args.session,
        })
        const verify = result.remoteSha
          ? `sha256 ${result.remoteSha.slice(0, 12)}${result.localSha ? (result.remoteSha === result.localSha ? ' (match)' : ' (MISMATCH)') : ''}`
          : 'sha256 n/a'
        if (!result.ok) return { ok: false, text: `pull FAILED: ${result.error}\n${verify}` }
        return `pulled ${result.bytes} bytes ${result.remotePath} -> ${result.localPath}\n${verify}\nattempt=${result.attempts}, ${result.pieceChars} chars per ${result.delayMs} ms slice`
      },
    }),
  ]
}

/** Interpret \r \n \t \\ \xNN escapes in a rule's send string. */
function decodeEscapes(value) {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
}

/**
 * Regression tests for the 0.1.3 interaction fixes (real board, COM15).
 *
 *   node test/features.mjs [COM15] [1500000]
 *
 * Covers:
 *   1. echo exclusion   — an expect pattern that also appears in the command
 *   2. captureExitCode  — structured $? (0 and non-zero)
 *   3. serial_script    — multi-line script with pipes/quotes/heredoc
 *   4. idleMs framing   — output without a trailing newline
 */

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

try {
  const session = await manager.open({ port, baud })
  await session.transact({ data: '', patterns: [PROMPT], timeoutMs: 8000 })

  // 1. echo exclusion: the command itself contains the pattern word.
  const echoed = await session.transact({ data: 'echo login: ; echo he_llo', patterns: ['login:'], timeoutMs: 8000 })
  check('echo-exclusion matched', echoed.matched)
  check('echo-exclusion skipped echo', echoed.searchFrom > echoed.from, `searchFrom=${echoed.searchFrom} baseline=${echoed.from}`)
  const clean = stripAnsi(echoed.text).trim()
  check('echo-exclusion output is the real line', clean === 'login:', JSON.stringify(clean))

  // 2. captureExitCode
  const ok = await session.transact({ data: 'true', captureExitCode: true, timeoutMs: 8000 })
  check('exit code 0', ok.exitCode === 0, `exitCode=${ok.exitCode}`)
  const bad = await session.transact({ data: 'false', captureExitCode: true, timeoutMs: 8000 })
  check('exit code 1', bad.exitCode === 1, `exitCode=${bad.exitCode}`)
  // Use a subshell: a bare `exit 7` would log the interactive shell out.
  const withOutput = await session.transact({ data: 'echo out_before; (exit 7)', captureExitCode: true, timeoutMs: 8000 })
  check('exit code 7 with output', withOutput.exitCode === 7 && stripAnsi(withOutput.text).includes('out_before'), `exitCode=${withOutput.exitCode} text=${JSON.stringify(withOutput.text)}`)

  // Back to a shell prompt (the board auto-logins after a logout).
  for (let i = 0; i < 5; i += 1) {
    const ready = await session.transact({ data: '', patterns: [PROMPT], timeoutMs: 4000 })
    if (ready.matched) break
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  // 3. serial_script: pipes, quotes, loops, heredoc.
  const script = [
    'set -e',
    'x="a b c"',
    'printf "%s\\n" "$x" | tr " " "-"',
    'for i in 1 2 3; do echo "n$i"; done',
    'cat <<EOF',
    'heredoc $x',
    'EOF',
  ].join('\n')
  const ran = await manager.script({ script })
  const ranText = stripAnsi(ran.output)
  check('script exit 0', ran.exitCode === 0, `exitCode=${ran.exitCode} err=${ran.error ?? ''}`)
  check('script pipes work', ranText.includes('a-b-c'), JSON.stringify(ranText))
  check('script loop works', ranText.includes('n3'), JSON.stringify(ranText))
  check('script heredoc works', ranText.includes('heredoc a b c'), JSON.stringify(ranText))

  const failing = await manager.script({ script: 'echo before_fail; exit 7' })
  check('script reports exit 7', failing.exitCode === 7 && stripAnsi(failing.output).includes('before_fail'), `exitCode=${failing.exitCode}`)

  // 4. idle framing: printf emits no trailing newline.
  const idle = await session.transact({ data: "printf 'abc123'", patterns: ['NEVER_MATCH_ANYTHING'], timeoutMs: 8000, idleMs: 300 })
  check('idle framing returns early', idle.idle === true && idle.elapsedMs < 3000, `idle=${idle.idle} elapsed=${idle.elapsedMs}`)
  check('idle framing keeps partial output', stripAnsi(idle.text).includes('abc123'), JSON.stringify(idle.text))

  await session.close()
  console.log(failures === 0 ? '\nALL FEATURE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  if (failures > 0) process.exitCode = 1
} catch (error) {
  console.error('FAILED:', error)
  process.exitCode = 1
} finally {
  await manager.dispose()
}

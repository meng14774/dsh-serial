/**
 * Optional browser surface for dsh-serial.
 *
 * A single self-contained page (`/dsh-serial`) that polls the same in-memory
 * ring the agent tools use, plus a tiny JSON API:
 *
 *   GET  /api/dsh-serial/state                 sessions + defaults
 *   GET  /api/dsh-serial/read?cursor=N&max=M   new bytes since a cursor
 *   POST /api/dsh-serial/open                  {port?, baud?}
 *   POST /api/dsh-serial/write                 {data, newline?, session?}
 *   POST /api/dsh-serial/close                 {all?}
 *
 * No client bundle is involved: the page is plain HTML served by the host, so
 * the plugin stays a host-only bundle. Writes are fenced to loopback requests
 * with a JSON content type (a local console must not be reachable from a LAN
 * browser tab or a cross-site form post).
 */

import { stripAnsi } from './engine.js'

/** Max bytes one page poll may return. */
const MAX_READ = 64 * 1024

/** Loopback-only guard (the host binds 127.0.0.1 in the desktop app). */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Reject cross-site writes: browsers send this header on cross-origin POSTs. */
function isSameSite(req) {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  return true
}

/** JSON body reader with a small cap (console keystrokes only). */
async function readJson(req, maxBytes = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Decode a query parameter. */
function query(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Build the route list for this plugin instance. */
export function makeRoutes(manager) {
  return [
    {
      kind: 'exact',
      path: '/dsh-serial',
      handler: (req, res) => {
        if (!isLoopback(req)) { json(res, 403, { error: 'forbidden' }); return }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(PAGE)
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-serial/state',
      handler: (req, res) => {
        if (!isLoopback(req)) { json(res, 403, { error: 'forbidden' }); return }
        const cfg = manager.cfg()
        json(res, 200, {
          sessions: manager.status(),
          retained: manager.retainedBuffers(),
          defaultPort: cfg.defaultPort,
          defaultBaud: cfg.defaultBaud,
          lastPort: manager.state.lastPort ?? null,
          lastBaud: manager.state.lastBaud ?? null,
          defaultSession: manager.get()?.id ?? null,
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-serial/read',
      handler: async (req, res) => {
        if (!isLoopback(req)) { json(res, 403, { error: 'forbidden' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const cursorParam = query(url, 'cursor')
        let session
        try {
          session = manager.get({ session: query(url, 'session') })
        } catch (error) {
          // A port whose session ended keeps its buffer; the page can still read it
          // by asking for that port explicitly, but it must not silently switch.
          json(res, 200, { session: null, cursor: null, text: '', note: error instanceof Error ? error.message : String(error) })
          return
        }
        if (!session) { json(res, 200, { session: null, cursor: null, text: '', note: 'no open serial session' }); return }
        let from = cursorParam === undefined || cursorParam === '' ? session.ring.start : Number(cursorParam)
        if (!Number.isFinite(from)) from = session.ring.start
        const maxBytes = Math.min(MAX_READ, Math.max(1, Number(query(url, 'max')) || MAX_READ))
        const result = await session.read({ from, maxBytes, waitMs: 0 })
        json(res, 200, {
          session: session.id,
          cursor: result.cursor,
          gap: result.gap,
          bytes: result.data.length,
          text: stripAnsi(result.text),
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-serial/open',
      handler: async (req, res) => {
        if (!isLoopback(req) || !isSameSite(req)) { json(res, 403, { error: 'forbidden' }); return }
        if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
        const body = await readJson(req)
        const cfg = manager.cfg()
        const port = body.port || manager.state.lastPort || cfg.defaultPort
        try {
          const session = await manager.open({ port, baud: body.baud ?? cfg.defaultBaud })
          json(res, 200, { ok: true, session: session.status() })
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-serial/write',
      handler: async (req, res) => {
        if (!isLoopback(req) || !isSameSite(req)) { json(res, 403, { error: 'forbidden' }); return }
        if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
        const body = await readJson(req)
        const session = await manager.ensureSession({ session: body.session })
        const data = String(body.data ?? '')
        const newline = body.newline === 'none' ? '' : body.newline === 'lf' ? '\n' : body.newline === 'crlf' ? '\r\n' : '\r'
        const result = await session.write(Buffer.from(/\r|\n$/.test(data) ? data : data + newline, 'utf8'))
        json(res, 200, { ok: true, bytes: result.bytes, cursor: result.cursor })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-serial/close',
      handler: async (req, res) => {
        if (!isLoopback(req) || !isSameSite(req)) { json(res, 403, { error: 'forbidden' }); return }
        if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
        const body = await readJson(req)
        const closed = await manager.close({ all: body.all === true, session: body.session })
        json(res, 200, { ok: true, closed })
      },
    },
  ]
}

/** The self-contained console page (no external assets). */
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Serial</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #101114; color: #d7dae0; font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
  header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #17181c; border-bottom: 1px solid #2a2c33; flex-wrap: wrap; }
  header .title { font-weight: 600; letter-spacing: .5px; color: #9fb4ff; margin-right: 6px; }
  select, input, button { font: inherit; color: inherit; background: #1e2026; border: 1px solid #343742; border-radius: 6px; padding: 5px 8px; }
  button { cursor: pointer; }
  button:hover { border-color: #4b5bd6; }
  #state { color: #8b93a7; }
  #log { flex: 1; margin: 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  footer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #2a2c33; background: #17181c; }
  footer input { flex: 1; }
  .err { color: #ff6b6b; }
  .ok { color: #5ad48a; }
</style>
</head>
<body>
<header>
  <span class="title">DSH · SERIAL</span>
  <select id="session" title="会话"></select>
  <button id="open">打开默认串口</button>
  <button id="close">关闭</button>
  <span id="state">connecting…</span>
</header>
<pre id="log"></pre>
<footer>
  <input id="input" placeholder="输入命令并回车发送" autocomplete="off">
  <select id="nl" title="行尾">
    <option value="cr">CR</option>
    <option value="lf">LF</option>
    <option value="crlf">CRLF</option>
    <option value="none">none</option>
  </select>
  <button id="send">发送</button>
</footer>
<script>
const $ = (id) => document.getElementById(id)
const log = $('log')
let cursor = null
let current = null

function append(text) {
  if (!text) return
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24
  log.textContent += text
  if (log.textContent.length > 400000) log.textContent = log.textContent.slice(-200000)
  if (atBottom) log.scrollTop = log.scrollHeight
}

async function api(path, options) {
  const res = await fetch(path, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}

async function refreshState() {
  try {
    const state = await api('/api/dsh-serial/state')
    const sessions = state.sessions || []
    const sel = $('session')
    const wanted = sessions.map((s) => s.id)
    sel.innerHTML = ''
    for (const s of sessions) {
      const option = document.createElement('option')
      option.value = s.id
      option.textContent = s.id + ' @ ' + s.baud + ' (' + s.state + ')'
      sel.appendChild(option)
    }
    if (state.defaultSession) sel.value = state.defaultSession
    current = state.defaultSession
    $('state').innerHTML = state.defaultSession
      ? '<span class="ok">●</span> ' + state.defaultSession + ' · unread ' + (sessions[0] ? sessions[0].unreadBytes : 0)
      : '未打开（默认 ' + state.defaultPort + ' @ ' + state.defaultBaud + '）'
    if (!state.defaultSession) cursor = null
  } catch (error) {
    $('state').innerHTML = '<span class="err">' + error.message + '</span>'
  }
}

async function poll() {
  try {
    const query = cursor === null ? '?cursor=start&max=32768' : '?cursor=' + cursor
    const chunk = await api('/api/dsh-serial/read' + query)
    if (chunk.session) {
      if (cursor !== null && chunk.cursor > cursor) append(chunk.text)
      cursor = chunk.cursor
    }
  } catch (error) {
    $('state').innerHTML = '<span class="err">' + error.message + '</span>'
  }
}

$('open').onclick = async () => {
  try {
    const body = await api('/api/dsh-serial/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    append('\\n[opened ' + body.session.port + ' @ ' + body.session.baud + ']\\n')
    cursor = null
    await refreshState()
  } catch (error) { append('\\n[error] ' + error.message + '\\n') }
}

$('close').onclick = async () => {
  try {
    await api('/api/dsh-serial/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) })
    append('\\n[closed]\\n')
    cursor = null
    await refreshState()
  } catch (error) { append('\\n[error] ' + error.message + '\\n') }
}

async function send() {
  const input = $('input')
  const data = input.value
  if (!data) return
  try {
    await api('/api/dsh-serial/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, newline: $('nl').value, session: $('session').value || undefined }),
    })
    input.value = ''
  } catch (error) { append('\\n[error] ' + error.message + '\\n') }
}

$('send').onclick = send
$('input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); send() } })

// If the session changes, restart the view from the oldest retained byte.
$('session').addEventListener('change', () => { cursor = null })

refreshState()
setInterval(refreshState, 2000)
setInterval(poll, 350)
</script>
</body>
</html>`

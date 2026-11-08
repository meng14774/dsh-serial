# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] — 2026-11-07

macOS porting release. Behaviour on Windows is unchanged.

### Added

- `build.sh` and `test/prepare-deps.sh` (POSIX twins of the PowerShell scripts).
- `test/platform.mjs`: offline checks for platform-specific wording.
- `PORTING-macOS.md`: handover document for running/testing the plugin on a Mac.
- `/dev/tty.*` notice on macOS: the dial-in device can block on carrier, use `/dev/cu.*`.
- sidecar `ready` now reports `platform` and `linkWatch`.

### Changed

- Non-Windows defaults: `pythonPath` is `python3`, `defaultPort` is empty (no more
  opening a nonexistent `COM15` on macOS), and the port example in messages is
  `/dev/cu.usbserial-1420` on macOS and `/dev/ttyUSB0` on Linux.
- `serial_status` prints `link: NOT OBSERVABLE …` where the OS cannot report driver
  loss counters (macOS/Linux), instead of claiming the link was clean.
- `recovery.mjs` supports `DSH_SERIAL_OFFLINE=1` to run only its offline part.

### Notes

- Not verified on real macOS hardware in this release; see section 9 of
  `PORTING-macOS.md` for the risk list and the verification checklist.
- On macOS, non-standard baud rates (e.g. 1500000) go through `IOSSIOSPEED`; that works
  with FTDI/CH34x USB drivers but fails with `Errno 25` on anything that does not
  implement the ioctl (e.g. a pty).

## [0.1.6] — 2026-11-02

### Added

- **Port safety**: a dead session is only ever reopened on **its own port**; a failed
  reopen reports the port, the end time and the reason. `defaultPort` is a last resort
  used only when no port was ever opened, and it says so.
- **Per-port retained buffers**: the ring buffer and tail cursor survive session death,
  so unread bytes stay readable and the cursor is continuous across a reopen.
  `serial_close { dropBuffer: true }` is the only way to discard it.
- Death notices (`! session … ended at …`) on the next tool result, plus
  `serial_list`/`serial_status` visibility and a web `retained` field.
- `serial_ping` (one CR, or passive listen) to tell "the link is dead" from "the pattern
  did not match"; `serial_set_default` to persist the preferred port/baud.
- `test/recovery.mjs`: offline checks plus 16 live checks (kill the reader, verify the
  port is not swapped, the notice appears, the buffer is still readable, ping works).

### Changed

- `serial_transact` timeouts now explain themselves: 0 bytes / echo then silence /
  output but no prompt each get a different conclusion and next step.

## [0.1.5] — 2026-11-02

### Added

- Loss detection: the sidecar polls `ClearCommError` and reports `CE_*` overruns, so
  `serial_read`/`serial_transact` can warn when a capture window lost bytes.
- `serial_transact { verify: true }`: tee + remote sha256, falling back to the paced
  chunked reader when the live capture is dirty. The command still runs once.
- Paced `serial_pull` (64 chars / 8 ms by default) with whole-file sha256 and automatic
  back-off retries.

### Changed

- `serial_status` gains a `link:` line; the old `dropped` counter is now `ring-overflow`
  (buffer overwrite), which is a different thing from driver-level loss.
- Timeout with the prompt already seen is reported as `timeout-but-prompt-seen`.

## [0.1.4] — 2026-11-01

- `serial_pull` verifies sha256 and retries automatically.
- `captureExitCode` no longer leaks its internal marker into the rendered output.

## [0.1.3] — 2026-11-01

- `serial_transact` skips the echoed command line before searching, so the pattern may
  appear in the command itself.
- `captureExitCode`, `serial_script` (base64 → temp file, no argv quoting), `idleMs`
  framing for output without newlines, sha256-checked `serial_push` with retries.

## [0.1.2] — 2026-11-01

- The sidecar exits immediately when its reader thread dies, so the OS port is released
  instead of leaving a zombie "open but dead" session.
- `ensureSession` reopens failed/closed sessions and reports the previous reason.

## [0.1.1] — 2026-11-01

- Web console at `/dsh-serial` plus `/api/dsh-serial/*` (loopback only).
- The 13-tool set including push/pull, rules and baud probing.

## [0.1.0] — 2026-11-01

- First usable version: engine, ring buffer, absolute cursors, expect/transact,
  auto-responder rules.
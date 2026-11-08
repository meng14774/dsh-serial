#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-serial sidecar — owns exactly one serial port and speaks NDJSON.

Run by the dsh-serial host plugin (lib/engine.js), one process per open port.
It deliberately does NOT write any log file: stdout is a machine protocol and
RX bytes are forwarded to the parent, which keeps them in an in-memory ring
buffer that agents read through cursor-based tools.

stdout protocol (one JSON object per line, ASCII only):

    {"t":"ready","port":"COM15","baud":1500000,...}
    {"t":"ports","ports":[{device,description,hwid,vid,pid,...}]}   # --list
    {"t":"d","b64":"..."}          # bytes received from the device
    {"t":"link","flags":N,"new":N,"rx":N}   # driver reported lost bytes (see below)
    {"t":"tx","b64":"..."}         # bytes we just sent (for the live console)
    {"t":"ack","id":N,"op":"write","bytes":N}
    {"t":"error","id":N,"op":"write","message":"..."}
    {"t":"closed"}

stdin protocol (one JSON object per line):

    {"id":1,"op":"write","b64":"..."}   # or {"text":"..."} for UTF-8 text
    {"id":2,"op":"baud","baud":115200}
    {"id":3,"op":"dtr","value":true}
    {"id":4,"op":"rts","value":false}
    {"id":5,"op":"pulse","line":"dtr","ms":200,"active":true}
    {"id":6,"op":"break","ms":250}
    {"id":7,"op":"flush"}
    {"id":8,"op":"close"}
    {"id":9,"op":"ping"}
"""

import argparse
import base64
import ctypes
import json
import os
import sys
import threading
import time

_emit_lock = threading.Lock()


def emit(obj):
    """Write one JSON line to stdout (thread safe, never raises to the caller)."""
    try:
        line = json.dumps(obj, ensure_ascii=True, separators=(",", ":")) + "\n"
        with _emit_lock:
            sys.stdout.write(line)
            sys.stdout.flush()
    except Exception:
        # The parent went away; nothing useful can be done.
        pass


def list_ports():
    """Report every serial port the OS knows about, with USB identifiers."""
    from serial.tools import list_ports as lp

    ports = []
    for p in lp.comports():
        ports.append({
            "device": p.device,
            "description": p.description,
            "hwid": p.hwid,
            "vid": p.vid,
            "pid": p.pid,
            "serialNumber": p.serial_number,
            "manufacturer": p.manufacturer,
            "product": p.product,
            "interface": p.interface,
        })
    emit({"t": "ports", "ports": ports})


def parse_tristate(value):
    """'keep' -> None, '1'/'true' -> True, '0'/'false' -> False."""
    v = str(value).strip().lower()
    if v in ("keep", "none", ""):
        return None
    if v in ("1", "true", "yes", "on", "assert"):
        return True
    if v in ("0", "false", "no", "off", "deassert"):
        return False
    raise ValueError("bad tristate value: %r" % value)


def decode_payload(cmd):
    """Bytes for one write command: base64 wins, then UTF-8 text."""
    if "b64" in cmd:
        return base64.b64decode(cmd["b64"])
    text = cmd.get("text", "")
    return text.encode("utf-8")


def make_link_watcher(ser):
    """Return (poll, note_bytes) for driver-level receive errors, or None.

    ClearCommError() is the only place Windows tells us "bytes were lost in
    transit". A serial console at a high baud rate without flow control overruns
    its input buffer, and the driver silently drops the bytes: the host then sees
    a *shorter, plausible* stream (a shell prompt with a truncated path, an
    `ls` line missing a column) that cannot be told apart from a command that
    simply printed less. Reporting the flags lets the engine mark the affected
    window as untrusted instead of pretending the output is complete.

    flags: CE_RXOVER=1, CE_OVERRUN=2, CE_RXPARITY=4, CE_FRAME=8 (winerror.h).
    `rx` is the number of bytes received so far, i.e. the ring offset the loss
    will show up at.
    """
    try:
        from serial import win32 as w32
    except Exception:
        return None
    handle = getattr(ser, "_port_handle", None)
    if not handle:
        return None
    state = {"bits": 0, "rx": 0}

    def poll():
        err = w32.DWORD()
        comstat = w32.COMSTAT()
        try:
            if not w32.ClearCommError(handle, ctypes.byref(err), ctypes.byref(comstat)):
                return
        except Exception:
            return
        if not err.value:
            return
        state["bits"] |= err.value
        # Emit on every poll that saw an error, not only when a new bit appears:
        # CE_OVERRUN stays set for the rest of the session, and repeating events
        # are exactly what tells the engine "this window lost bytes".
        emit({"t": "link", "flags": err.value, "rx": state["rx"]})

    def note_bytes(n):
        state["rx"] += n

    return poll, note_bytes


def main(argv=None):
    ap = argparse.ArgumentParser(description="dsh-serial sidecar")
    ap.add_argument("--list", action="store_true", help="list serial ports and exit")
    ap.add_argument("--port", help="port name, e.g. COM15 or /dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--bytesize", type=int, default=8)
    ap.add_argument("--parity", default="N", choices=["N", "E", "O", "M", "S"])
    ap.add_argument("--stopbits", type=float, default=1)
    ap.add_argument("--xonxoff", action="store_true")
    ap.add_argument("--rtscts", action="store_true")
    ap.add_argument("--dsrdtr", action="store_true")
    ap.add_argument("--dtr", default="keep", help="keep | 1 | 0 — line level set on open")
    ap.add_argument("--rts", default="keep", help="keep | 1 | 0 — line level set on open")
    ap.add_argument("--rxbuf", type=int, default=65536,
                    help="suggested driver receive buffer in bytes (Windows SetupComm)")
    ap.add_argument("--label", default="", help="free-form label echoed back in ready")
    args = ap.parse_args(argv)

    if args.list:
        list_ports()
        return 0

    if not args.port:
        emit({"t": "error", "op": "open", "message": "--port is required"})
        return 2

    try:
        import serial
    except Exception as exc:  # pragma: no cover - environment problem
        emit({"t": "error", "op": "open", "message": "pyserial import failed: %s" % exc})
        return 2

    ser = serial.Serial()
    ser.port = args.port
    ser.baudrate = args.baud
    ser.bytesize = args.bytesize
    ser.parity = args.parity
    ser.stopbits = args.stopbits
    ser.timeout = 0.05
    ser.write_timeout = 5
    ser.xonxoff = args.xonxoff
    ser.rtscts = args.rtscts
    ser.dsrdtr = args.dsrdtr
    dtr = parse_tristate(args.dtr)
    rts = parse_tristate(args.rts)
    if dtr is not None:
        ser.dtr = dtr
    if rts is not None:
        ser.rts = rts

    try:
        ser.open()
    except Exception as exc:
        emit({
            "t": "error",
            "op": "open",
            "message": "cannot open %s: %s" % (args.port, exc),
            "port": args.port,
        })
        return 3

    # pySerial applies the pre-open dtr/rts properties during open(); re-apply
    # defensively so a "keep" configuration really keeps the lines untouched.
    if dtr is not None:
        try:
            ser.dtr = dtr
        except Exception:
            pass
    if rts is not None:
        try:
            ser.rts = rts
        except Exception:
            pass

    # A bigger driver receive buffer absorbs the microseconds between one read
    # completing and the next being issued. It does not fix an overrun caused by
    # a saturated link, but it removes the cheap kind of loss.
    try:
        ser.set_buffer_size(rx_size=max(4096, int(args.rxbuf)))
    except Exception:
        pass

    stop = threading.Event()
    write_lock = threading.Lock()
    link = make_link_watcher(ser)

    def reader():
        while not stop.is_set():
            try:
                data = ser.read(4096)
            except Exception as exc:
                # A read error (unplugged adapter, another program stealing the
                # port, driver reset) means the handle is unusable: report it and
                # terminate the whole sidecar so the OS releases the port. A live
                # "open" session with a dead reader would silently swallow output.
                emit({"t": "error", "op": "read", "message": "read failed: %s" % exc})
                emit({"t": "fatal", "message": "serial reader stopped: %s" % exc})
                try:
                    ser.close()
                except Exception:
                    pass
                os._exit(4)
            if data:
                if link:
                    link[1](len(data))
                emit({"t": "d", "b64": base64.b64encode(data).decode("ascii")})
            if link:
                link[0]()
        emit({"t": "closed"})

    thread = threading.Thread(target=reader, name="dsh-serial-reader", daemon=True)
    thread.start()

    emit({
        "t": "ready",
        "port": ser.port,
        "baud": ser.baudrate,
        "bytesize": ser.bytesize,
        "parity": ser.parity,
        "stopbits": ser.stopbits,
        "dtr": dtr,
        "rts": rts,
        "label": args.label,
        "pid": __import__("os").getpid(),
        # Capabilities, so the host never reports "no loss" on a platform where
        # loss simply cannot be observed. Link watcher is Win32-only today.
        "platform": sys.platform,
        "linkWatch": link is not None,
    })

    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except Exception as exc:
                emit({"t": "error", "message": "bad command json: %s" % exc})
                continue
            op = cmd.get("op")
            cid = cmd.get("id")
            try:
                if op == "write":
                    data = decode_payload(cmd)
                    with write_lock:
                        n = ser.write(data)
                        ser.flush()
                    emit({"t": "tx", "b64": base64.b64encode(data).decode("ascii")})
                    emit({"t": "ack", "id": cid, "op": "write", "bytes": n})
                elif op == "baud":
                    baud = int(cmd["baud"])
                    ser.baudrate = baud
                    emit({"t": "ack", "id": cid, "op": "baud", "baud": ser.baudrate})
                elif op == "dtr":
                    ser.dtr = bool(cmd["value"])
                    emit({"t": "ack", "id": cid, "op": "dtr", "value": ser.dtr})
                elif op == "rts":
                    ser.rts = bool(cmd["value"])
                    emit({"t": "ack", "id": cid, "op": "rts", "value": ser.rts})
                elif op == "pulse":
                    target = str(cmd.get("line", "dtr")).lower()
                    ms = max(1, int(cmd.get("ms", 200)))
                    active = bool(cmd.get("active", True))
                    if target == "rts":
                        ser.rts = active
                        time.sleep(ms / 1000.0)
                        ser.rts = not active
                    else:
                        ser.dtr = active
                        time.sleep(ms / 1000.0)
                        ser.dtr = not active
                    emit({"t": "ack", "id": cid, "op": "pulse", "line": target, "ms": ms})
                elif op == "break":
                    ms = max(1, int(cmd.get("ms", 250)))
                    ser.send_break(duration=ms / 1000.0)
                    emit({"t": "ack", "id": cid, "op": "break", "ms": ms})
                elif op == "flush":
                    ser.reset_input_buffer()
                    emit({"t": "ack", "id": cid, "op": "flush"})
                elif op == "ping":
                    emit({"t": "ack", "id": cid, "op": "ping"})
                elif op == "close":
                    emit({"t": "ack", "id": cid, "op": "close"})
                    break
                else:
                    emit({"t": "error", "id": cid, "op": op, "message": "unknown op: %r" % op})
            except Exception as exc:
                emit({"t": "error", "id": cid, "op": op, "message": "%s: %s" % (type(exc).__name__, exc)})
    finally:
        stop.set()
        try:
            ser.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

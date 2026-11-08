#!/usr/bin/env python3
"""Byte-loss diagnostic for the dsh-serial link (board -> host).

usage:
    python lossdiag.py COM15 1500000 [strategy] [count] [burst|paced]

strategy: r4096 | r65536 | block | small      (read strategy under test)
mode:     burst (seq, ~187 KB/s) | paced (sleep 2 ms per line, ~4 KB/s)

Prints how many numbers never made it across, plus the raw text around the
first few gaps so you can see whether whole lines vanish or single bytes.
"""
import ctypes
import sys
import time

import serial

CE_BITS = {0x0001: "RXOVER", 0x0002: "OVERRUN", 0x0004: "RXPARITY", 0x0008: "FRAME"}


class ErrorWatcher:
    """Accumulate the driver's comm-error flags while the stream runs.

    ClearCommError() reports (and clears) CE_RXOVER / CE_OVERRUN / CE_RXPARITY /
    CE_FRAME, which is exactly the evidence we need to tell "the Windows driver
    dropped bytes" apart from "the bytes never left the board".
    """

    def __init__(self, ser):
        self.ok = False
        self.seen = 0
        try:
            from serial import win32 as w32
            self.w32 = w32
            self.handle = ser._port_handle
            self.ok = True
        except Exception:
            return

    def poll(self):
        if not self.ok:
            return
        err = self.w32.DWORD()
        comstat = self.w32.COMSTAT()
        try:
            self.w32.ClearCommError(self.handle, ctypes.byref(err), ctypes.byref(comstat))
        except Exception:
            self.ok = False
            return
        self.seen |= err.value

    def report(self):
        if not self.ok:
            print("comm errors: unavailable")
            return
        if not self.seen:
            print("comm errors: none (driver saw a clean stream)")
            return
        names = [name for bit, name in CE_BITS.items() if self.seen & bit]
        print("comm errors: 0x%04x %s" % (self.seen, ",".join(names)))


def read_loop(ser, strategy, deadline, quiet_ms=400, watcher=None):
    out = bytearray()
    last = time.time()
    end_at = None
    while time.time() < deadline:
        if strategy == "block":
            ser.timeout = None
            chunk = ser.read(1)
            while ser.in_waiting:
                chunk += ser.read(ser.in_waiting)
            ser.timeout = 0.05
        else:
            size = {"r4096": 4096, "r65536": 65536, "small": 256,
                    "block4096": 4096, "block512": 512}[strategy]
            if strategy.startswith("block"):
                ser.timeout = None
            chunk = ser.read(size)
            if strategy.startswith("block"):
                ser.timeout = 0.05
        if watcher is not None:
            watcher.poll()
        if chunk:
            out += chunk
            last = time.time()
            end_at = None
            continue
        if out and out.rstrip().endswith(b"$"):
            # prompt seen: give the link a quiet moment, then stop
            if end_at is None:
                end_at = time.time() + 0.15
            elif time.time() >= end_at:
                break
        elif time.time() - last > quiet_ms / 1000.0 and len(out) > 2000:
            break
    return bytes(out)


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "COM15"
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 1500000
    strategy = sys.argv[3] if len(sys.argv) > 3 else "r4096"
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 30000
    mode = sys.argv[5] if len(sys.argv) > 5 else "burst"

    ser = serial.Serial(port, baud, timeout=0.05)
    if strategy == "r65536":
        try:
            ser.set_buffer_size(rx_size=131072)
        except Exception as exc:
            print("set_buffer_size failed:", exc)
    time.sleep(0.3)
    ser.reset_input_buffer()

    if mode == "paced":
        cmd = ("i=0; while [ $i -lt %d ]; do i=$((i+1)); printf '%%06d\\n' $i; sleep 0.002; done"
               % count).encode()
    else:
        cmd = ("seq -f '%%06g' 1 %d" % count).encode()
    ser.write(cmd + b"\r")

    watcher = ErrorWatcher(ser)
    raw = read_loop(ser, strategy, time.time() + 120, watcher=watcher)
    watcher.report()
    ser.close()

    text = raw.decode("utf-8", "replace").replace("\r", "")
    lines = text.split("\n")
    seen = []
    offsets = []
    for line in lines:
        s = line.strip()
        if len(s) == 6 and s.isdigit():
            seen.append(int(s))
            offsets.append(text.find(s))

    expected = list(range(1, count + 1))
    got = set(seen)
    missing = [n for n in expected if n not in got]
    dupes = len(seen) - len(got)
    print("strategy=%s mode=%s bytes=%d numbers=%d missing=%d dupes=%d"
          % (strategy, mode, len(raw), len(seen), len(missing), dupes))

    # group missing numbers into runs and show the text where they should be
    runs = []
    for n in missing:
        if runs and n == runs[-1][-1] + 1:
            runs[-1].append(n)
        else:
            runs.append([n])
    print("missing runs: %d" % len(runs))
    for run in runs[:6]:
        anchor = "0000%02d" % run[0] if run[0] < 100 else "%06d" % run[0]
        pos = text.find(anchor)
        if pos < 0:
            # anchor itself was mangled: search by the previous number
            prev = "%06d" % (run[0] - 1) if run[0] > 1 else None
            pos = text.find(prev) if prev else 0
        print("  run %d..%d (n=%d) near byte %d: %r"
              % (run[0], run[-1], len(run), pos, text[max(0, pos - 50):pos + 50]))
    # every-16-byte sanity: does the text hold a full 6-digit grid?
    return 0 if not missing else 2


if __name__ == "__main__":
    sys.exit(main())

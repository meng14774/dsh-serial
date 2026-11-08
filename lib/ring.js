/**
 * In-memory byte ring for one serial port.
 *
 * The ring is the reason this plugin needs no log files: it keeps the last N
 * bytes of device output (default 4 MiB) with absolute byte offsets, so any
 * agent can ask "give me everything after offset K" at any time, even if it
 * was not running when the bytes arrived. Old bytes are dropped only when the
 * capacity is exceeded; readers learn about the gap through `dropped`.
 */

/** @typedef {{start:number, end:number, ts:number, buf:Buffer}} Chunk */

export class RingBuffer {
  /** @param {number} capacityBytes - bytes to keep before dropping the oldest data. */
  constructor(capacityBytes = 4 * 1024 * 1024) {
    /** @type {number} */
    this.capacity = Math.max(1024, Math.floor(capacityBytes))
    /** @type {Chunk[]} */
    this.chunks = []
    /** Absolute offset of the oldest retained byte. */
    this.start = 0
    /** Absolute offset one past the newest byte. */
    this.end = 0
    /** Bytes currently retained. */
    this.totalBytes = 0
    /** Total bytes ever appended. */
    this.receivedBytes = 0
    /** Total bytes dropped because of the capacity cap. */
    this.droppedBytes = 0
    /** Timestamp of the newest append. */
    this.lastWriteAt = 0
    /** Timestamp of the oldest retained byte (approximate). */
    this.firstWriteAt = 0
  }

  /**
   * Append one RX chunk.
   * @param {Buffer} buf
   * @param {number} [ts]
   */
  append(buf, ts = Date.now()) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
    if (buf.length === 0) return
    if (buf.length > this.capacity) {
      // One chunk larger than the whole ring: keep only its tail.
      const keep = buf.subarray(buf.length - this.capacity)
      this.append(keep, ts)
      return
    }
    const start = this.end
    this.chunks.push({ start, end: start + buf.length, ts, buf })
    this.end = start + buf.length
    this.totalBytes += buf.length
    this.receivedBytes += buf.length
    if (this.firstWriteAt === 0) this.firstWriteAt = ts
    this.lastWriteAt = ts
    this.#trim()
  }

  /** Drop oldest chunks until the retained size fits the capacity. */
  #trim() {
    while (this.totalBytes > this.capacity && this.chunks.length > 0) {
      const chunk = this.chunks.shift()
      this.totalBytes -= chunk.buf.length
      this.start = chunk.end
      this.droppedBytes += chunk.buf.length
    }
    if (this.chunks.length === 0) {
      this.start = this.end
    }
  }

  /**
   * Copy the retained bytes in [from, to), clamped to what is still buffered.
   * @param {number} from - absolute offset (inclusive).
   * @param {number} to - absolute offset (exclusive).
   * @returns {Buffer}
   */
  slice(from, to) {
    const lo = Math.max(from, this.start)
    const hi = Math.min(to, this.end)
    if (hi <= lo) return Buffer.alloc(0)
    const parts = []
    let size = 0
    for (const chunk of this.chunks) {
      if (chunk.end <= lo) continue
      if (chunk.start >= hi) break
      const a = Math.max(lo, chunk.start) - chunk.start
      const b = Math.min(hi, chunk.end) - chunk.start
      const part = chunk.buf.subarray(a, b)
      parts.push(part)
      size += part.length
    }
    return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, size)
  }

  /**
   * Read up to maxBytes starting at `from`.
   * @param {number} from - absolute offset (inclusive).
   * @param {number} [maxBytes]
   * @returns {{data:Buffer, from:number, to:number, gap:number, available:number}}
   */
  read(from, maxBytes = 256 * 1024) {
    const requested = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : this.start
    const lo = Math.max(requested, this.start)
    const gap = lo - requested
    const hi = Math.min(this.end, lo + Math.max(1, maxBytes))
    const data = this.slice(lo, hi)
    return { data, from: lo, to: lo + data.length, gap, available: this.end - lo }
  }

  /** Decode a retained range as text. */
  text(from, to, encoding = 'utf8') {
    return this.slice(from, to).toString(encoding)
  }

  /** Bytes retained right now. */
  get size() {
    return this.totalBytes
  }
}

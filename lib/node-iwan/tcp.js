import { randomInt } from 'node:crypto'
import { Duplex } from 'node:stream'
import { internetChecksum, ipv4Bytes, ipv4Header, pseudoHeader, readIpv4 } from './ipv4.js'

const TCP = 6
const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16
const FIRST_PORT = 49152, PORT_COUNT = 16384
const MAX_FLOWS = 128, MAX_TIME_WAIT = 256, RX_CAPACITY = 65535
const BASE_RTO_MS = 500, MAX_RTO_MS = 4000, MAX_RETRIES = 5, TIME_WAIT_MS = 60000
const add = (seq, amount) => (seq + amount) >>> 0
const before = (a, b) => ((a - b) | 0) < 0
const between = (n, low, high) => !before(n, low) && !before(high, n)
const empty = Buffer.alloc(0)
const errorWith = (code, message) => Object.assign(new Error(message), { code })
const abortReason = signal => signal.reason instanceof Error ? signal.reason : errorWith('ABORT_ERR', 'TCP connection aborted')

function decode(packet, local, mtu) {
  if (packet?.length > mtu) return null
  const ip = readIpv4(packet, TCP)
  if (!ip || !ip.destination.equals(local) || ip.payload.length < 20) return null
  const b = ip.payload
  const size = (b[12] >>> 4) * 4
  if (size < 20 || size > b.length || internetChecksum(pseudoHeader(ip.source, local, TCP, b.length), b) !== 0) return null
  return {
    remote: ip.source, remotePort: b.readUInt16BE(0), port: b.readUInt16BE(2),
    seq: b.readUInt32BE(4), ack: b.readUInt32BE(8), flags: b[13], window: b.readUInt16BE(14),
    options: b.subarray(20, size), payload: b.subarray(size),
  }
}

function remoteMss(options) {
  for (let i = 0; i < options.length;) {
    const kind = options[i]
    if (kind === 0) break
    if (kind === 1) { i++; continue }
    const size = options[i + 1]
    if (!(size >= 2) || i + size > options.length) break
    if (kind === 2 && size === 4) return options.readUInt16BE(i + 2) || 536
    i += size
  }
  return 536
}

// An active-open, stop-and-wait TCP endpoint. The tunnel carries IP packets, not TCP byte streams.
// We advertise an unscaled receive window, discard gaps for retransmission, and never listen on IP.
export function createTcpStack({ address, mtu, send }) {
  const local = ipv4Bytes(address)
  if (!Number.isInteger(mtu) || mtu < 576 || mtu > 65535 || typeof send !== 'function') throw new TypeError('Invalid TCP stack MTU or send function')
  const mss = mtu - 40
  const mssOption = Buffer.from([2, 4, mss >>> 8, mss & 255])
  const flows = new Map(), waiting = new Map()
  let portCursor = randomInt(PORT_COUNT), identification = randomInt(65536), closed = false

  function stopHandshake(flow) {
    clearTimeout(flow.deadline)
    flow.deadline = undefined
  }

  function clearFlight(flow) {
    clearTimeout(flow.timer)
    flow.timer = undefined
    flow.flight = undefined
  }

  function detach(flow) {
    if (flow.state === 'closed') return
    if (flow.state === 'time-wait') waiting.delete(flow.port)
    else flows.delete(flow.port)
    flow.state = 'closed'
    stopHandshake(flow)
    clearFlight(flow)
    flow.signal?.removeEventListener('abort', flow.aborted)
  }

  function fail(flow, error) {
    if (flow.state === 'closed') return
    const rejection = flow.state === 'syn'
    detach(flow)
    if (rejection) flow.reject(error)
    if (flow.writer) {
      const { callback } = flow.writer
      flow.writer = null
      callback(error)
    }
    if (flow.final) {
      const callback = flow.final
      flow.final = null
      callback(error)
    }
    flow.stream?.destroy(error)
  }

  function window(flow) {
    return flow.remoteFin ? 0 : RX_CAPACITY - (flow.stream?.readableLength ?? 0)
  }

  function emit(flow, seq, flags, payload = empty, options = empty) {
    if (closed || flow.state === 'closed') return
    const h = Buffer.alloc(20 + options.length)
    h.writeUInt16BE(flow.port, 0)
    h.writeUInt16BE(flow.remotePort, 2)
    h.writeUInt32BE(seq, 4)
    if (flags & ACK) h.writeUInt32BE(flow.recvNext, 8)
    h[12] = (h.length / 4) << 4
    h[13] = flags
    options.copy(h, 20)
    flow.lastWindow = window(flow)
    h.writeUInt16BE(flow.lastWindow, 14)
    const length = h.length + payload.length
    h.writeUInt16BE(internetChecksum(pseudoHeader(local, flow.remote, TCP, length), h, payload), 16)
    try {
      send(Buffer.concat([ipv4Header(local, flow.remote, TCP, length, identification++), h, payload]))
    } catch (err) {
      fail(flow, err instanceof Error ? err : new Error(String(err)))
    }
  }

  function sendAck(flow) { emit(flow, flow.sendNext, ACK) }

  function sendFlight(flow) {
    const f = flow.flight
    flow.timer = setTimeout(() => {
      if (flow.flight !== f) return
      if (++f.retries > MAX_RETRIES) return fail(flow, errorWith('ETIMEDOUT', 'TCP retransmission limit reached'))
      sendFlight(flow)
    }, Math.min(BASE_RTO_MS * 2 ** f.retries, MAX_RTO_MS)).unref()
    emit(flow, f.seq, f.flags, f.payload, f.options)
  }

  function fly(flow, flags, payload = empty, options = empty, probe = false) {
    const seq = flow.sendNext
    flow.sendNext = add(seq, payload.length + Number(Boolean(flags & (SYN | FIN))))
    flow.flight = { seq, flags, payload, options, retries: 0, probe }
    sendFlight(flow)
  }

  function persist(flow, retries = 0) {
    if (flow.timer) return
    flow.timer = setTimeout(() => {
      flow.timer = undefined
      if (flow.state !== 'open' || flow.flight) return
      if (flow.peerWindow) return pump(flow)
      if (flow.writer) return transmitData(flow, 1, true)
      if (!flow.final) return
      if (retries >= MAX_RETRIES) return fail(flow, errorWith('ETIMEDOUT', 'TCP peer receive window stayed closed'))
      persist(flow, retries + 1)
      emit(flow, add(flow.sendNext, -1), ACK)
    }, Math.min(BASE_RTO_MS * 2 ** retries, MAX_RTO_MS)).unref()
  }

  function transmitData(flow, limit, probe = false) {
    const writer = flow.writer
    const end = writer.offset + Math.min(limit, writer.data.length - writer.offset)
    const payload = writer.data.subarray(writer.offset, end)
    writer.offset = end
    fly(flow, ACK | PSH, payload, empty, probe)
  }

  function pump(flow) {
    if (flow.state !== 'open' || flow.flight) return
    if (flow.writer && flow.writer.offset === flow.writer.data.length) {
      const { callback } = flow.writer
      flow.writer = null
      callback()
      if (flow.state !== 'open' || flow.flight) return
    }
    if (!flow.writer && !flow.final) return
    if (!flow.peerWindow) return persist(flow)
    clearTimeout(flow.timer)
    flow.timer = undefined
    if (flow.writer) transmitData(flow, Math.min(flow.mss, flow.peerWindow))
    else if (!flow.localFin) {
      flow.localFin = true
      fly(flow, FIN | ACK)
    }
  }

  function retire(flow) {
    if (flow.state !== 'open') return
    flows.delete(flow.port)
    flow.signal?.removeEventListener('abort', flow.aborted)
    clearFlight(flow)
    flow.state = 'time-wait'
    flow.stream = undefined
    waiting.set(flow.port, flow)
    if (waiting.size > MAX_TIME_WAIT) detach(waiting.values().next().value)
    flow.timer = setTimeout(() => detach(flow), TIME_WAIT_MS).unref()
  }

  function finishFinal(flow) {
    if (flow.localFinAck && flow.remoteFin) retire(flow)
    if (!flow.localFinAck || !flow.final) return
    const callback = flow.final
    flow.final = null
    callback()
  }

  function acknowledge(flow, segment) {
    if (!between(segment.ack, flow.sendUna, flow.sendNext)) return
    if (before(flow.windowSeq, segment.seq) ||
        (flow.windowSeq === segment.seq && !before(segment.ack, flow.windowAck))) {
      flow.peerWindow = segment.window
      flow.windowSeq = segment.seq
      flow.windowAck = segment.ack
    }
    if (segment.ack === flow.sendUna) return
    flow.sendUna = segment.ack
    const f = flow.flight
    if (!f) return
    if (segment.ack === flow.sendNext) {
      clearFlight(flow)
      if (f.flags & FIN) flow.localFinAck = true
    } else {
      // The peer can ACK only a prefix (e.g. a short receive window).
      f.payload = f.payload.subarray((segment.ack - f.seq) >>> 0)
      f.seq = segment.ack
      f.retries = 0
    }
  }

  function establish(flow, segment) {
    clearFlight(flow)
    stopHandshake(flow)
    flow.state = 'open'
    flow.sendUna = segment.ack
    flow.recvNext = add(segment.seq, 1)
    flow.peerWindow = segment.window
    flow.windowSeq = segment.seq
    flow.windowAck = segment.ack
    flow.mss = Math.min(mss, remoteMss(segment.options))
    const stream = new Duplex({
      allowHalfOpen: true,
      readableHighWaterMark: RX_CAPACITY,
      writableHighWaterMark: 32 * 1024,
      read() {
        if (flow.notifyRead) return
        flow.notifyRead = true
        queueMicrotask(() => {
          flow.notifyRead = false
          if (flow.state !== 'open' || flow.remoteFin) return
          const available = window(flow)
          if (available > flow.lastWindow && (flow.lastWindow === 0 || available - flow.lastWindow >= flow.mss)) sendAck(flow)
        })
      },
      write(data, _encoding, callback) {
        if (flow.state !== 'open') return callback(errorWith('ENOTCONN', 'TCP connection is closed'))
        flow.writer = { data, offset: 0, callback }
        pump(flow)
      },
      final(callback) {
        if (flow.state !== 'open') return callback(errorWith('ENOTCONN', 'TCP connection is closed'))
        flow.final = callback
        pump(flow)
      },
      destroy(error, callback) {
        if (flow.state === 'open') {
          if (!(flow.localFinAck && flow.remoteFin)) emit(flow, flow.sendNext, RST | ACK)
          fail(flow, error ?? errorWith('ECONNRESET', 'TCP stream destroyed'))
        }
        callback(error)
      },
    })
    // The session can end between connect() resolving and caller listener attachment.
    stream.on('error', () => {})
    flow.stream = stream
    sendAck(flow)
    // A synchronous transport failure in sendAck may already have closed the stream.
    if (flow.state === 'open') flow.resolve(stream)
    else flow.reject(stream.errored ?? errorWith('ECONNRESET', 'TCP handshake could not complete'))
    flow.resolve = flow.reject = null
  }

  function receive(packet) {
    if (closed) return
    const p = decode(packet, local, mtu)
    if (!p) return
    const flow = flows.get(p.port) ?? waiting.get(p.port)
    if (!flow || p.remotePort !== flow.remotePort || !p.remote.equals(flow.remote)) return
    const length = p.payload.length + Number(Boolean(p.flags & FIN))
    if (flow.state === 'time-wait') {
      if ((p.flags & (FIN | RST)) === FIN && add(p.seq, length) === flow.recvNext) sendAck(flow)
      return
    }
    if (flow.state === 'syn') {
      if (!(p.flags & ACK) || p.ack !== flow.sendNext) return
      if (p.flags & RST) return fail(flow, errorWith('ECONNREFUSED', 'TCP connection refused'))
      if ((p.flags & (SYN | FIN)) === SYN && !p.payload.length) establish(flow, p)
      return
    }

    const next = flow.recvNext, available = window(flow)
    const inWindow = seq => !before(seq, next) && before(seq, add(next, available))
    const acceptable = available === 0 ? !length && p.seq === next
      : inWindow(p.seq) || (length > 0 && inWindow(add(p.seq, length - 1)))
    if (p.flags & RST) {
      if (p.seq === next) fail(flow, errorWith('ECONNRESET', 'TCP connection reset by peer'))
      else if (acceptable) sendAck(flow)
      return
    }
    if (!acceptable || (p.flags & SYN) || before(flow.sendNext, p.ack)) { sendAck(flow); return }
    if (!(p.flags & ACK)) return
    acknowledge(flow, p)

    if (length) {
      const offset = (next - p.seq) >>> 0
      // Do not queue gaps: the cumulative ACK directs the peer to retransmit them.
      if (!flow.remoteFin && offset <= p.payload.length) {
        const count = Math.min(available, p.payload.length - offset)
        flow.recvNext = add(next, count)
        const fin = Boolean(p.flags & FIN) && offset + count === p.payload.length && count < available
        if (fin) { flow.recvNext = add(flow.recvNext, 1); flow.remoteFin = true }
        if (count) flow.stream.push(Buffer.from(p.payload.subarray(offset, offset + count)))
        if (fin && flow.state === 'open') flow.stream.push(null)
      }
      sendAck(flow)
    }
    if (flow.state !== 'open') return
    finishFinal(flow)
    if (flow.state === 'open' && flow.flight?.probe && flow.peerWindow) {
      clearTimeout(flow.timer)
      flow.flight.probe = false
      sendFlight(flow)
    }
    // Avoid recursive sends if the injected transport delivers an ACK synchronously.
    queueMicrotask(() => pump(flow))
  }

  function connect(remoteAddress, remotePort, { signal, timeoutMs = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(errorWith('ENOTCONN', 'TCP stack is closed'))
      if (signal?.aborted) return reject(abortReason(signal))
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535 ||
          !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RangeError('Invalid TCP port or timeout')
      const remote = ipv4Bytes(remoteAddress)
      if (flows.size >= MAX_FLOWS) return reject(errorWith('ENOBUFS', 'TCP connection limit reached'))
      let port
      do {
        port = FIRST_PORT + portCursor
        portCursor = (portCursor + 1) % PORT_COUNT
      } while (flows.has(port) || waiting.has(port))
      const initial = randomInt(0x100000000)
      const flow = { state: 'syn', port, remote, remotePort, sendUna: initial, sendNext: initial,
        recvNext: 0, lastWindow: RX_CAPACITY, signal, resolve, reject, writer: null, final: null }
      flow.aborted = () => {
        if (flow.state === 'open') emit(flow, flow.sendNext, RST | ACK)
        fail(flow, abortReason(signal))
      }
      flows.set(port, flow)
      flow.deadline = setTimeout(() => fail(flow, errorWith('ETIMEDOUT', 'TCP connect timed out')), timeoutMs).unref()
      signal?.addEventListener('abort', flow.aborted, { once: true })
      fly(flow, SYN, empty, mssOption)
    })
  }

  function close(error = errorWith('ENOTCONN', 'TCP stack closed')) {
    if (closed) return
    closed = true
    for (const flow of flows.values()) fail(flow, error)
    for (const flow of waiting.values()) detach(flow)
  }

  return { receive, connect, close }
}

import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createTcpStack } from '../lib/node-iwan/tcp.js'

const CLIENT = '192.0.2.77'
const SERVER = '198.51.100.91'
const SERVICE = 443
const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16
const advance = (n, offset = 1) => (n + offset) >>> 0
const addr = s => Buffer.from(s.split('.').map(Number))

// Independent packet producer/verifier, deliberate use of hard-coded offsets and big-endian words.
function checksum(view) {
  let sum = 0
  for (let i = 0; i < view.length; i += 2) {
    sum += view[i] * 256 + (view[i + 1] ?? 0)
    if (sum >= 65536) sum -= 65535
  }
  return 65535 - sum
}

function pseudo(src, dst, tcp) {
  return Buffer.concat([addr(src), addr(dst), Buffer.from([0, 6, tcp.length >> 8, tcp.length & 255]), tcp])
}

function build({ src = SERVER, dst = CLIENT, from = SERVICE, to, seq, ack = 0, flags,
  data = Buffer.alloc(0), window = 30000, options = [] }) {
  const b = Buffer.alloc(40 + options.length + data.length)
  b[0] = 0x45
  b.writeUInt16BE(b.length, 2)
  b[8] = 54
  b[9] = 6
  addr(src).copy(b, 12)
  addr(dst).copy(b, 16)
  b.writeUInt16BE(checksum(b.subarray(0, 20)), 10)
  b.writeUInt16BE(from, 20)
  b.writeUInt16BE(to, 22)
  b.writeUInt32BE(seq, 24)
  b.writeUInt32BE(ack, 28)
  b[32] = (5 + options.length / 4) * 16
  b[33] = flags
  b.writeUInt16BE(window, 34)
  Buffer.from(options).copy(b, 40)
  Buffer.from(data).copy(b, 40 + options.length)
  b.writeUInt16BE(checksum(pseudo(src, dst, b.subarray(20))), 36)
  return b
}

function inspect(b) {
  assert.equal(b[0], 0x45)
  assert.equal(b.readUInt16BE(2), b.length)
  assert.equal(b[9], 6)
  assert.deepEqual(b.subarray(12, 16), addr(CLIENT))
  assert.deepEqual(b.subarray(16, 20), addr(SERVER))
  assert.equal(b.readUInt16BE(22), SERVICE)
  assert.equal(checksum(b.subarray(0, 20)), 0, 'valid IPv4 checksum')
  assert.equal(checksum(pseudo(CLIENT, SERVER, b.subarray(20))), 0, 'valid TCP checksum')
  const payloadAt = 20 + (b[32] >> 4) * 4
  return { port: b.readUInt16BE(20), seq: b.readUInt32BE(24), ack: b.readUInt32BE(28),
    flags: b[33], window: b.readUInt16BE(34), options: b.subarray(40, payloadAt), data: b.subarray(payloadAt) }
}

function fixture(t, mtu = 576) {
  const sent = [], waiters = []
  const stack = createTcpStack({ address: CLIENT, mtu, send(packet) {
    const result = inspect(packet)
    assert.ok(packet.length <= mtu)
    if (waiters.length) waiters.shift()(result)
    else sent.push(result)
  } })
  t.after(() => stack.close())
  const next = () => sent.length ? Promise.resolve(sent.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('missing client TCP packet')), 2000)
    waiters.push(value => { clearTimeout(timer); resolve(value) })
  })
  const packet = p => stack.receive(build(p))
  async function start(options = {}) {
    const opening = stack.connect(SERVER, SERVICE, options)
    opening.catch(() => {}) // Avoid stray rejections if an earlier fixture assertion fails.
    const syn = await next()
    assert.equal(syn.flags, SYN)
    assert.deepEqual(syn.options, Buffer.from([2, 4, (mtu - 40) >>> 8, (mtu - 40) & 255]))
    return { syn, opening, get accept() {
      return async ({ seq = 42, window = 30000, mss = 512 } = {}) => {
        packet({ to: syn.port, seq, ack: advance(syn.seq), flags: SYN | ACK, window,
          options: [2, 4, mss >> 8, mss & 255] })
        const ack = await next()
        assert.equal(ack.flags, ACK)
        assert.equal(ack.ack, advance(seq))
        return { stream: await opening, to: syn.port, seq: advance(seq), ack: advance(syn.seq) }
      }
    } }
  }
  return { stack, sent, next, packet, start }
}

test('independent fixture validates handshake, rejects bad packets, orders data across sequence wrap and half-closes', async t => {
  const f = fixture(t)
  const { syn, accept } = await f.start()
  const serverSyn = { to: syn.port, seq: 0xfffffffe, ack: advance(syn.seq), flags: SYN | ACK }
  const badIp = build(serverSyn); badIp[8] ^= 1
  const badTcp = build(serverSyn); badTcp[28] ^= 1
  f.stack.receive(badIp)
  f.stack.receive(badTcp)
  f.packet({ ...serverSyn, from: SERVICE + 1 })
  assert.equal(f.sent.length, 0)
  const { stream, to, seq, ack } = await accept({ seq: 0xfffffffe, mss: 256 })
  const read = []
  stream.on('data', b => read.push(b.toString()))
  f.packet({ to, seq: advance(seq, 3), ack, flags: ACK | PSH, data: Buffer.from('gap') })
  assert.equal((await f.next()).ack, seq)
  f.packet({ to, seq, ack, flags: ACK | PSH, data: Buffer.from('abc') })
  const afterAbc = advance(seq, 3)
  assert.equal((await f.next()).ack, afterAbc)
  const ended = once(stream, 'end')
  f.packet({ to, seq: advance(seq, 1), ack, flags: ACK | FIN, data: Buffer.from('bcdef') })
  const afterFin = advance(seq, 7)
  assert.equal((await f.next()).ack, afterFin)
  await ended
  assert.deepEqual(read, ['abc', 'def'])

  // Receiving FIN does not close the writable half. Check MSS and partial ACKs.
  let drained = false
  const wrote = new Promise((res, rej) => stream.write(Buffer.alloc(600, 0x61), err => {
    if (err) rej(err); else { drained = true; res() }
  }))
  const first = await f.next()
  assert.equal(first.seq, ack)
  assert.equal(first.data.length, 256)
  f.packet({ to, seq: afterFin, ack: advance(ack, 128), flags: ACK })
  assert.equal(f.sent.length, 0)
  assert.equal(drained, false)
  f.packet({ to, seq: afterFin, ack: advance(ack, 256), flags: ACK })
  assert.equal((await f.next()).data.length, 256)
  f.packet({ to, seq: afterFin, ack: advance(ack, 512), flags: ACK })
  assert.equal((await f.next()).data.length, 88)
  f.packet({ to, seq: afterFin, ack: advance(ack, 600), flags: ACK })
  await wrote
  const finish = once(stream, 'finish')
  stream.end()
  const localFin = await f.next()
  assert.equal(localFin.flags, FIN | ACK)
  f.packet({ to, seq: afterFin, ack: advance(localFin.seq), flags: ACK })
  await finish
  f.packet({ to, seq: advance(afterFin, -1), ack: advance(localFin.seq), flags: FIN | ACK })
  assert.equal((await f.next()).ack, afterFin)
})


test('lost SYN, data and FIN are retransmitted on the same sequence numbers', async t => {
  const f = fixture(t)
  const { syn, accept } = await f.start()
  const synRetry = await f.next()
  assert.deepEqual(synRetry, syn)
  const { stream, to, seq, ack } = await accept()

  const wrote = new Promise((res, rej) => stream.write('lost', err => err ? rej(err) : res()))
  const data = await f.next()
  assert.deepEqual(await f.next(), data)
  f.packet({ to, seq, ack: advance(ack, 4), flags: ACK })
  await wrote
  const finish = once(stream, 'finish')
  stream.end()
  const fin = await f.next()
  assert.deepEqual(await f.next(), fin)
  f.packet({ to, seq, ack: advance(fin.seq), flags: ACK })
  await finish
})

test('zero-window probe resumes with fair-sized segments and stops on abort', async t => {
  const f = fixture(t)
  const ctrl = new AbortController()
  const { accept } = await f.start({ signal: ctrl.signal })
  const { stream, to, seq, ack } = await accept({ window: 0 })
  const data = Buffer.alloc(32769, 0x63)
  let callbackError, writeCalled = false
  assert.equal(stream.write(data, error => { writeCalled = true; callbackError = error }), false)
  assert.equal(f.sent.length, 0)
  const probe = await f.next()
  assert.equal(probe.seq, ack)
  assert.equal(probe.data.length, 1)
  f.packet({ to, seq, ack, flags: ACK, window: 48 })
  assert.deepEqual(await f.next(), probe)
  f.packet({ to, seq, ack: advance(ack), flags: ACK, window: 48 })
  const next = await f.next()
  assert.equal(next.seq, advance(ack))
  assert.equal(next.data.length, 48)
  assert.equal(writeCalled, false)
  const expected = new Error('test cancellation')
  const failed = once(stream, 'error')
  ctrl.abort(expected)
  assert.equal((await f.next()).flags, RST | ACK)
  assert.strictEqual((await failed)[0], expected)
  assert.strictEqual(callbackError, expected)
  assert.equal(f.sent.length, 0)
})

test('refused, pending-aborted and stack-closed handshakes produce typed failures', async t => {
  const f = fixture(t)
  const refused = await f.start()
  f.packet({ to: refused.syn.port, seq: 0, ack: advance(refused.syn.seq), flags: RST | ACK })
  await assert.rejects(refused.opening, { code: 'ECONNREFUSED' })
  const ctrl = new AbortController()
  const pending = await f.start({ signal: ctrl.signal })
  ctrl.abort()
  await assert.rejects(pending.opening, { name: 'AbortError' })
  const closing = await f.start()
  f.stack.close()
  await assert.rejects(closing.opening, { code: 'ENOTCONN' })
  await assert.rejects(f.stack.connect(SERVER, SERVICE), { code: 'ENOTCONN' })
})


test('readable backlog advertises a bounded window and reopens it after application reads', async t => {
  const f = fixture(t)
  const { accept } = await f.start()
  const { stream, to, seq, ack } = await accept()
  const payload = Buffer.alloc(536, 0x72)
  let accepted = 0
  while (accepted < 65535) {
    const part = payload.subarray(0, Math.min(payload.length, 65535 - accepted))
    f.packet({ to, seq: advance(seq, accepted), ack, flags: ACK | PSH, data: part })
    accepted += part.length
    const reply = await f.next()
    assert.equal(reply.ack, advance(seq, accepted))
    assert.equal(reply.window, 65535 - accepted)
  }
  assert.equal(stream.readableLength, 65535)
  f.packet({ to, seq: advance(seq, accepted), ack, flags: ACK | PSH, data: Buffer.from('z') })
  assert.equal((await f.next()).window, 0)
  assert.deepEqual(stream.read(65535), Buffer.alloc(65535, 0x72))
  assert.equal((await f.next()).window, 65535)
  f.packet({ to, seq: advance(seq, accepted), ack, flags: ACK | PSH, data: Buffer.from('z') })
  assert.equal((await f.next()).ack, advance(seq, accepted + 1))
  assert.equal(stream.read(1).toString(), 'z')
})

test('stack caps simultaneous opens, and an unanswered open expires', async t => {
  const f = fixture(t)
  const requests = Array.from({ length: 128 }, () => f.stack.connect(SERVER, SERVICE, { timeoutMs: 10000 }))
  const outcomes = Promise.allSettled(requests)
  assert.equal(new Set(f.sent.map(p => p.port)).size, 128)
  await assert.rejects(f.stack.connect(SERVER, SERVICE), { code: 'ENOBUFS' })
  f.stack.close()
  assert.ok((await outcomes).every(r => r.status === 'rejected' && r.reason.code === 'ENOTCONN'))

  const timeoutFixture = fixture(t)
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(timeoutFixture.stack.connect(SERVER, SERVICE, { timeoutMs: 10 }), { code: 'ETIMEDOUT' })
  } finally {
    clearTimeout(keepAlive)
  }
})

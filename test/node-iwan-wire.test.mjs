import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import test from 'node:test'
import vm from 'node:vm'
import { createNodeIwanBackend } from '../lib/node-iwan/backend.js'

const source = await readFile(new URL('../lib/node-iwan/wire.js', import.meta.url), 'utf8')
const relay = Object.freeze({
  host: '192.0.2.10', username: 'fixture', domain: 'test.invalid', salt: 'salt-demo', mtu: 1280,
  passWord: 'ABEiM0RVZneImaq777+/0/g4JS7vA+MKdjrY6jBA4sYF2BqOqXvcUZfHS35SU7OU0RU=',
})
const sessionId = Buffer.from('123487654321', 'hex')
const nonce = Buffer.from('12345678', 'hex')
const sessionKey = Buffer.from('441ebcf35d2da0ebaa03d62945f30fca', 'hex')
const flush = () => new Promise(resolve => setImmediate(resolve))

function clock() {
  let time = 0, seq = 0
  const tasks = new Map()
  return {
    tasks, now: () => time,
    set(fn, ms) { tasks.set(++seq, { at: time + ms, fn }); return seq },
    clear(id) { tasks.delete(id) },
    tick(ms) {
      const end = time + ms
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, task] = next
        tasks.delete(id)
        time = task.at
        task.fn()
      }
      time = end
    },
  }
}

async function fakeTransport({ holdSends = false, stallConnect = false, holdClose = false } = {}) {
  const timers = clock()
  const logs = []
  const sockets = []
  const context = vm.createContext({
    Buffer, Uint8Array, queueMicrotask,
    Date: { now: () => 1_700_000_000_000 + timers.now() },
    performance: { now: timers.now }, setTimeout: timers.set, clearTimeout: timers.clear,
  })
  const builtin = exports => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  }, { context })
  const mod = new vm.SourceTextModule(source, { context })
  const imports = {
    'node:buffer': builtin({ isUtf8 }),
    'node:crypto': builtin({ ...crypto, randomBytes: count => Buffer.from(nonce.subarray(0, count)) }),
    'node:net': builtin({ isIPv4 }),
    'node:dgram': builtin({ createSocket(type) {
      const sock = new EventEmitter()
      sock.type = type
      sock.frames = []
      sock.waiting = []
      sock.connect = (port, host) => {
        sock.endpoint = { port, host }
        if (!stallConnect) queueMicrotask(() => { if (!sock.closed) sock.emit('connect') })
      }
      sock.send = (frame, callback) => {
        assert.equal(sock.closed, undefined)
        sock.frames.push(Buffer.from(frame))
        if (holdSends) sock.waiting.push(callback)
        else queueMicrotask(() => callback(null))
      }
      sock.close = () => {
        assert.equal(sock.closed, undefined)
        sock.closed = true
        if (!holdClose) queueMicrotask(() => sock.emit('close'))
      }
      sock.peer = frame => sock.emit('message', frame)
      sockets.push(sock)
      return sock
    } }),
  }
  await mod.link(name => imports[name])
  await mod.evaluate()
  return {
    sockets, timers, logs,
    open: options => mod.namespace.openIwanTunnel({ relay, log: line => logs.push(line), ...options }),
  }
}

const attribute = (id, values) => Buffer.from([id, values.length + 2, ...values])

function control(type, attrs = [], id = sessionId, mode = 1) {
  const head = Buffer.concat([Buffer.from([type, mode]), id])
  const sig = crypto.createHash('md5').update(head).update('mw').digest()
  return Buffer.concat([head, sig, ...attrs])
}

function ack(mode = 1, extra = []) {
  return control(0x12, [attribute(4, [10, 9, 8, 7]), attribute(5, [10, 2, 3, 4]),
    attribute(3, [5, 0]), attribute(8, [mode]), ...extra], sessionId, mode)
}

const ipPacket = () => Buffer.from('4500001900000000401100000a090807c63364010102030405', 'hex')

function encoded(packet, mode) {
  if (mode === 1) return Buffer.from(packet.map((byte, i) => byte ^ sessionKey[i % 8]))
  if (mode === 2) {
    const padded = Buffer.alloc(32)
    packet.copy(padded)
    const aes = crypto.createCipheriv('aes-128-ecb', sessionKey, null).setAutoPadding(false)
    return Buffer.concat([aes.update(padded), aes.final()])
  }
  return packet
}

async function openFixture(mode = 1, extra = [], options = {}, transportOptions) {
  const fixture = await fakeTransport(transportOptions)
  const opening = fixture.open(options)
  await flush()
  const sock = fixture.sockets[0]
  sock.peer(ack(mode, extra))
  return { ...fixture, sock, tunnel: await opening }
}

test('uses golden controller credential and exact UDP OPEN bytes; only a valid incomplete ACK falls back', async () => {
  const f = await fakeTransport()
  const opening = f.open()
  await flush()
  const sock = f.sockets[0]
  assert.equal(sock.type, 'udp4')
  assert.deepEqual(sock.endpoint, { host: relay.host, port: 6001 })
  const attrs = [attribute(3, [5, 0]), attribute(1, Buffer.from(relay.username)),
    attribute(2, Buffer.from('81eb02f0697fa96dff714956be99c63e', 'hex')), attribute(8, [1])]
  const expected = control(0x13, [...attrs, attribute(15, nonce)], Buffer.alloc(6))
  assert.deepEqual(sock.frames, [expected])
  const badSig = control(0x12)
  badSig[8] ^= 1
  sock.peer(badSig)
  sock.peer(control(0x12, [attribute(15, [0, 0, 0, 0])]))
  sock.peer(control(0x12, [Buffer.from([99, 1])]))
  assert.equal(sock.frames.length, 1)
  sock.peer(control(0x12, [attribute(15, nonce)]))
  assert.deepEqual(sock.frames[1], control(0x13, attrs, Buffer.alloc(6)))
  sock.peer(ack())
  const tunnel = await opening
  assert.equal(tunnel.ip, '10.9.8.7')
  assert.equal(tunnel.mtu, 1280)
  assert.equal(tunnel.dns, '10.2.3.4')
  assert.equal(f.logs.length, 1)
  assert.equal(f.logs.join(' ').includes(relay.username), false)
  await tunnel.close()
  assert.equal(f.timers.tasks.size, 0)
})

for (const mode of [0, 1, 2]) {
  test('sends and receives correctly bounded IPv4 packets in mode ' + mode, async () => {
    const { tunnel, sock } = await openFixture(mode, [attribute(15, nonce)])
    const type = mode ? 0x18 : 0x14
    const orig = ipPacket(), copy = Buffer.from(orig)
    const received = []
    const off = tunnel.onPacket(packet => received.push(packet))
    assert.equal(tunnel.send(orig), true)
    assert.deepEqual(orig, copy)
    const payload = encoded(copy, mode)
    const wire = Buffer.concat([Buffer.from([type, mode]), sessionId, payload])
    assert.deepEqual(sock.frames.at(-1), wire)
    const altered = Buffer.from(wire)
    altered[7] ^= 1
    sock.peer(altered)
    sock.peer(wire.subarray(0, 9))
    if (mode === 2) sock.peer(wire.subarray(0, -1))
    sock.peer(wire)
    assert.deepEqual(received, [copy])
    off()
    sock.peer(wire)
    assert.deepEqual(received, [copy])
    assert.equal(tunnel.send(Buffer.from([1])), false)
    assert.equal(tunnel.send(Buffer.alloc(tunnel.mtu + 1)), false)
    await tunnel.close()
    assert.equal(tunnel.send(orig), false)
  })
}

for (const mode of [0, 1]) {
  test('trims real-gateway Ethernet padding but rejects truncated IPv4 in mode ' + mode, async () => {
    const { tunnel, sock } = await openFixture(mode)
    const received = []
    tunnel.onPacket(packet => received.push(packet))
    const header = Buffer.concat([Buffer.from([mode ? 0x18 : 0x14, mode]), sessionId])
    const ip = Buffer.alloc(44)
    ip[0] = 0x45; ip.writeUInt16BE(ip.length, 2); ip[9] = 6
    const withTail = Buffer.concat([ip, Buffer.from([0x00, 0xff])])
    sock.peer(Buffer.concat([header, encoded(ip.subarray(0, 43), mode)]))
    sock.peer(Buffer.concat([header, encoded(Buffer.concat([ip, Buffer.alloc(tunnel.mtu - ip.length + 1)]), mode)]))
    assert.deepEqual(received, [])
    sock.peer(Buffer.concat([header, encoded(withTail, mode)]))
    assert.deepEqual(received, [ip])
    await tunnel.close()
  })
}

test('receives out-of-order IPv4 fragments only when complete and not expired', async () => {
  const { tunnel, sock, timers } = await openFixture(0)
  const received = []
  tunnel.onPacket(packet => received.push(packet))
  const orig = ipPacket()
  const frag = (id, offset, bytes, final) => {
    const attrs = Buffer.alloc(8)
    attrs.writeUInt32LE(id)
    attrs.writeUInt32LE((bytes.length << 15) | (offset << 2) | Number(final), 4)
    return Buffer.concat([Buffer.from([0x22, 0]), sessionId, attrs, bytes])
  }
  const first = frag(1, 0, orig.subarray(0, 13), false)
  const last = frag(1, 13, orig.subarray(13), true)
  sock.peer(last)
  sock.peer(last)
  assert.deepEqual(received, [])
  sock.peer(first)
  assert.deepEqual(received, [orig])
  sock.peer(first)
  timers.tick(5000)
  sock.peer(last)
  assert.deepEqual(received, [orig])
  await tunnel.close()
})

test('uses the negotiated duplication flag and caps queued sends', async () => {
  const { tunnel, sock, timers } = await openFixture(1, [attribute(9, [1])], {}, { holdSends: true })
  assert.equal(tunnel.send(ipPacket()), true)
  assert.deepEqual(sock.frames.slice(-2).map(frame => frame[0]), [0x18, 0x20])
  let accepted = 1
  while (tunnel.send(ipPacket()) && ++accepted < 200) {}
  assert.ok(accepted < 200)
  assert.ok(sock.waiting.length <= 128)
  const stop = tunnel.close()
  assert.equal(tunnel.close(), stop)
  assert.deepEqual(sock.frames.at(-1), control(0x17))
  timers.tick(150)
  await stop
  assert.equal(sock.closed, true)
  assert.equal(timers.tasks.size, 0)
})

test('handles signed ECHO frames, enforces keepalive deadlines and replays closure reason', async () => {
  const { tunnel, sock, timers } = await openFixture()
  const initial = sock.frames.at(-1)
  assert.equal(initial.length, 60)
  assert.equal(initial.readBigUInt64LE(24), 1_700_000_000_000_000n)
  assert.deepEqual(initial, control(0x15, [initial.subarray(24)]))
  const payload = Buffer.from([0, 1, 2])
  sock.peer(control(0x15, [payload]))
  assert.deepEqual(sock.frames.at(-1), control(0x16, [payload]))
  const reasons = []
  tunnel.onClose(error => reasons.push(error.code))
  timers.tick(20_000)
  sock.peer(control(0x16))
  timers.tick(20_000)
  assert.deepEqual(reasons, [])
  sock.peer(control(0x16, [], Buffer.alloc(6)))
  timers.tick(10_000)
  await tunnel.close()
  assert.deepEqual(reasons, ['IWAN_IDLE_TIMEOUT'])
  let disposedCalled = false
  const dispose = tunnel.onClose(() => { disposedCalled = true })
  dispose()
  tunnel.onClose(error => reasons.push(error.code))
  await flush()
  assert.equal(disposedCalled, false)
  assert.deepEqual(reasons, ['IWAN_IDLE_TIMEOUT', 'IWAN_IDLE_TIMEOUT'])
  assert.equal(timers.tasks.size, 0)
})

test('rejects invalid credentials without creating sockets or disclosing raw values', async () => {
  const f = await fakeTransport()
  const invalid = { ...relay, passWord: 'X' + relay.passWord.slice(1) }
  await assert.rejects(f.open({ relay: invalid }), error => error.code === 'IWAN_BAD_CREDENTIAL' && !error.message.includes(invalid.passWord))
  await assert.rejects(f.open({ relay: { ...relay, host: 'example.test' } }), { code: 'IWAN_BAD_RELAY' })
  const controller = new AbortController()
  controller.abort(new Error('do not disclose'))
  await assert.rejects(f.open({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.sockets.length, 0)
  assert.deepEqual(f.logs, [])
})

test('caps OPEN retries and does not downgrade after silence or rejection', async () => {
  const f = await fakeTransport()
  const opening = f.open({ timeoutMs: 1000 })
  const timedOut = assert.rejects(opening, { name: 'TimeoutError' })
  await flush()
  f.timers.tick(1000)
  await timedOut
  const sock = f.sockets[0]
  assert.equal(sock.frames.length, 4)
  assert.ok(sock.frames.every(frame => frame.equals(sock.frames[0])))
  assert.equal(sock.closed, true)
  assert.equal(f.timers.tasks.size, 0)

  const rejected = f.open()
  const failed = assert.rejects(rejected, error => error.code === 'IWAN_OPEN_REJECTED' && !error.message.includes('private upstream text'))
  await flush()
  const sock2 = f.sockets[1]
  sock2.peer(control(0x11, [Buffer.from('private upstream text')], Buffer.alloc(6), 0))
  await failed
  assert.equal(sock2.frames.length, 1)
  assert.deepEqual(f.logs, [])
})

test('rejects unsupported negotiated modes and trusts only matching signed peer CLOSE', async () => {
  const f = await fakeTransport()
  const opening = f.open()
  const rejected = assert.rejects(opening, { code: 'IWAN_BAD_ACK' })
  await flush()
  f.sockets[0].peer(ack(3))
  await rejected
  assert.equal(f.sockets[0].closed, true)

  const { tunnel, sock, timers } = await openFixture()
  const causes = []
  tunnel.onClose(error => causes.push(error?.code))
  const damaged = control(0x17)
  damaged[12] ^= 1
  sock.peer(damaged)
  sock.peer(control(0x17, [], Buffer.alloc(6)))
  assert.deepEqual(causes, [])
  sock.peer(control(0x17))
  await tunnel.close()
  assert.deepEqual(causes, ['IWAN_PEER_CLOSED'])
  assert.equal(sock.frames.some(frame => frame[0] === 0x17), false)
  assert.equal(timers.tasks.size, 0)
})

test('backend handshake cancellation waits for the UDP close event after requesting close', async () => {
  const f = await fakeTransport({ holdClose: true })
  const start = createNodeIwanBackend({ readRelay: () => relay, openTunnel: f.open })
  const controller = new AbortController()
  let settled = false
  const starting = start({ signal: controller.signal }).finally(() => { settled = true })
  const rejected = assert.rejects(starting, { name: 'AbortError' })
  await flush()
  const sock = f.sockets[0]
  assert.equal(sock.frames[0][0], 0x13)
  controller.abort()
  await flush()
  assert.equal(sock.closed, true)
  assert.equal(settled, false)
  sock.emit('close')
  await rejected
  assert.equal(f.timers.tasks.size, 0)
})

test('aborts before UDP connect and closes established sessions exactly once', async () => {
  const f = await fakeTransport({ stallConnect: true })
  const abort = new AbortController()
  const pending = assert.rejects(f.open({ signal: abort.signal }), { name: 'AbortError' })
  abort.abort()
  await pending
  await flush()
  assert.equal(f.sockets[0].closed, true)
  assert.equal(f.sockets[0].frames.length, 0)
  assert.equal(f.timers.tasks.size, 0)

  const active = new AbortController()
  const { tunnel, sock, timers } = await openFixture(1, [], { signal: active.signal })
  const reasons = []
  tunnel.onClose(error => reasons.push(error.name))
  active.abort()
  await tunnel.close()
  assert.deepEqual(reasons, ['AbortError'])
  assert.equal(sock.frames.filter(frame => frame[0] === 0x17).length, 1)
  assert.equal(sock.listenerCount('message'), 0)
  assert.equal(timers.tasks.size, 0)
})

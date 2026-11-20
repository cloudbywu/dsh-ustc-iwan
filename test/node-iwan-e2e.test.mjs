import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import { once } from 'node:events'
import test from 'node:test'
import { createNodeIwanBackend } from '../lib/node-iwan/backend.js'
import { socksConnect } from '../lib/socks.js'

const localHost = '127.0.0.1'
const clientIp = Buffer.from([10, 9, 8, 7])
const targetIp = Buffer.from([198, 51, 100, 42])
const dnsIp = Buffer.from([192, 0, 2, 53])
const dnsPort = 5353
const scope = Buffer.from('3c4d11223344', 'hex')
const cipherKey = Buffer.from('441ebcf35d2da0eb', 'hex')
const expectedAuth = Buffer.from('81eb02f0697fa96dff714956be99c63e', 'hex')
// Fixed synthetic fixture, independent of the plugin's password helpers.
const syntheticCredential = 'ABEiM0RVZneImaq777+/0/g4JS7vA+MKdjrY6jBA4sYF2BqOqXvcUZfHS35SU7OU0RU='
const names = { served: 'fixture.vpn.test', pending: 'pending.vpn.test' }
const services = new Map([[9443, 'literal request'], [9444, 'domain request']])

const digest = bytes => createHash('md5').update(bytes).update('mw').digest()
const attr = (tag, payload) => Buffer.from([tag, payload.length + 2, ...payload])
const addressText = buffer => buffer.join('.')
const advance = (seq, size = 1) => (seq + size) >>> 0
const cipher = bytes => Buffer.from(bytes.map((value, i) => value ^ cipherKey[i % cipherKey.length]))

function control(type, payload, id = scope) {
  const head = Buffer.from([type, 1, ...id])
  return Buffer.concat([head, digest(head), payload])
}

function mixChecksum(bytes) {
  let total = 0
  for (let i = 0; i < bytes.length; i += 2) total += 256 * bytes[i] + (bytes[i + 1] ?? 0)
  for (; total >>> 16; ) total = (total & 0xffff) + (total >>> 16)
  return 0xffff - total
}

function transportChecksum(src, dst, protocol, segment) {
  return mixChecksum(Buffer.concat([src, dst, Buffer.from([0, protocol, segment.length >>> 8, segment.length & 255]), segment]))
}

function ipFrame(from, to, protocol, segment) {
  const ip = Buffer.alloc(20)
  ip[0] = 0x45
  ip[8] = 61
  ip[9] = protocol
  ip.writeUInt16BE(20 + segment.length, 2)
  ip.set(from, 12)
  ip.set(to, 16)
  ip.writeUInt16BE(mixChecksum(ip), 10)
  return Buffer.concat([ip, segment])
}

function tcpReply({ from, to, sequence, acknowledged, flags, sourceIp = targetIp, data = Buffer.alloc(0) }) {
  const header = flags === 0x12 ? 24 : 20
  const transport = Buffer.alloc(header + data.length)
  transport.writeUInt16BE(from, 0)
  transport.writeUInt16BE(to, 2)
  transport.writeUInt32BE(sequence, 4)
  transport.writeUInt32BE(acknowledged, 8)
  transport[12] = (header / 4) << 4
  transport[13] = flags
  transport.writeUInt16BE(32000, 14)
  if (header === 24) transport.set([2, 4, 5, 76], 20)
  transport.set(data, header)
  transport.writeUInt16BE(transportChecksum(sourceIp, clientIp, 6, transport), 16)
  return ipFrame(sourceIp, clientIp, 6, transport)
}

function dnsQuestion(packet) {
  assert.ok(packet.length >= 17)
  assert.equal(packet.readUInt16BE(2), 0x0100)
  assert.equal(packet.readUInt16BE(4), 1)
  const labels = []
  let at = 12
  while (packet[at]) {
    const size = packet[at++]
    assert.ok(size <= 63 && at + size < packet.length)
    labels.push(packet.toString('ascii', at, at + size))
    at += size
  }
  assert.deepEqual(packet.subarray(at), Buffer.from([0, 0, 1, 0, 1]))
  return labels.join('.')
}

function dnsAnswer(question, truncated = false) {
  const message = Buffer.from(question)
  message.writeUInt16BE(truncated ? 0x8380 : 0x8180, 2)
  message.writeUInt16BE(1, 6)
  if (truncated) return message
  // One A/IN answer with owner compressed to the query name at offset 12.
  return Buffer.concat([message, Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, ...targetIp])])
}

function dnsReply(port, question, truncated) {
  const udp = Buffer.concat([Buffer.alloc(8), dnsAnswer(question, truncated)])
  udp.writeUInt16BE(dnsPort, 0)
  udp.writeUInt16BE(port, 2)
  udp.writeUInt16BE(udp.length, 4)
  udp.writeUInt16BE(transportChecksum(dnsIp, clientIp, 17, udp) || 0xffff, 6)
  return ipFrame(dnsIp, clientIp, 17, udp)
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

async function bindUdp(port = 0) {
  const socket = dgram.createSocket('udp4')
  const ready = once(socket, 'listening')
  try {
    socket.bind({ address: localHost, port })
    await ready
    return socket
  } catch (error) {
    try { socket.close() } catch {}
    throw error
  }
}

function closeUdp(socket) {
  return new Promise(resolve => socket.close(resolve))
}

async function fixture(t, truncateDns) {
  const udp = await bindUdp()
  t.after(() => closeUdp(udp))
  const fail = deferred(), pendingDns = deferred(), closed = deferred()
  const flowByPort = new Map()
  const trace = []
  let client, dnsRequest, closeCount = 0, opened = false
  const toClient = bytes => udp.send(bytes, client.port, localHost, error => { if (error) fail.reject(error) })
  const sendIp = ip => toClient(Buffer.concat([Buffer.from([0x18, 1]), scope, cipher(ip)]))
  udp.on('error', fail.reject)
  udp.on('message', (frame, peer) => {
    try { receive(frame, peer) } catch (error) { fail.reject(error) }
  })

  function receive(frame, peer) {
    assert.equal(peer.address, localHost)
    assert.ok(frame.length >= 8)
    assert.equal(frame[1], 1)
    if (frame[0] === 0x13) {
      assert.deepEqual(frame.subarray(2, 8), Buffer.alloc(6))
      assert.deepEqual(frame.subarray(8, 24), digest(frame.subarray(0, 8)))
      const attrs = new Map()
      for (let at = 24; at < frame.length;) {
        const size = frame[at + 1]
        assert.ok(size >= 2 && at + size <= frame.length)
        assert.equal(attrs.has(frame[at]), false)
        attrs.set(frame[at], frame.subarray(at + 2, at + size))
        at += size
      }
      assert.deepEqual([...attrs.keys()], [3, 1, 2, 8, 15])
      assert.deepEqual(attrs.get(3), Buffer.from([5, 0]))
      assert.equal(attrs.get(1).toString(), 'fixture')
      assert.deepEqual(attrs.get(2), expectedAuth)
      assert.deepEqual(attrs.get(8), Buffer.from([1]))
      assert.equal(attrs.get(15).length, 4)
      client = peer
      opened = true
      trace.push('auth')
      toClient(control(0x12, Buffer.concat([
        attr(4, clientIp), attr(5, Buffer.from([192, 0, 2, 54])), attr(3, [5, 0]), attr(8, [1]), attr(15, attrs.get(15)),
      ])))
      return
    }
    assert.ok(opened)
    assert.equal(peer.port, client.port)
    assert.deepEqual(frame.subarray(2, 8), scope)
    if (frame[0] === 0x15 || frame[0] === 0x17) {
      assert.deepEqual(frame.subarray(8, 24), digest(frame.subarray(0, 8)))
      if (frame[0] === 0x17) {
        assert.equal(frame.length, 24)
        closeCount++
        closed.resolve(client)
      } else {
        assert.equal(frame.length, 60)
        trace.push('echo')
        toClient(control(0x16, frame.subarray(24)))
      }
      return
    }
    assert.equal(frame[0], 0x18)
    const ip = cipher(frame.subarray(8))
    assert.equal(ip[0], 0x45)
    assert.equal(ip.readUInt16BE(2), ip.length)
    assert.equal(mixChecksum(ip.subarray(0, 20)), 0)
    assert.deepEqual(ip.subarray(12, 16), clientIp)
    const dst = ip.subarray(16, 20)
    const transport = ip.subarray(20)
    if (ip[9] === 17) {
      assert.deepEqual(dst, dnsIp)
      assert.equal(transport.readUInt16BE(2), dnsPort)
      assert.equal(transport.readUInt16BE(4), transport.length)
      assert.equal(transportChecksum(clientIp, dst, 17, transport), 0)
      const name = dnsQuestion(transport.subarray(8))
      trace.push('dns:' + name)
      if (name === names.pending) { pendingDns.resolve(); return }
      assert.equal(name, names.served)
      dnsRequest = transport.subarray(8)
      sendIp(dnsReply(transport.readUInt16BE(0), dnsRequest, truncateDns))
      return
    }
    assert.equal(ip[9], 6)
    const to = transport.readUInt16BE(0), from = transport.readUInt16BE(2)
    const isDns = from === dnsPort
    assert.deepEqual(dst, isDns ? dnsIp : targetIp)
    assert.equal(transportChecksum(clientIp, dst, 6, transport), 0)
    const flags = transport[13], sequence = transport.readUInt32BE(4), ack = transport.readUInt32BE(8)
    const data = transport.subarray((transport[12] >>> 4) * 4)
    if (flags & 4) { flowByPort.delete(to); return }
    assert.ok(isDns ? truncateDns && dnsRequest : services.has(from))
    let flow = flowByPort.get(to)
    if (flags === 2) {
      if (!flow) {
        flow = { start: 0x40608000 + flowByPort.size * 1024, clientNext: advance(sequence), serverNext: null }
        flow.serverNext = advance(flow.start)
        flowByPort.set(to, flow)
        trace.push('syn:' + from)
      }
      // The school gateway emits 46 bytes for this 44-byte IPv4 SYN-ACK.
      const synAck = tcpReply({ from, to, sourceIp: dst, sequence: flow.start, acknowledged: flow.clientNext, flags: 0x12 })
      assert.equal(synAck.length, 44)
      sendIp(Buffer.concat([synAck, Buffer.alloc(2)]))
      return
    }
    assert.ok(flow)
    assert.ok(flags & 0x10)
    assert.equal(ack, flow.serverNext)
    if (!data.length) return
    assert.equal(sequence, flow.clientNext)
    let reply
    if (isDns) {
      assert.equal(data.readUInt16BE(0), data.length - 2)
      assert.deepEqual(data.subarray(2), dnsRequest)
      const answer = dnsAnswer(dnsRequest), prefix = Buffer.alloc(2)
      prefix.writeUInt16BE(answer.length)
      reply = Buffer.concat([prefix, answer])
    } else {
      assert.equal(data.toString(), services.get(from))
      reply = Buffer.from('reply: ' + data)
    }
    trace.push('data:' + from)
    flow.clientNext = advance(sequence, data.length)
    const serverSequence = flow.serverNext
    flow.serverNext = advance(serverSequence, reply.length)
    sendIp(tcpReply({ from, to, sourceIp: dst, sequence: serverSequence, acknowledged: flow.clientNext, flags: 0x18, data: reply }))
  }

  return {
    port: udp.address().port, pendingDns: pendingDns.promise, closed: closed.promise, trace,
    closeCount: () => closeCount,
    wait: promise => Promise.race([promise, fail.promise]),
  }
}

function exchange(socket, message) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    const expected = 'reply: ' + message
    function finish(error) {
      clearTimeout(timer)
      socket.off('data', data)
      socket.off('error', finish)
      socket.off('close', early)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks).toString())
    }
    const early = () => finish(new Error('SOCKS socket closed before synthetic response'))
    const timer = setTimeout(() => finish(new Error('synthetic response timed out')), 3000)
    const data = chunk => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= Buffer.byteLength(expected)) finish()
    }
    socket.on('data', data)
    socket.once('error', finish)
    socket.once('close', early)
    socket.resume()
    socket.write(message)
  })
}

test('aborting before the relay answers releases the real UDP source port', { timeout:3000 }, async t => {
  const udp = await bindUdp()
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await closeUdp(udp) })
  const start = createNodeIwanBackend({ readRelay: () => ({ host: localHost, port: udp.address().port,
    domain: 'test.invalid', username: 'fixture', passWord: syntheticCredential, salt: 'salt-demo', mtu: 1280 }) })
  const received = once(udp, 'message', { signal: controller.signal })
  const aborted = assert.rejects(start({ signal: controller.signal }), { name:'AbortError' })
  const [frame, peer] = await received
  assert.equal(frame[0], 0x13)
  controller.abort()
  await aborted
  const rebound = await bindUdp(peer.port)
  await closeUdp(rebound)
})

for (const truncateDns of [false, true]) test('Node iWAN tunnels SOCKS with ' + (truncateDns ? 'DNS TCP fallback' : 'UDP DNS') + ' and releases resources on abort', { timeout: 10_000 }, async t => {
  const relay = await fixture(t, truncateDns)
  const controller = new AbortController()
  let chosen, reads = 0, backend
  t.after(async () => {
    controller.abort()
    await backend?.stop()
  })
  const ensureNodeIwan = createNodeIwanBackend({ readRelay({ server }) {
    chosen = server
    reads++
    return { host: localHost, port: relay.port, domain: 'test.invalid', username: 'fixture',
      passWord: syntheticCredential, salt: 'salt-demo', mtu: 1280 }
  } })
  const startup = ensureNodeIwan({ server: 'synthetic', socksHost: localHost, socksPort: 0,
    dns: addressText(dnsIp) + ':' + dnsPort, signal: controller.signal, timeoutMs: 3000 })
  startup.then(value => { backend = value }, () => {})
  backend = await relay.wait(startup)
  assert.equal(chosen, 'synthetic')
  assert.equal(reads, 1)
  assert.equal(backend.backend, 'node')
  assert.equal(backend.managed, true)
  assert.equal(backend.socksHost, localHost)
  assert.ok(backend.socksPort > 0)
  assert.equal(backend.isAlive(), true)
  assert.equal(backend.isAuthenticated(), true)
  assert.ok(backend.authenticatedAt > 0)
  const connect = (targetHost, targetPort) => socksConnect({ targetHost, targetPort,
    proxyHost: backend.socksHost, proxyPort: backend.socksPort, timeoutMs: 4000 })
  const socketClosures = []
  for (const [target, port] of [[addressText(targetIp), 9443], [names.served, 9444]]) {
    const socket = await relay.wait(connect(target, port))
    t.after(() => { socket.destroy() })
    socket.on('error', () => {})
    socketClosures.push(new Promise(resolve => socket.once('close', resolve)))
    const message = services.get(port)
    assert.equal(await relay.wait(exchange(socket, message)), 'reply: ' + message)
  }
  assert.ok(relay.trace.includes('echo'))
  assert.deepEqual(relay.trace.filter(item => /^(syn|data|dns):/.test(item)), [
    'syn:9443', 'data:9443', 'dns:' + names.served,
    ...(truncateDns ? ['syn:' + dnsPort, 'data:' + dnsPort] : []),
    'syn:9444', 'data:9444',
  ])

  const pending = connect(names.pending, 9555)
  const refusedPending = assert.rejects(pending, error => error.phase === 'reply' && error.code !== 'SOCKS_TIMEOUT')
  refusedPending.catch(() => {})
  await relay.wait(relay.pendingDns)
  const exit = deferred()
  backend.onExit(exit.resolve)
  controller.abort()
  const [, peer, exited] = await relay.wait(Promise.all([backend.stop(), relay.closed, exit.promise,
    refusedPending, ...socketClosures]))
  assert.equal(exited.stopped, true)
  assert.equal(exited.error, null)
  assert.equal(backend.isAlive(), false)
  assert.equal(backend.hasExited(), true)
  assert.equal(backend.isAuthenticated(), false)
  assert.equal(relay.closeCount(), 1)
  await assert.rejects(connect(names.served, 9444), { code: 'ECONNREFUSED' })
  // The real connected UDP socket released its ephemeral source port as well.
  const rebound = await bindUdp(peer.port)
  await closeUdp(rebound)
})

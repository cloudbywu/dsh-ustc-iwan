import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { socksConnect, SocksConnectError } from '../lib/socks.js'

async function listen(t, handler) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    handler(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)) })
  return server.address().port
}
const reply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
const tick = () => new Promise(r => setTimeout(r, 2))
async function fragments(socket, pieces) {
  for (const piece of pieces) { if (!socket.destroyed) socket.write(piece); await tick() }
}
async function payload(socket, length) {
  let data = Buffer.alloc(0)
  const promise = new Promise((resolve, reject) => {
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); if (data.length >= length) resolve(data) })
    socket.once('error', reject)
    socket.once('end', () => { if (data.length < length) reject(new Error('short payload')) })
  })
  socket.resume()
  return promise
}

test('SOCKS fragmented greeting/reply at every byte boundary retains coalesced payload', { timeout: 8000 }, async t => {
  for (let split = 1; split < reply.length; split++) {
    await t.test(`boundary ${split}`, async t => {
      const port = await listen(t, socket => socket.once('data', greeting => {
        assert.deepEqual(greeting, Buffer.from([5, 1, 0]))
        socket.once('data', request => {
          assert.equal(request[3], 3)
          assert.equal(request.subarray(5, -2).toString(), 'example.test')
          void fragments(socket, [reply.subarray(0, split), Buffer.concat([reply.subarray(split), Buffer.from('business')])])
        })
        void fragments(socket, [Buffer.from([5]), Buffer.from([0])])
      }))
      const socket = await socksConnect({ proxyPort: port, targetHost: 'example.test', targetPort: 80 })
      t.after(() => socket.destroy())
      assert.equal(socket.isPaused(), true)
      assert.equal(socket.listenerCount('data'), 0)
      assert.equal(socket.listeners('end').some(fn => fn.name === 'onEnd'), false)
      assert.equal((await payload(socket, 8)).toString(), 'business')
    })
  }
})

test('SOCKS IPv4, IPv6, mapped IPv6 and Unicode targets are encoded correctly', { timeout: 4000 }, async t => {
  for (const [host, atyp, expected] of [
    ['127.0.0.1', 1, '7f000001'], ['::1', 4, '00000000000000000000000000000001'],
    ['::ffff:127.0.0.1', 4, '00000000000000000000ffff7f000001'], ['例子.test', 3, null],
  ]) {
    let actual
    const port = await listen(t, socket => socket.once('data', () => {
      socket.once('data', request => { actual = request; socket.write(reply) })
      socket.write(Buffer.from([5, 0]))
    }))
    const socket = await socksConnect({ proxyPort: port, targetHost: host, targetPort: 65535 })
    socket.destroy()
    assert.equal(actual[3], atyp)
    assert.equal(actual.readUInt16BE(actual.length - 2), 65535)
    if (expected) assert.equal(actual.subarray(4, -2).toString('hex'), expected)
    else assert.equal(actual.subarray(5, -2).toString(), 'xn--fsqu00a.test')
  }
})

test('SOCKS accepts domain/IPv6 reply fragmentation and rejects malformed replies', { timeout: 4000 }, async t => {
  const responses = [Buffer.from([5, 0, 0, 3, 1, 97, 0, 80]), Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(18)])]
  for (const response of responses) {
    const port = await listen(t, socket => socket.once('data', () => {
      socket.once('data', () => { void fragments(socket, [...response].map(byte => Buffer.from([byte]))) })
      socket.write(Buffer.from([5, 0]))
    }))
    const socket = await socksConnect({ proxyPort: port, targetHost: 'localhost', targetPort: 80 })
    socket.destroy()
  }
  for (const response of [Buffer.from([4, 0, 0, 1]), Buffer.from([5, 1, 0, 1]), Buffer.from([5, 0, 1, 1]), Buffer.from([5, 0, 0, 9]), Buffer.from([5, 0, 0, 3, 0])]) {
    const port = await listen(t, socket => socket.once('data', () => {
      socket.once('data', () => socket.write(response))
      socket.write(Buffer.from([5, 0]))
    }))
    await assert.rejects(socksConnect({ proxyPort: port, targetHost: 'localhost', targetPort: 80 }), /SOCKS5/)
  }
})

test('SOCKS EOF, reset, timeout, cancellation and validation settle without leaking sockets', { timeout: 4000 }, async t => {
  for (const mode of ['eof', 'reset', 'partial', 'timeout', 'abort']) {
    let peer
    const port = await listen(t, socket => {
      peer = socket
      socket.once('data', () => {
        if (mode === 'eof') socket.end()
        if (mode === 'reset') socket.destroy()
        if (mode === 'partial') socket.end(Buffer.from([5]))
      })
    })
    const controller = new AbortController()
    const pending = socksConnect({ proxyPort: port, targetHost: 'localhost', targetPort: 80, timeoutMs: 60, signal: controller.signal })
    if (mode === 'abort') controller.abort(new Error('cancelled'))
    await assert.rejects(pending)
    if (peer && !peer.destroyed) await once(peer, 'close')
  }
  for (const options of [{ targetHost: 'x', targetPort: 0 }, { targetHost: 'x'.repeat(256), targetPort: 80 }, { targetHost: '', targetPort: 80 }]) await assert.rejects(socksConnect(options))
})

test('SOCKS establishment errors expose phase/retryable and preserve transport codes', { timeout: 4000 }, async t => {
  const reserve = net.createServer()
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const refused = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  await assert.rejects(socksConnect({ proxyPort: refused, targetHost: 'localhost', targetPort: 80 }), error => {
    assert.ok(error instanceof SocksConnectError); assert.equal(error.phase, 'connect')
    assert.equal(error.retryable, true); assert.equal(error.code, 'ECONNREFUSED'); return true
  })
  for (const mode of ['eof', 'partial', 'reset', 'timeout', 'abort', 'reply-eof']) {
    let ready
    const received = new Promise(resolve => { ready = resolve })
    const port = await listen(t, socket => socket.once('data', () => {
      ready()
      if (mode === 'eof') socket.end()
      if (mode === 'partial') socket.end(Buffer.from([5]))
      if (mode === 'reset') socket.resetAndDestroy()
      if (mode === 'reply-eof') {
        socket.once('data', () => socket.end(Buffer.from([5, 0, 0, 1])))
        socket.write(Buffer.from([5, 0]))
      }
    }))
    const controller = new AbortController()
    const pending = socksConnect({ proxyPort: port, targetHost: 'localhost', targetPort: 80, timeoutMs: 100, signal: controller.signal })
    const checked = assert.rejects(pending, error => {
      assert.ok(error instanceof SocksConnectError)
      assert.equal(error.phase, mode === 'abort' ? 'abort' : mode === 'reply-eof' ? 'reply' : 'greeting')
      assert.equal(error.retryable, !['timeout', 'abort'].includes(mode))
      if (mode === 'reset') assert.equal(error.code, 'ECONNRESET')
      return true
    })
    await received
    if (mode === 'abort') controller.abort(new Error('cancelled'))
    await checked
  }
  await assert.rejects(socksConnect({ targetHost: '', targetPort: 80 }), error => {
    assert.equal(error.phase, 'validation'); assert.equal(error.retryable, false); return true
  })
})

test('known invalid SOCKS prefixes are terminal even without EOF or complete frames', { timeout: 4000 }, async t => {
  for (const [phase, response] of [
    ['greeting', [4]], ['greeting', [5, 255]],
    ['reply', [4]], ['reply', [5, 2]], ['reply', [5, 0, 1]],
    ['reply', [5, 0, 0, 9]], ['reply', [5, 0, 0, 3, 0]],
  ]) {
    const port = await listen(t, socket => socket.once('data', () => {
      if (phase === 'greeting') return socket.write(Buffer.from(response))
      socket.once('data', () => socket.write(Buffer.from(response)))
      socket.write(Buffer.from([5, 0]))
    }))
    await assert.rejects(socksConnect({ proxyPort: port, targetHost: 'localhost', targetPort: 80, timeoutMs: 300 }), error => {
      assert.equal(error.phase, phase); assert.equal(error.retryable, false)
      assert.doesNotMatch(error.message, /超时/); return true
    })
  }
})

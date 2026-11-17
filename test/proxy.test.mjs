import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule } from 'node:vm'
import { generateKeyPairSync, sign } from 'node:crypto'
import { startSplitProxy } from '../lib/split-proxy.js'
import { socksConnect } from '../lib/socks.js'

async function listen(t, server) {
  const peers = new Set()
  server.on('connection', socket => {
    peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(r => server.close(r)) })
  return { port: server.address().port, peers }
}
async function proxy(t, options = {}, start = startSplitProxy) {
  const p = await start({ port: 0, decide: async () => ({ kind: 'direct' }), ...options })
  t.after(() => p.close())
  return { ...p, port: p.server.address().port }
}
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent: false, ...options }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk }); res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.once('error', reject); req.end(options.body)
  })
}
async function raw(t, port, wire, done = data => data.includes('\r\n\r\n')) {
  const socket = net.connect({ host: '127.0.0.1', port })
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  let data = ''
  const result = new Promise((resolve, reject) => {
    socket.on('data', chunk => { data += chunk; if (done(data)) resolve({ socket, data }) })
    socket.once('error', reject)
    socket.once('end', () => resolve({ socket, data }))
  })
  await once(socket, 'connect')
  socket.write(wire)
  return result
}
const tick = () => new Promise(r => setTimeout(r, 3))

test('HTTP uses selected SOCKS socket, origin-form path and no leaked proxy auth', { timeout: 4000 }, async t => {
  let connects = 0, seen
  const origin = http.createServer((req, res) => {
    seen = { path: req.url, headers: req.headers }
    req.resume(); res.end('selected route')
  })
  const destination = await listen(t, origin)
  const socks = net.createServer(socket => socket.once('data', () => {
    socket.once('data', request => {
      connects++
      assert.equal(request.subarray(5, -2).toString(), 'must-not-resolve.invalid')
      const remote = net.connect({ host: '127.0.0.1', port: destination.port }, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
        socket.pipe(remote); remote.pipe(socket)
      })
      socket.once('close', () => remote.destroy()); remote.on('error', () => socket.destroy())
    })
    socket.write(Buffer.from([5, 0]))
  }))
  const s = await listen(t, socks)
  const p = await proxy(t, { decide: () => ({ kind: 'iwan' }), iwan: { proxyHost: '127.0.0.1', proxyPort: s.port } })
  for (let i = 0; i < 2; i++) {
    const response = await request(p.port, 'http://must-not-resolve.invalid/path?q=1#fragment', { headers: { 'proxy-authorization': 'Basic secret', 'proxy-connection': 'keep-alive' } })
    assert.equal(response.status, 200); assert.equal(response.body, 'selected route')
  }
  assert.equal(connects, 2)
  assert.equal(seen.path, '/path?q=1')
  assert.equal(seen.headers['proxy-authorization'], undefined)
  assert.equal(seen.headers['proxy-connection'], undefined)
  await p.close()
  await Promise.all([...s.peers].map(peer => once(peer, 'close')))
  assert.equal(s.peers.size, 0)
})

test('HTTP direct origin-form, POST body and iWAN fallback', { timeout: 4000 }, async t => {
  const origin = await listen(t, http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => res.end(`${req.url}|${body}`))
  }))
  const dead = await listen(t, net.createServer(socket => socket.destroy()))
  const p = await proxy(t, { socksRetryWindowMs: 50, decide: () => ({ kind: 'iwan' }), iwan: { proxyPort: dead.port } })
  const response = await request(p.port, '/local?query=yes', { method: 'POST', headers: { host: `127.0.0.1:${origin.port}` }, body: 'posted' })
  assert.equal(response.status, 200); assert.equal(response.body, '/local?query=yes|posted')
  for (const path of ['https://127.0.0.1/', 'ftp://127.0.0.1/', 'not-a-url']) assert.equal((await request(p.port, path)).status, 400)
  const silent = await listen(t, net.createServer(socket => socket.resume()))
  const fallback = await proxy(t, { timeoutMs: 50, decide: () => ({ kind: 'iwan' }), iwan: { proxyPort: silent.port } })
  assert.equal((await request(fallback.port, `http://127.0.0.1:${origin.port}/after-timeout`)).body, '/after-timeout|')
})

test('HTTP upstream auth, IPv6 CONNECT, fragmented headers and coalesced business bytes', { timeout: 4000 }, async t => {
  let connectWire = ''
  const upstream = await listen(t, net.createServer(socket => {
    socket.once('data', data => {
      connectWire = data.toString()
      void (async () => {
        for (const piece of ['H', 'TTP/1.', '1 200 OK\r\nX-Test: yes\r', '\n\r\npayload']) { socket.write(piece); await tick() }
      })()
      socket.on('data', chunk => socket.write(chunk))
    })
  }))
  const p = await proxy(t, { decide: () => ({ kind: 'upstream', url: `http://user:p%40ss@127.0.0.1:${upstream.port}` }) })
  const result = await raw(t, p.port, 'CONNECT [::1]:8443 HTTP/1.1\r\nHost: [::1]:8443\r\n\r\nHEAD', data => data.includes('payload') && data.includes('HEAD'))
  assert.ok(result.data.startsWith('HTTP/1.1 200 Connection Established'))
  assert.ok(connectWire.startsWith('CONNECT [::1]:8443 HTTP/1.1\r\nHost: [::1]:8443\r\n'))
  assert.ok(connectWire.includes(`Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}\r\n`))
  const close = once(result.socket, 'close')
  await p.close(); await close
  assert.equal(result.socket.destroyed, true)
})

test('HTTP upstream tunnel forwards origin-form and strips client proxy credentials', { timeout: 4000 }, async t => {
  let forwarded = ''
  const upstream = await listen(t, net.createServer(socket => socket.once('data', connect => {
    assert.ok(connect.toString().startsWith('CONNECT no-dns.invalid:80 HTTP/1.1'))
    socket.once('data', request => {
      forwarded = request.toString()
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    })
    socket.write('HTTP/1.1 200 OK\r\n\r\n')
  })))
  const p = await proxy(t, { decide: () => ({ kind: 'upstream', url: `http://127.0.0.1:${upstream.port}` }) })
  const response = await request(p.port, 'http://no-dns.invalid/a?b=c', { headers: { 'proxy-authorization': 'must not forward' } })
  assert.equal(response.body, 'ok')
  assert.ok(forwarded.startsWith('GET /a?b=c HTTP/1.1\r\n'))
  assert.equal(forwarded.toLowerCase().includes('proxy-authorization'), false)
})

test('upstream EOF/reset, invalid status, oversized headers, unsupported URL and timeout produce 502', { timeout: 6000 }, async t => {
  for (const mode of ['eof', 'reset', 'partial', 'reject', 'invalid', 'large', 'timeout', 'trickle']) {
    const upstream = await listen(t, net.createServer(socket => socket.once('data', () => {
      if (mode === 'eof') socket.end()
      if (mode === 'reset') socket.destroy()
      if (mode === 'partial') socket.end('HTTP/1.')
      if (mode === 'reject') socket.write('HTTP/1.1 407 Auth Required\r\n\r\n')
      if (mode === 'invalid') socket.write('garbage\r\n\r\n')
      if (mode === 'large') socket.write('HTTP/1.1 200 OK\r\nX: ' + 'x'.repeat(300))
      if (mode === 'trickle') {
        const timer = setInterval(() => socket.write('x'), 10)
        socket.once('close', () => clearInterval(timer))
      }
    })))
    const p = await proxy(t, { timeoutMs: 80, maxHeaderBytes: 256, decide: () => ({ kind: 'upstream', url: `http://127.0.0.1:${upstream.port}` }) })
    const response = await request(p.port, 'http://no-dns.invalid/')
    assert.equal(response.status, 502, mode)
    await p.close()
    await Promise.all([...upstream.peers].map(peer => once(peer, 'close')))
    assert.equal(upstream.peers.size, 0, mode)
  }
  const p = await proxy(t, { decide: () => ({ kind: 'upstream', url: 'socks5://127.0.0.1' }) })
  assert.equal((await request(p.port, 'http://no-dns.invalid/')).status, 502)
})

test('proxy close aborts pending upstream and SOCKS handshakes and is idempotent', { timeout: 4000 }, async t => {
  for (const kind of ['upstream', 'iwan']) {
    let peer, accepted
    const received = new Promise(r => { accepted = r })
    const upstream = await listen(t, net.createServer(socket => { peer = socket; socket.once('data', accepted) }))
    const p = await proxy(t, { decide: () => ({ kind, url: `http://127.0.0.1:${upstream.port}` }), iwan: { proxyPort: upstream.port } })
    const client = net.connect({ host: '127.0.0.1', port: p.port })
    t.after(() => client.destroy()); client.on('error', () => {}); client.resume()
    await once(client, 'connect')
    client.write('CONNECT no-dns.invalid:443 HTTP/1.1\r\nHost: no-dns.invalid\r\n\r\n')
    await received
    const clientClosed = once(client, 'close'), peerClosed = once(peer, 'close')
    const first = p.close()
    assert.equal(p.close(), first)
    await first; await clientClosed; await peerClosed
    assert.equal(peer.destroyed, true)
    assert.equal(upstream.peers.size, 0)
  }
})

test('close during delayed routing prevents later outbound connections; stalled routing times out', { timeout: 4000 }, async t => {
  let release, entered
  const ready = new Promise(r => { entered = r })
  const routing = new Promise(r => { release = r })
  let connections = 0
  const upstream = await listen(t, net.createServer(() => { connections++ }))
  const p = await proxy(t, { decide: () => { entered(); return routing } })
  const client = net.connect({ host: '127.0.0.1', port: p.port }); t.after(() => client.destroy())
  client.on('error', () => {}); client.resume()
  await once(client, 'connect'); client.write('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid\r\n\r\n')
  await ready
  const closed = once(client, 'close')
  await p.close(); await closed
  release({ kind: 'upstream', url: `http://127.0.0.1:${upstream.port}` })
  await tick()
  assert.equal(connections, 0)
  const stalled = await proxy(t, { timeoutMs: 50, decide: () => new Promise(() => {}) })
  assert.equal((await request(stalled.port, 'http://no-dns.invalid/')).status, 502)
})

test('client disconnect aborts pending handshake; close destroys in-flight HTTP sockets', { timeout: 5000 }, async t => {
  let peer, entered
  const received = new Promise(r => { entered = r })
  const upstream = await listen(t, net.createServer(socket => { peer = socket; socket.once('data', entered) }))
  const p = await proxy(t, { decide: () => ({ kind: 'upstream', url: `http://127.0.0.1:${upstream.port}` }) })
  const client = net.connect({ host: '127.0.0.1', port: p.port })
  client.on('error', () => {}); t.after(() => client.destroy())
  await once(client, 'connect')
  client.write('GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n')
  await received
  const peerClosed = once(peer, 'close')
  client.destroy(); await peerClosed
  await p.close()
  let started
  const began = new Promise(r => { started = r })
  const origin = await listen(t, http.createServer(req => { req.resume(); started() }))
  const direct = await proxy(t)
  const requestPromise = request(direct.port, `http://127.0.0.1:${origin.port}/`).then(() => null, err => err)
  await began
  const closed = Promise.all([...origin.peers].map(socket => once(socket, 'close')))
  await direct.close(); await closed
  assert.ok(await requestPromise instanceof Error)
})

test('CONNECT validates authority and connection refusal returns 502', { timeout: 4000 }, async t => {
  const p = await proxy(t)
  for (const target of ['[not-ipv6]:443', 'host:0', 'host:65536', '::1:443', 'user@host:443', 'host:abc']) {
    const result = await raw(t, p.port, `CONNECT ${target} HTTP/1.1\r\nHost: local\r\n\r\n`)
    assert.ok(result.data.startsWith('HTTP/1.1 400'), target)
    result.socket.destroy()
  }
  const reserve = net.createServer()
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(r => reserve.close(r))
  const result = await raw(t, p.port, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: local\r\n\r\n`)
  assert.ok(result.data.startsWith('HTTP/1.1 502'))
})

function certificate() {
  const der = (tag, data) => {
    const length = data.length < 128 ? Buffer.from([data.length]) : Buffer.from([0x82, data.length >> 8, data.length & 255])
    return Buffer.concat([Buffer.from([tag]), length, data])
  }
  const seq = (...parts) => der(0x30, Buffer.concat(parts))
  const integer = n => der(2, Buffer.from([n]))
  const oid = hex => der(6, Buffer.from(hex, 'hex'))
  const alg = seq(oid('2a864886f70d01010b'), der(5, Buffer.alloc(0)))
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('localhost')))))
  const validity = seq(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('400101000000Z')))
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const tbs = seq(der(0xa0, integer(2)), integer(1), alg, name, validity, name, publicKey.export({ type: 'spki', format: 'der' }))
  const signed = seq(tbs, alg, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  const cert = '-----BEGIN CERTIFICATE-----\n' + signed.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert }
}

async function loadWithTLS(connect) {
  const source = await readFile(new URL('../lib/split-proxy.js', import.meta.url), 'utf8')
  const module = new SourceTextModule(source)
  await module.link(specifier => {
    if (specifier === './socks.js') return new SyntheticModule(['socksConnect'], function () { this.setExport('socksConnect', socksConnect) })
    const value = { 'node:http': http, 'node:net': net, 'node:tls': { ...tls, connect } }[specifier]
    if (!value) throw new Error(`Unexpected import ${specifier}`)
    return new SyntheticModule(['default'], function () { this.setExport('default', value) })
  })
  await module.evaluate()
  return module.namespace.startSplitProxy
}

test('HTTPS upstream uses real TLS, default 443, SNI, certificate validation and authentication', { timeout: 6000 }, async t => {
  const credentials = certificate()
  let connectWire, clientSocket, receivedOptions
  const upstream = await listen(t, tls.createServer(credentials, socket => socket.once('data', data => {
    connectWire = data.toString()
    socket.write('HTTP/1.1 200 OK\r\n\r\nsecure-payload')
  })))
  const start = await loadWithTLS(options => {
    receivedOptions = options
    clientSocket = tls.connect({ ...options, host: '127.0.0.1', port: upstream.port, ca: credentials.cert })
    return clientSocket
  })
  const p = await proxy(t, { decide: () => ({ kind: 'upstream', url: 'https://u:p@localhost' }) }, start)
  const response = await raw(t, p.port, 'CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid\r\n\r\n', data => data.includes('secure-payload'))
  assert.equal(receivedOptions.port, 443)
  assert.equal(receivedOptions.servername, 'localhost')
  assert.equal(clientSocket.authorized, true)
  assert.ok(connectWire.includes('Proxy-Authorization: Basic dTpw\r\n'))
  assert.ok(response.data.includes('secure-payload'))
  const untrusted = await proxy(t, { decide: () => ({ kind: 'upstream', url: `https://127.0.0.1:${upstream.port}` }) })
  assert.equal((await request(untrusted.port, 'http://example.invalid/')).status, 502)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { startSplitProxy } from '../lib/split-proxy.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function listen(t, server, port = 0) {
  const peers = new Set()
  server.on('connection', socket => {
    peers.add(socket); socket.on('error', () => {})
    socket.once('close', () => peers.delete(socket))
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => {
    for (const peer of peers) peer.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { port: server.address().port, peers, server }
}
async function unusedPort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve)); return port
}
async function proxy(t, options) {
  const p = await startSplitProxy({ port: 0, decide: () => ({ kind: 'iwan' }), ...options })
  t.after(() => p.close()); return { ...p, port: p.server.address().port }
}
function request(port, path, body = 'billable-post') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false }, res => {
      let text = ''; res.on('data', b => { text += b })
      res.once('error', reject); res.once('end', () => resolve({ status: res.statusCode, text }))
    })
    req.once('error', reject); req.end(body)
  })
}
async function raw(t, port, wire, done = text => text.includes('\r\n\r\n')) {
  const socket = net.connect({ host: '127.0.0.1', port })
  t.after(() => socket.destroy()); socket.on('error', () => {})
  let data = ''
  const result = new Promise((resolve, reject) => {
    socket.on('data', b => { data += b; if (done(data)) resolve({ socket, data }) })
    socket.once('error', reject); socket.once('end', () => resolve({ socket, data }))
  })
  await once(socket, 'connect'); socket.write(wire)
  return result
}
function relay(destinationPort, counters, firstFailure) {
  return net.createServer(socket => {
    const attempt = ++counters.accepted
    socket.once('data', () => {
      if (attempt === 1 && firstFailure === 'eof') return socket.end(Buffer.from([5]))
      if (attempt === 1 && firstFailure === 'reset') return socket.resetAndDestroy()
      socket.once('data', () => {
        counters.connects++
        const remote = net.connect({ host: '127.0.0.1', port: destinationPort }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
          socket.pipe(remote); remote.pipe(socket)
        })
        socket.once('close', () => remote.destroy()); remote.on('error', () => socket.destroy())
      })
      socket.write(Buffer.from([5, 0]))
    })
  })
}
function recover(t, port, server, recoveryMs = 120) {
  let timer
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  // Attach immediately: a bind failure must not become an unhandled rejection.
  ready.catch(() => {})
  t.after(() => clearTimeout(timer))
  return { ready, start() {
    timer ??= setTimeout(() => { listen(t, server, port).then(readyResolve, readyReject) }, recoveryMs)
    return { kind: 'iwan' }
  } }
}

test('first POST survives refused SOCKS recovering after 120ms; business bytes sent once', { timeout: 4000 }, async t => {
  let directPosts = 0, selectedPosts = 0, body = ''
  const direct = await listen(t, http.createServer((req, res) => { directPosts++; req.resume(); res.end('wrong route') }))
  const target = await listen(t, http.createServer((req, res) => {
    selectedPosts++; req.on('data', b => { body += b }); req.once('end', () => res.end(body))
  }))
  const counters = { accepted: 0, connects: 0 }, logs = []
  const port = await unusedPort(), recovery = recover(t, port, relay(target.port, counters))
  const p = await proxy(t, { iwan: { proxyPort: port }, decide: recovery.start, log: line => logs.push(line) })
  const result = await request(p.port, `http://127.0.0.1:${direct.port}/model`)
  await recovery.ready
  assert.equal(result.status, 200); assert.equal(result.text, 'billable-post')
  assert.equal(directPosts, 0); assert.equal(selectedPosts, 1); assert.equal(body, 'billable-post')
  assert.equal(counters.connects, 1); assert.equal(counters.accepted, 1)
  assert.equal(logs.some(x => x.includes('回退直连')), false)
})

test('CONNECT waits for SOCKS recovery before 200 and forwards head once; post-200 close never redials', { timeout: 4000 }, async t => {
  let business = '', directConnections = 0
  const direct = await listen(t, net.createServer(() => { directConnections++ }))
  const target = await listen(t, net.createServer(socket => socket.on('data', b => { business += b; socket.end('seen') })))
  const counters = { accepted: 0, connects: 0 }, logs = []
  const port = await unusedPort(), recovery = recover(t, port, relay(target.port, counters))
  const p = await proxy(t, { iwan: { proxyPort: port }, decide: recovery.start, log: line => logs.push(line) })
  let headersArrived = false
  const response = raw(t, p.port, `CONNECT 127.0.0.1:${direct.port} HTTP/1.1\r\nHost: local\r\n\r\nHEAD`).then(result => { headersArrived = true; return result })
  await sleep(60)
  assert.equal(headersArrived, false, 'CONNECT 200 must wait for successful SOCKS establishment')
  const result = await response
  await recovery.ready
  if (!result.data.includes('seen') && !result.socket.destroyed) await once(result.socket, 'data')
  assert.equal(result.data.split('200 Connection Established').length - 1, 1)
  assert.ok(result.data.startsWith('HTTP/1.1 200 Connection Established'))
  assert.equal(business, 'HEAD'); assert.equal(directConnections, 0); assert.equal(counters.connects, 1)
  if (!result.socket.destroyed) await once(result.socket, 'close')
  await sleep(150)
  assert.equal(counters.accepted, 1); assert.equal(logs.some(x => x.includes('回退直连')), false)
})

test('early EOF and reset recover during establishment without replaying POST', { timeout: 4000 }, async t => {
  for (const mode of ['eof', 'reset']) {
    let posts = 0
    const target = await listen(t, http.createServer((req, res) => { posts++; req.resume(); res.end('ok') }))
    const counters = { accepted: 0, connects: 0 }
    const socks = await listen(t, relay(target.port, counters, mode))
    const p = await proxy(t, { iwan: { proxyPort: socks.port } })
    assert.equal((await request(p.port, `http://127.0.0.1:${target.port}/`)).status, 200)
    assert.equal(posts, 1); assert.equal(counters.accepted, 2); assert.equal(counters.connects, 1)
  }
})

test('auth rejection, invalid prefix and nonzero REP are not retried; single direct fallback retained', { timeout: 4000 }, async t => {
  for (const [stage, response] of [['greeting', [4]], ['greeting', [5, 255]], ['reply', [5, 0, 0, 9]], ['reply', [5, 2]]]) {
    let accepted = 0, posts = 0
    const target = await listen(t, http.createServer((req, res) => { posts++; req.resume(); res.end('direct') }))
    const socks = await listen(t, net.createServer(socket => {
      accepted++; socket.once('data', () => {
        if (stage === 'greeting') return socket.end(Buffer.from(response))
        socket.once('data', () => socket.end(Buffer.from(response))); socket.write(Buffer.from([5, 0]))
      })
    }))
    const p = await proxy(t, { iwan: { proxyPort: socks.port } })
    assert.equal((await request(p.port, `http://127.0.0.1:${target.port}/`)).text, 'direct')
    assert.equal(accepted, 1); assert.equal(posts, 1)
  }
})

test('received POST reset is never replayed or sent to direct fallback', { timeout: 4000 }, async t => {
  let posts = 0, body = '', connections = 0
  const origin = http.createServer(req => {
    posts++; req.on('data', b => { body += b }); req.once('end', () => req.socket.resetAndDestroy())
  })
  origin.on('connection', () => { connections++ })
  const target = await listen(t, origin), counters = { accepted: 0, connects: 0 }, logs = []
  const socks = await listen(t, relay(target.port, counters))
  const p = await proxy(t, { iwan: { proxyPort: socks.port }, log: line => logs.push(line) })
  assert.equal((await request(p.port, `http://127.0.0.1:${target.port}/`)).status, 502)
  await sleep(150)
  assert.equal(posts, 1); assert.equal(body, 'billable-post'); assert.equal(connections, 1)
  assert.equal(counters.accepted, 1); assert.equal(logs.some(x => x.includes('回退直连')), false)
})

test('route, stalled SOCKS and fallback share deadline; handshake timeout is not retried', { timeout: 4000 }, async t => {
  let accepted = 0, posts = 0
  const target = await listen(t, http.createServer((req, res) => { posts++; req.resume(); res.end('direct') }))
  const socks = await listen(t, net.createServer(socket => { accepted++; socket.resume() }))
  const p = await proxy(t, { timeoutMs: 450, iwan: { proxyPort: socks.port }, decide: async () => {
    await sleep(180); return { kind: 'iwan' }
  } })
  const start = performance.now()
  assert.equal((await request(p.port, `http://127.0.0.1:${target.port}/`)).text, 'direct')
  const elapsed = performance.now() - start
  assert.ok(elapsed < 600, `deadline reset: ${elapsed}ms`); assert.equal(accepted, 1); assert.equal(posts, 1)
})

test('short configured local window bounds attempts and falls back only once', { timeout: 4000 }, async t => {
  let accepted = 0, posts = 0
  const target = await listen(t, http.createServer((req, res) => { posts++; req.resume(); res.end('direct') }))
  const socks = await listen(t, net.createServer(socket => { accepted++; socket.once('data', () => socket.end()) }))
  const p = await proxy(t, { timeoutMs: 3000, socksRetryWindowMs: 500, iwan: { proxyPort: socks.port } })
  const start = performance.now()
  assert.equal((await request(p.port, `http://127.0.0.1:${target.port}/`)).text, 'direct')
  assert.equal(accepted, 3); assert.equal(posts, 1); assert.ok(performance.now() - start < 1000)
})

test('client disconnect and proxy close cancel backoff without later retries/fallback', { timeout: 4000 }, async t => {
  for (const mode of ['client', 'proxy']) {
    let accepted = 0, directConnections = 0, retrying
    const retry = new Promise(resolve => { retrying = resolve })
    const target = await listen(t, net.createServer(() => { directConnections++ }))
    const socks = await listen(t, net.createServer(socket => { accepted++; socket.once('data', () => socket.end()) }))
    const p = await proxy(t, { verbose: true, iwan: { proxyPort: socks.port }, log: line => { if (line.includes('后重试')) retrying() } })
    const client = net.connect({ host: '127.0.0.1', port: p.port })
    t.after(() => client.destroy()); client.on('error', () => {}); client.resume()
    await once(client, 'connect'); client.write(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: local\r\n\r\n`)
    await retry
    if (mode === 'client') { const closed = once(client, 'close'); client.destroy(); await closed }
    else { const first = p.close(); assert.equal(p.close(), first); await first }
    await sleep(350)
    assert.equal(accepted, 1); assert.equal(directConnections, 0); assert.equal(socks.peers.size, 0)
  }
})

test('zero retry window preserves a single SOCKS attempt and direct fallback', { timeout: 2000 }, async t => {
  let accepted = 0, posts = 0
  const target = await listen(t, http.createServer((req, res) => { posts++; req.resume(); res.end('direct') }))
  const socks = await listen(t, net.createServer(socket => { accepted++; socket.once('data', () => socket.end()) }))
  const p = await proxy(t, { socksRetryWindowMs: 0, iwan: { proxyPort: socks.port } })
  assert.equal((await request(p.port, `http://127.0.0.1:${target.port}/`)).text, 'direct')
  assert.equal(accepted, 1); assert.equal(posts, 1)
})

test('deadline includes routing and destroys a trickling upstream handshake', { timeout: 2500 }, async t => {
  let accepted = 0
  const upstream = await listen(t, net.createServer(socket => {
    accepted++; socket.once('data', () => {
      const timer = setInterval(() => socket.write('H'), 10)
      socket.once('close', () => clearInterval(timer))
    })
  }))
  const p = await proxy(t, { timeoutMs: 300, decide: async () => {
    await sleep(160); return { kind: 'upstream', url: `http://127.0.0.1:${upstream.port}` }
  } })
  const start = performance.now()
  assert.equal((await request(p.port, 'http://no-dns.invalid/')).status, 502)
  assert.ok(performance.now() - start < 420)
  await p.close()
  await Promise.all([...upstream.peers].map(peer => once(peer, 'close')))
  assert.equal(upstream.peers.size, 0); assert.equal(accepted, 1)
})

test('default local window covers a 2100ms native recovery without direct POST', { timeout: 5000 }, async t => {
  let directPosts = 0, selectedPosts = 0
  const direct = await listen(t, http.createServer((req, res) => { directPosts++; req.resume(); res.end('wrong') }))
  const target = await listen(t, http.createServer((req, res) => { selectedPosts++; req.resume(); res.end('recovered') }))
  const counters = { accepted: 0, connects: 0 }, logs = []
  const port = await unusedPort(), recovery = recover(t, port, relay(target.port, counters), 2100)
  const p = await proxy(t, { iwan: { proxyPort: port }, decide: recovery.start, log: line => logs.push(line) })
  const started = performance.now()
  assert.equal((await request(p.port, `http://127.0.0.1:${direct.port}/model`)).text, 'recovered')
  await recovery.ready
  assert.ok(performance.now() - started >= 2100)
  assert.equal(selectedPosts, 1); assert.equal(directPosts, 0); assert.equal(counters.connects, 1)
  assert.equal(logs.some(line => line.includes('回退直连')), false)
})

test('local recovery window rejects values beyond the hard maximum', () => {
  for (const socksRetryWindowMs of [-1, 3001, Infinity, NaN]) {
    assert.throws(() => startSplitProxy({ port: 0, socksRetryWindowMs }), RangeError)
  }
})

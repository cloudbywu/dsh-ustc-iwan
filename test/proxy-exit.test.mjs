import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { on, once } from 'node:events'
import net from 'node:net'

const childSource = `
  const { startSplitProxy } = await import(process.argv[1]);
  const [mode, port] = process.argv.slice(2);
  // Keep IPC referenced until the parent has observed the state under test.
  process.on('message', () => {});
  const upstream = mode === 'upstream' || mode === 'tls';
  const proxy = await startSplitProxy({
    port: 0, timeoutMs: 30000,
    decide: () => upstream
      ? { kind: 'upstream', url: (mode === 'tls' ? 'https' : 'http') + '://127.0.0.1:' + port }
      : { kind: mode === 'socks' ? 'iwan' : 'direct' },
    iwan: { proxyHost: '127.0.0.1', proxyPort: Number(port) },
  });
  process.send(proxy.server.address().port);
`

async function peerServer(t) {
  const peers = new Set()
  const server = net.createServer(socket => {
    peers.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => peers.delete(socket))
  })
  t.after(async () => {
    const closed = once(server, 'close', { signal: AbortSignal.timeout(2000) })
    server.close()
    for (const peer of peers) peer.destroy()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening', { signal: t.signal })
  const connected = once(server, 'connection', { signal: t.signal })
  void connected.catch(() => {})
  return { port: server.address().port, connected }
}

function startChild(t, source, args, ipc = false) {
  const stdio = ['ignore', 'ignore', 'pipe']
  if (ipc) stdio.push('ipc')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, ...args], { stdio })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(2000) })
      child.kill()
      await exited
    }
  })
  return { child, stderr: () => stderr }
}

async function readUntil(socket, expected, signal) {
  let data = ''
  for await (const [chunk] of on(socket, 'data', { signal, close: ['close'] })) {
    data += chunk.toString('latin1')
    if (data.includes(expected)) return data
  }
  assert.fail('Socket closed before receiving ' + JSON.stringify(expected) + ': ' + JSON.stringify(data))
}

for (const [mode, label] of [
  ['idle', 'only its loopback listener'],
  ['direct', 'an established CONNECT tunnel'],
  ['forward', 'an in-flight HTTP response'],
  ['upstream', 'a pending upstream HTTP CONNECT handshake'],
  ['tls', 'a pending upstream TLS handshake'],
  ['socks', 'a pending SOCKS handshake'],
]) {
  test('split proxy allows natural exit with ' + label, { timeout: 8000 }, async t => {
    const origin = mode === 'idle' ? null : await peerServer(t)
    const { child, stderr } = startChild(t, childSource, [
      new URL('../lib/split-proxy.js', import.meta.url).href, mode, String(origin?.port ?? 0),
    ], true)
    const [port] = await once(child, 'message', { signal: t.signal })
    if (origin) {
      const authority = '127.0.0.1:' + origin.port
      const client = net.connect({ host: '127.0.0.1', port })
      client.on('error', () => {})
      t.after(() => { client.destroy() })
      const method = mode === 'forward' ? 'GET http://' + authority + '/' : 'CONNECT ' + authority
      client.write(method + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n')
      const [peer] = await origin.connected
      if (mode === 'forward') {
        assert.match(await readUntil(peer, '\r\n\r\n', t.signal), /^GET \/ HTTP\/1\.1/)
        const response = readUntil(client, '\r\n\r\nx', t.signal)
        peer.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx')
        assert.match(await response, /^HTTP\/1\.1 200/)
      } else if (mode === 'direct') {
        const response = readUntil(client, 'from-origin', t.signal)
        peer.write('from-origin')
        assert.match(await response, /^HTTP\/1\.1 200 Connection Established/)
        const payload = readUntil(peer, 'from-client', t.signal)
        client.write('from-client')
        await payload
      } else if (mode === 'upstream') {
        assert.match(await readUntil(peer, '\r\n\r\n', t.signal), /^CONNECT /)
      } else if (mode === 'tls') {
        assert.match(await readUntil(peer, '\x16\x03', t.signal), /^\x16\x03/)
      } else {
        assert.equal(await readUntil(peer, '\x05\x01\x00', t.signal), '\x05\x01\x00')
      }
      // Keep both parent-side peers open when IPC is disconnected.
      assert.equal(peer.destroyed, false)
      assert.equal(client.destroyed, false)
    }

    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2500) })
    child.disconnect()
    const [code, signal] = await exited.catch(error => {
      assert.fail('Node did not exit naturally after disconnect: ' + error.message + '\n' + stderr())
    })
    assert.deepEqual([code, signal], [0, null], stderr())
  })
}

test('standalone SOCKS keeps Node alive through its handshake deadline by default', { timeout: 8000 }, async t => {
  const origin = await peerServer(t)
  const { child, stderr } = startChild(t, `
    const { socksConnect } = await import(process.argv[1]);
    process.exitCode = 1;
    socksConnect({ proxyPort: Number(process.argv[2]), targetHost: 'example.invalid', targetPort: 80, timeoutMs: 500 })
      .then(socket => socket.destroy(), error => {
        if (error.phase === 'greeting' && error.message.includes('超时')) process.exitCode = 0;
        else console.error(error);
      });
  `, [new URL('../lib/socks.js', import.meta.url).href, String(origin.port)])
  const exited = once(child, 'exit', { signal: t.signal })
  const [peer] = await origin.connected
  assert.equal(await readUntil(peer, '\x05\x01\x00', t.signal), '\x05\x01\x00')
  assert.deepEqual(await exited, [0, null], stderr())
})

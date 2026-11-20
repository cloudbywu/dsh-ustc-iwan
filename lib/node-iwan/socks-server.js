/** Small loopback-only SOCKS5 CONNECT listener used by the plugin, not a public proxy. */
import net from 'node:net'

const REPLIES = Object.freeze({ ok: 0, failure: 1, unreachable: 4, unsupported: 7, address: 8 })
const localOnly = value => /^127[.]/.test(value) && net.isIPv4(value) || value === '::1'
const response = code => Buffer.from([5,code,0,1,0,0,0,0,0,0])

export async function startNodeSocks({ host, port, connect, signal, timeoutMs = 11_000, onFailure = () => {} }) {
  if (host === 'localhost') host = '127.0.0.1'
  else if (host === '[::1]') host = '::1'
  if (!localOnly(host)) throw new Error('Node.js iWAN SOCKS5 只能监听回环地址')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Node.js iWAN SOCKS5 端口无效')
  signal?.throwIfAborted()
  const sockets = new Set()
  let closing
  const server = net.createServer({ allowHalfOpen:true }, socket => {
    socket.unref()
    socket.on('error', () => {})
    if (sockets.size >= 128 || closing || signal?.aborted) { socket.destroy(); return }
    sockets.add(socket)
    const controller = new AbortController()
    let timer = setTimeout(() => socket.destroy(), timeoutMs).unref()
    let buffer = Buffer.alloc(0), greeting = true, accepted = false, remote
    const finish = () => {
      sockets.delete(socket)
      clearTimeout(timer)
      controller.abort()
      remote?.destroy()
    }
    const fail = code => {
      socket.removeListener('data', input)
      socket.end(response(code), () => socket.destroy())
    }
    socket.once('close', finish)
    // After CONNECT, FIN ends only the upstream write side, even while connecting.
    socket.once('end', () => { if (!accepted) socket.destroy() })
    socket.on('data', input)
    function input(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (greeting) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5 || buffer[1] === 0) { socket.destroy(); return }
        const count = buffer[1] + 2
        if (buffer.length < count) return
        if (!buffer.subarray(2, count).includes(0)) { socket.end(Buffer.from([5,255])); return }
        socket.write(Buffer.from([5,0]))
        buffer = buffer.subarray(count)
        greeting = false
      }
      if (buffer.length < 4) return
      if (buffer[0] !== 5 || buffer[2] !== 0) return fail(REPLIES.failure)
      if (buffer[1] !== 1) return fail(REPLIES.unsupported)
      let target, end
      if (buffer[3] === 1) {
        end = 8
        if (buffer.length < end + 2) return
        target = [...buffer.subarray(4, end)].join('.')
      } else if (buffer[3] === 3) {
        if (buffer.length < 5) return
        end = 5 + buffer[4]
        if (end === 5) return fail(REPLIES.address)
        if (buffer.length < end + 2) return
        const name = buffer.subarray(5, end)
        if (name.some(byte => byte > 127) || !/^[a-z0-9_.-]+$/i.test(name.toString('ascii'))) return fail(REPLIES.address)
        target = name.toString('ascii')
      } else return fail(REPLIES.address)
      const targetPort = buffer.readUInt16BE(end)
      if (!targetPort) return fail(REPLIES.address)
      const tail = buffer.subarray(end + 2)
      buffer = Buffer.alloc(0)
      socket.pause()
      socket.removeListener('data', input)
      if (tail.length > 64 * 1024) return fail(REPLIES.failure)
      accepted = true
      if (tail.length) socket.unshift(tail)
      Promise.resolve().then(() => connect(target, targetPort, controller.signal)).then(stream => {
        if (socket.destroyed || controller.signal.aborted) { stream.destroy(); return }
        remote = stream
        remote.once('error', () => socket.destroy())
        remote.once('close', () => { if (!socket.writableEnded) socket.end() })
        clearTimeout(timer); timer = null
        socket.write(response(REPLIES.ok))
        socket.pipe(remote).pipe(socket)
      }, () => { if (!socket.destroyed) fail(REPLIES.unreachable) })
    }
  })
  const stop = () => closing ??= new Promise(resolve => {
    signal?.removeEventListener('abort', abort)
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  })
  const abort = () => { void stop() }
  function listen(addressPort) {
    return new Promise((resolve, reject) => {
      const done = error => {
        server.removeListener('error', errorHandler)
        server.removeListener('listening', listening)
        if (error) reject(error)
        else resolve()
      }
      const errorHandler = error => done(error)
      const listening = () => done()
      server.once('error', errorHandler)
      server.once('listening', listening)
      try { server.listen({host,port:addressPort,exclusive:true}) } catch (error) { done(error) }
    })
  }
  try {
    try { await listen(port) } catch (error) {
      if (!port || !['EADDRINUSE','EACCES'].includes(error?.code)) throw error
      signal?.throwIfAborted()
      await listen(0)
    }
    signal?.throwIfAborted()
  } catch (error) { await stop(); throw error }
  server.on('error', error => onFailure(error))
  signal?.addEventListener('abort', abort, { once: true })
  server.unref()
  return { host, port: server.address().port, stop }
}
